/**
 * Camera folders for the sidebar Camera List.
 *
 * GET /api/camera-folders  -> {"folders":[{"id","name","cameras":[...]}, ...]}
 * PUT /api/camera-folders  <- the same document, replacing the stored one
 *
 * Stored as JSON in the system_settings table. A camera belongs to at most one
 * folder; cameras that no longer exist are dropped. A folder can only be
 * removed while it has no cameras.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <cjson/cJSON.h>

#include "web/api_handlers_camera_folders.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#include "core/logger.h"
#include "core/config.h"
#include "database/db_auth.h"
#include "database/db_streams.h"
#include "database/db_system_settings.h"
#include "video/stream_manager.h"

#define CAMERA_FOLDERS_SETTING_KEY "camera_folders"
#define CAMERA_FOLDERS_MAX_BYTES 65536
#define CAMERA_FOLDERS_MAX_COUNT 200
#define CAMERA_FOLDER_ID_MAX_LEN 64
#define CAMERA_FOLDER_NAME_MAX_LEN 96

// Names of all configured cameras, or NULL on failure
static cJSON *load_camera_names(void) {
    stream_config_t *streams = calloc(g_config.max_streams, sizeof(stream_config_t));
    if (!streams) {
        return NULL;
    }
    int count = get_all_stream_configs(streams, g_config.max_streams);
    cJSON *names = cJSON_CreateArray();
    for (int i = 0; names && i < count; i++) {
        cJSON_AddItemToArray(names, cJSON_CreateString(streams[i].name));
    }
    free(streams);
    return count < 0 ? (cJSON_Delete(names), NULL) : names;
}

static bool json_array_has_string(const cJSON *array, const char *value) {
    const cJSON *item;
    cJSON_ArrayForEach(item, array) {
        if (cJSON_IsString(item) && strcmp(item->valuestring, value) == 0) {
            return true;
        }
    }
    return false;
}

// http_response_set_json_error() does not JSON-escape its message, so error
// texts must not contain '"' or '\\'; folder names are quoted with '.
static bool is_valid_folder_id(const char *id) {
    size_t len = strlen(id);
    if (len == 0 || len > CAMERA_FOLDER_ID_MAX_LEN) {
        return false;
    }
    for (const char *p = id; *p; p++) {
        if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_') {
            return false;
        }
    }
    return true;
}

/**
 * Validate a folders document and return a clean copy: trimmed names, only
 * existing cameras, each camera in at most one folder. Returns NULL and fills
 * `error` if the document is malformed.
 */
static cJSON *normalize_camera_folders(const cJSON *doc, const cJSON *camera_names,
                                       char *error, size_t error_size) {
    const cJSON *folders = cJSON_GetObjectItem(doc, "folders");
    if (!cJSON_IsArray(folders)) {
        snprintf(error, error_size, "folders must be an array");
        return NULL;
    }
    if (cJSON_GetArraySize(folders) > CAMERA_FOLDERS_MAX_COUNT) {
        snprintf(error, error_size, "Too many folders (max %d)", CAMERA_FOLDERS_MAX_COUNT);
        return NULL;
    }

    cJSON *out = cJSON_CreateObject();
    cJSON *out_folders = cJSON_AddArrayToObject(out, "folders");
    cJSON *assigned = cJSON_CreateArray();  // cameras already placed in a folder

    const cJSON *folder;
    cJSON_ArrayForEach(folder, folders) {
        const cJSON *id = cJSON_GetObjectItem(folder, "id");
        const cJSON *name = cJSON_GetObjectItem(folder, "name");
        if (!cJSON_IsString(id) || !is_valid_folder_id(id->valuestring)) {
            snprintf(error, error_size, "Each folder needs an id of letters, digits, '-' or '_'");
            goto fail;
        }
        if (!cJSON_IsString(name)) {
            snprintf(error, error_size, "Each folder needs a name");
            goto fail;
        }

        char trimmed[CAMERA_FOLDER_NAME_MAX_LEN + 1];
        const char *start = name->valuestring;
        while (isspace((unsigned char)*start)) start++;
        snprintf(trimmed, sizeof(trimmed), "%s", start);
        size_t len = strlen(trimmed);
        while (len > 0 && isspace((unsigned char)trimmed[len - 1])) trimmed[--len] = '\0';
        if (len == 0) {
            snprintf(error, error_size, "Folder name cannot be empty");
            goto fail;
        }
        if (strpbrk(trimmed, "\"\\")) {
            snprintf(error, error_size, "Folder names cannot contain double quotes or backslashes");
            goto fail;
        }

        const cJSON *existing;
        cJSON_ArrayForEach(existing, out_folders) {
            const char *existing_id = cJSON_GetObjectItem(existing, "id")->valuestring;
            const char *existing_name = cJSON_GetObjectItem(existing, "name")->valuestring;
            if (strcmp(existing_id, id->valuestring) == 0) {
                snprintf(error, error_size, "Duplicate folder id");
                goto fail;
            }
            if (strcasecmp(existing_name, trimmed) == 0) {
                snprintf(error, error_size, "A folder named '%s' already exists", trimmed);
                goto fail;
            }
        }

        cJSON *out_folder = cJSON_CreateObject();
        cJSON_AddStringToObject(out_folder, "id", id->valuestring);
        cJSON_AddStringToObject(out_folder, "name", trimmed);
        cJSON *out_cameras = cJSON_AddArrayToObject(out_folder, "cameras");

        const cJSON *camera;
        cJSON_ArrayForEach(camera, cJSON_GetObjectItem(folder, "cameras")) {
            if (!cJSON_IsString(camera) ||
                !json_array_has_string(camera_names, camera->valuestring) ||
                json_array_has_string(assigned, camera->valuestring)) {
                continue;  // deleted camera, or already in an earlier folder
            }
            cJSON_AddItemToArray(out_cameras, cJSON_CreateString(camera->valuestring));
            cJSON_AddItemToArray(assigned, cJSON_CreateString(camera->valuestring));
        }
        cJSON_AddItemToArray(out_folders, out_folder);
    }

    cJSON_Delete(assigned);
    return out;

fail:
    cJSON_Delete(assigned);
    cJSON_Delete(out);
    return NULL;
}

// Stored folders, normalized against the current cameras (never NULL on success)
static cJSON *load_stored_folders(const cJSON *camera_names) {
    char stored_json[CAMERA_FOLDERS_MAX_BYTES] = {0};
    cJSON *normalized = NULL;
    if (db_get_system_setting(CAMERA_FOLDERS_SETTING_KEY, stored_json, sizeof(stored_json)) == 0 &&
        stored_json[0] != '\0') {
        cJSON *parsed = cJSON_Parse(stored_json);
        if (parsed) {
            char error[128];
            normalized = normalize_camera_folders(parsed, camera_names, error, sizeof(error));
            if (!normalized) {
                log_warn("Stored camera folders are invalid (%s); treating as empty", error);
            }
            cJSON_Delete(parsed);
        }
    }
    if (!normalized) {
        normalized = cJSON_CreateObject();
        cJSON_AddArrayToObject(normalized, "folders");
    }
    return normalized;
}

static void respond_with_json(http_response_t *res, cJSON *doc) {
    char *json = cJSON_PrintUnformatted(doc);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize camera folders");
        return;
    }
    http_response_set_json(res, 200, json);
    free(json);
}

void handle_get_camera_folders(const http_request_t *req, http_response_t *res) {
    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }

    cJSON *camera_names = load_camera_names();
    if (!camera_names) {
        http_response_set_json_error(res, 500, "Failed to load cameras");
        return;
    }
    cJSON *folders = load_stored_folders(camera_names);
    cJSON_Delete(camera_names);
    respond_with_json(res, folders);
    cJSON_Delete(folders);
}

void handle_put_camera_folders(const http_request_t *req, http_response_t *res) {
    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }
    if (user.role != USER_ROLE_ADMIN && user.role != USER_ROLE_USER) {
        http_response_set_json_error(res, 403, "You do not have permission to change camera folders");
        return;
    }

    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON body");
        return;
    }
    cJSON *camera_names = load_camera_names();
    if (!camera_names) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 500, "Failed to load cameras");
        return;
    }

    char error[160] = {0};
    cJSON *next = normalize_camera_folders(body, camera_names, error, sizeof(error));
    cJSON_Delete(body);
    if (!next) {
        cJSON_Delete(camera_names);
        http_response_set_json_error(res, 400, error);
        return;
    }

    // A folder may only disappear while it is empty
    cJSON *stored = load_stored_folders(camera_names);
    cJSON_Delete(camera_names);
    const cJSON *old_folder;
    cJSON_ArrayForEach(old_folder, cJSON_GetObjectItem(stored, "folders")) {
        const char *old_id = cJSON_GetObjectItem(old_folder, "id")->valuestring;
        bool still_there = false;
        const cJSON *new_folder;
        cJSON_ArrayForEach(new_folder, cJSON_GetObjectItem(next, "folders")) {
            if (strcmp(cJSON_GetObjectItem(new_folder, "id")->valuestring, old_id) == 0) {
                still_there = true;
                break;
            }
        }
        if (!still_there && cJSON_GetArraySize(cJSON_GetObjectItem(old_folder, "cameras")) > 0) {
            snprintf(error, sizeof(error),
                     "Folder '%s' still has cameras. Remove its cameras before deleting it.",
                     cJSON_GetObjectItem(old_folder, "name")->valuestring);
            cJSON_Delete(stored);
            cJSON_Delete(next);
            http_response_set_json_error(res, 409, error);
            return;
        }
    }
    cJSON_Delete(stored);

    char *json = cJSON_PrintUnformatted(next);
    if (!json || strlen(json) >= CAMERA_FOLDERS_MAX_BYTES) {
        free(json);
        cJSON_Delete(next);
        http_response_set_json_error(res, 400, "Camera folders are too large");
        return;
    }
    if (db_set_system_setting(CAMERA_FOLDERS_SETTING_KEY, json) != 0) {
        free(json);
        cJSON_Delete(next);
        http_response_set_json_error(res, 500, "Failed to save camera folders");
        return;
    }
    free(json);

    log_info("Camera folders updated by %s", user.username);
    respond_with_json(res, next);
    cJSON_Delete(next);
}
