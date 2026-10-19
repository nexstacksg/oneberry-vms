/**
 * Per-camera display settings for Live View.
 *
 * GET /api/camera-display          -> {"cameras":{"<name>":{"aspectRatio":"16:9"}, ...}}
 * PUT /api/camera-display/<name>   <- {"aspectRatio":"auto"|"4:3"|"16:9"|"1:1"|"3:4"|"9:16"}
 *
 * "aspectRatio" forces the shape the camera's picture is shown with, for
 * cameras that report the wrong one. "auto" (the default) uses the shape of
 * the video itself. Stored as JSON in the system_settings table; cameras that
 * no longer exist are dropped.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cjson/cJSON.h>

#include "web/api_handlers_camera_display.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#include "core/logger.h"
#include "core/config.h"
#include "database/db_auth.h"
#include "database/db_streams.h"
#include "database/db_system_settings.h"
#include "video/stream_manager.h"

#define CAMERA_DISPLAY_SETTING_KEY "camera_display"
#define CAMERA_DISPLAY_MAX_BYTES 65536

static const char *const ALLOWED_ASPECT_RATIOS[] = { "4:3", "16:9", "1:1", "3:4", "9:16" };

static bool is_allowed_aspect_ratio(const char *value) {
    for (size_t i = 0; i < sizeof(ALLOWED_ASPECT_RATIOS) / sizeof(ALLOWED_ASPECT_RATIOS[0]); i++) {
        if (strcmp(value, ALLOWED_ASPECT_RATIOS[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool camera_exists(const char *name) {
    stream_config_t config;
    return name && name[0] && get_stream_config_by_name(name, &config) == 0;
}

// Stored settings with only existing cameras and valid values
static cJSON *load_camera_display(void) {
    char stored_json[CAMERA_DISPLAY_MAX_BYTES] = {0};
    cJSON *clean = cJSON_CreateObject();
    cJSON *clean_cameras = cJSON_AddObjectToObject(clean, "cameras");
    if (db_get_system_setting(CAMERA_DISPLAY_SETTING_KEY, stored_json, sizeof(stored_json)) != 0 ||
        stored_json[0] == '\0') {
        return clean;
    }

    cJSON *parsed = cJSON_Parse(stored_json);
    const cJSON *camera;
    cJSON_ArrayForEach(camera, cJSON_GetObjectItem(parsed, "cameras")) {
        const cJSON *ratio = cJSON_GetObjectItem(camera, "aspectRatio");
        if (!camera->string || !cJSON_IsString(ratio) || !is_allowed_aspect_ratio(ratio->valuestring) ||
            !camera_exists(camera->string)) {
            continue;
        }
        cJSON *entry = cJSON_AddObjectToObject(clean_cameras, camera->string);
        cJSON_AddStringToObject(entry, "aspectRatio", ratio->valuestring);
    }
    cJSON_Delete(parsed);
    return clean;
}

static int save_camera_display(const cJSON *doc) {
    char *json = cJSON_PrintUnformatted(doc);
    if (!json || strlen(json) >= CAMERA_DISPLAY_MAX_BYTES) {
        free(json);
        return -1;
    }
    int rc = db_set_system_setting(CAMERA_DISPLAY_SETTING_KEY, json);
    free(json);
    return rc;
}

static void respond_with_json(http_response_t *res, const cJSON *doc) {
    char *json = cJSON_PrintUnformatted(doc);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize camera display settings");
        return;
    }
    http_response_set_json(res, 200, json);
    free(json);
}

void handle_get_camera_display(const http_request_t *req, http_response_t *res) {
    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }
    cJSON *doc = load_camera_display();
    respond_with_json(res, doc);
    cJSON_Delete(doc);
}

void handle_put_camera_display(const http_request_t *req, http_response_t *res) {
    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }
    if (user.role != USER_ROLE_ADMIN && user.role != USER_ROLE_USER) {
        http_response_set_json_error(res, 403, "You do not have permission to change camera display settings");
        return;
    }

    char camera_name[MAX_STREAM_NAME] = {0};
    if (http_request_extract_path_param(req, "/api/camera-display/", camera_name, sizeof(camera_name)) != 0 ||
        !camera_exists(camera_name)) {
        http_response_set_json_error(res, 404, "Camera not found");
        return;
    }

    cJSON *body = httpd_parse_json_body(req);
    const cJSON *ratio = body ? cJSON_GetObjectItem(body, "aspectRatio") : NULL;
    if (!cJSON_IsString(ratio) ||
        (strcmp(ratio->valuestring, "auto") != 0 && !is_allowed_aspect_ratio(ratio->valuestring))) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 400, "aspectRatio must be auto, 4:3, 16:9, 1:1, 3:4 or 9:16");
        return;
    }

    cJSON *doc = load_camera_display();
    cJSON *cameras = cJSON_GetObjectItem(doc, "cameras");
    cJSON_DeleteItemFromObjectCaseSensitive(cameras, camera_name);
    if (strcmp(ratio->valuestring, "auto") != 0) {
        cJSON *entry = cJSON_AddObjectToObject(cameras, camera_name);
        cJSON_AddStringToObject(entry, "aspectRatio", ratio->valuestring);
    }
    cJSON_Delete(body);

    if (save_camera_display(doc) != 0) {
        cJSON_Delete(doc);
        http_response_set_json_error(res, 500, "Failed to save camera display settings");
        return;
    }
    log_info("Camera display settings for %s updated by %s", camera_name, user.username);
    respond_with_json(res, doc);
    cJSON_Delete(doc);
}

void camera_display_rename_camera(const char *old_name, const char *new_name) {
    if (!old_name || !new_name) {
        return;
    }
    char stored_json[CAMERA_DISPLAY_MAX_BYTES] = {0};
    if (db_get_system_setting(CAMERA_DISPLAY_SETTING_KEY, stored_json, sizeof(stored_json)) != 0 ||
        stored_json[0] == '\0') {
        return;
    }
    cJSON *doc = cJSON_Parse(stored_json);
    cJSON *cameras = cJSON_GetObjectItem(doc, "cameras");
    cJSON *entry = cameras ? cJSON_DetachItemFromObjectCaseSensitive(cameras, old_name) : NULL;
    if (entry) {
        cJSON_DeleteItemFromObjectCaseSensitive(cameras, new_name);
        cJSON_AddItemToObject(cameras, new_name, entry);
        if (save_camera_display(doc) != 0) {
            log_warn("Failed to move display settings of %s to %s", old_name, new_name);
        }
    }
    cJSON_Delete(doc);
}
