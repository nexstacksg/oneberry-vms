#define _XOPEN_SOURCE
#define _GNU_SOURCE

#include <stdio.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <unistd.h>
#include <sys/stat.h>
#include <time.h>
#include <syslog.h>
#include <pthread.h>
#include <cjson/cJSON.h>

#include "web/api_handlers.h"
#include "web/api_handlers_common.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#define LOG_COMPONENT "SettingsAPI"
#include "core/logger.h"
#include "core/config.h"
#include "database/db_core.h"
#include "database/db_streams.h"
#include "database/db_system_settings.h"
#include "storage/storage_manager.h"
#include "database/db_auth.h"
#include "video/stream_manager.h"
#include "video/streams.h"
#include "video/mp4_recording.h"
#include "video/go2rtc/go2rtc_process.h"
#include "video/go2rtc/go2rtc_stream.h"
#include "video/go2rtc/go2rtc_integration.h"
#include "video/hls/hls_api.h"
#include "core/mqtt_client.h"

/**
 * @brief Validate that a path is safe to use as a storage path.
 *
 * A safe storage path must:
 *   - Be non-NULL and non-empty
 *   - Start with '/' (absolute path)
 *   - Contain no shell metacharacters that could enable OS command injection
 *     when the path is later used in disk-usage calculations.
 *
 * @param path  The candidate path string
 * @return true if the path is acceptable, false otherwise
 */
static bool is_safe_storage_path(const char *path) {
    if (!path || path[0] != '/') {
        return false;
    }
    /* Characters that carry special meaning to a POSIX shell */
    static const char dangerous[] = ";|&`$><\n\r\\\"'!{}()[]~*?";
    for (const char *c = path; *c != '\0'; c++) {
        if (strchr(dangerous, *c)) {
            return false;
        }
    }
    return true;
}

#define LOCATION_CATALOG_SETTING_KEY "location_catalog"
#define LOCATION_CATALOG_MAX_BYTES 65536
#define LOCATION_NAME_MAX_LEN 96
#define LIVE_LAYOUTS_SETTING_KEY "live_view_layouts"
#define LIVE_LAYOUTS_MAX_BYTES 131072
#define LIVE_LAYOUT_NAME_MAX_LEN 96
#define LIVE_LAYOUT_ID_MAX_LEN 96
#define LIVE_LAYOUT_CAMERA_MAX_LEN 255
#define LIVE_LAYOUT_TILE_MAX_LEN 96
#define LIVE_LAYOUT_GRID_MAX_SIDE 64
#define LIVE_LAYOUT_UNOWNED_USER_ID INT64_MIN

static void trim_location_value(const char *src, char *dst, size_t dst_size) {
    if (!dst || dst_size == 0) return;
    dst[0] = '\0';
    if (!src) return;

    while (*src && isspace((unsigned char)*src)) src++;
    size_t len = strlen(src);
    while (len > 0 && isspace((unsigned char)src[len - 1])) len--;
    if (len >= dst_size) len = dst_size - 1;
    memcpy(dst, src, len);
    dst[len] = '\0';
}

static bool is_valid_location_value(const char *value) {
    if (!value || value[0] == '\0') return false;
    if (strlen(value) > LOCATION_NAME_MAX_LEN) return false;
    return strchr(value, ',') == NULL && strchr(value, '/') == NULL;
}

static bool string_array_contains(cJSON *array, const char *value) {
    if (!array || !value) return false;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, array) {
        if (cJSON_IsString(item) && item->valuestring && strcmp(item->valuestring, value) == 0) {
            return true;
        }
    }
    return false;
}

static cJSON *find_location_building(cJSON *buildings, const char *name) {
    if (!buildings || !name) return NULL;
    cJSON *building = NULL;
    cJSON_ArrayForEach(building, buildings) {
        cJSON *existing_name = cJSON_GetObjectItem(building, "name");
        if (cJSON_IsString(existing_name) && existing_name->valuestring &&
            strcmp(existing_name->valuestring, name) == 0) {
            return building;
        }
    }
    return NULL;
}

static cJSON *normalize_location_catalog_json(cJSON *input, char *error, size_t error_size) {
    if (!input || !cJSON_IsObject(input)) {
        snprintf(error, error_size, "Location catalog must be a JSON object");
        return NULL;
    }

    cJSON *input_buildings = cJSON_GetObjectItem(input, "buildings");
    if (input_buildings && !cJSON_IsArray(input_buildings)) {
        snprintf(error, error_size, "buildings must be an array");
        return NULL;
    }

    cJSON *normalized = cJSON_CreateObject();
    cJSON *buildings = cJSON_CreateArray();
    if (!normalized || !buildings) {
        cJSON_Delete(normalized);
        cJSON_Delete(buildings);
        snprintf(error, error_size, "Out of memory");
        return NULL;
    }
    cJSON_AddItemToObject(normalized, "buildings", buildings);

    if (!input_buildings) {
        return normalized;
    }

    cJSON *input_building = NULL;
    cJSON_ArrayForEach(input_building, input_buildings) {
        if (!cJSON_IsObject(input_building)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Each building must be an object");
            return NULL;
        }

        cJSON *name_json = cJSON_GetObjectItem(input_building, "name");
        if (!cJSON_IsString(name_json) || !name_json->valuestring) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Each building requires a name");
            return NULL;
        }

        char building_name[LOCATION_NAME_MAX_LEN + 1];
        trim_location_value(name_json->valuestring, building_name, sizeof(building_name));
        if (!is_valid_location_value(building_name)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Building names must be 1-%d characters and cannot contain commas or slashes", LOCATION_NAME_MAX_LEN);
            return NULL;
        }

        cJSON *building = find_location_building(buildings, building_name);
        cJSON *areas = NULL;
        if (!building) {
            building = cJSON_CreateObject();
            areas = cJSON_CreateArray();
            if (!building || !areas) {
                cJSON_Delete(building);
                cJSON_Delete(areas);
                cJSON_Delete(normalized);
                snprintf(error, error_size, "Out of memory");
                return NULL;
            }
            cJSON_AddStringToObject(building, "name", building_name);
            cJSON_AddItemToObject(building, "areas", areas);
            cJSON_AddItemToArray(buildings, building);
        } else {
            areas = cJSON_GetObjectItem(building, "areas");
        }

        cJSON *input_areas = cJSON_GetObjectItem(input_building, "areas");
        if (input_areas && !cJSON_IsArray(input_areas)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "areas must be an array");
            return NULL;
        }

        if (!input_areas) continue;

        cJSON *area_json = NULL;
        cJSON_ArrayForEach(area_json, input_areas) {
            if (!cJSON_IsString(area_json) || !area_json->valuestring) {
                cJSON_Delete(normalized);
                snprintf(error, error_size, "Area names must be strings");
                return NULL;
            }

            char area_name[LOCATION_NAME_MAX_LEN + 1];
            trim_location_value(area_json->valuestring, area_name, sizeof(area_name));
            if (!is_valid_location_value(area_name)) {
                cJSON_Delete(normalized);
                snprintf(error, error_size, "Area names must be 1-%d characters and cannot contain commas or slashes", LOCATION_NAME_MAX_LEN);
                return NULL;
            }

            if (!string_array_contains(areas, area_name)) {
                cJSON *area_item = cJSON_CreateString(area_name);
                if (!area_item) {
                    cJSON_Delete(normalized);
                    snprintf(error, error_size, "Out of memory");
                    return NULL;
                }
                cJSON_AddItemToArray(areas, area_item);
            }
        }
    }

    return normalized;
}

static bool is_valid_layout_id(const char *value) {
    if (!value || value[0] == '\0' || strlen(value) > LIVE_LAYOUT_ID_MAX_LEN) return false;
    for (const char *c = value; *c != '\0'; c++) {
        if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_') return false;
    }
    return true;
}

static bool is_valid_layout_name(const char *value) {
    if (!value || value[0] == '\0') return false;
    if (strlen(value) > LIVE_LAYOUT_NAME_MAX_LEN) return false;
    return true;
}

static bool is_valid_layout_camera_name(const char *value) {
    if (!value || value[0] == '\0') return false;
    return strlen(value) <= LIVE_LAYOUT_CAMERA_MAX_LEN;
}

static int clamp_layout_int(cJSON *item, int fallback, int min_value, int max_value) {
    if (!cJSON_IsNumber(item)) return fallback;
    int value = item->valueint;
    if (value < min_value) return min_value;
    if (value > max_value) return max_value;
    return value;
}

static bool is_valid_layout_tile_id(const char *value) {
    if (!value || value[0] == '\0' || strlen(value) > LIVE_LAYOUT_TILE_MAX_LEN) return false;
    for (const char *c = value; *c != '\0'; c++) {
        if (!isalnum((unsigned char)*c) && *c != '-' && *c != '_') return false;
    }
    return true;
}

static int64_t get_live_layout_user_id(cJSON *layout) {
    cJSON *user_id_json = cJSON_GetObjectItem(layout, "userId");
    if (!user_id_json) user_id_json = cJSON_GetObjectItem(layout, "ownerUserId");
    if (!user_id_json) user_id_json = cJSON_GetObjectItem(layout, "owner_user_id");

    if (cJSON_IsNumber(user_id_json)) {
        return (int64_t)user_id_json->valuedouble;
    }
    if (cJSON_IsString(user_id_json) && user_id_json->valuestring && user_id_json->valuestring[0] != '\0') {
        char *end = NULL;
        long long parsed = strtoll(user_id_json->valuestring, &end, 10);
        if (end && *end == '\0') {
            return (int64_t)parsed;
        }
    }
    return LIVE_LAYOUT_UNOWNED_USER_ID;
}

static cJSON *build_allowed_live_layout_cameras(const user_t *user) {
    cJSON *allowed = cJSON_CreateObject();
    if (!allowed) return NULL;

    stream_config_t *all_streams = calloc(g_config.max_streams, sizeof(stream_config_t));
    if (!all_streams) {
        cJSON_Delete(allowed);
        return NULL;
    }

    int stream_count = get_all_stream_configs(all_streams, g_config.max_streams);
    if (stream_count < 0) {
        free(all_streams);
        cJSON_Delete(allowed);
        return NULL;
    }

    for (int i = 0; i < stream_count; i++) {
        if (all_streams[i].name[0] == '\0') continue;
        if (!db_auth_stream_allowed_for_user(user, all_streams[i].tags)) continue;
        cJSON_AddBoolToObject(allowed, all_streams[i].name, true);
    }

    free(all_streams);
    return allowed;
}

static bool live_layout_camera_allowed(cJSON *allowed_cameras, const char *camera_name) {
    if (!allowed_cameras) return true;
    if (!camera_name) return false;
    return cJSON_HasObjectItem(allowed_cameras, camera_name);
}

static int64_t get_legacy_live_layout_owner_user_id(const user_t *current_user) {
    if (current_user && current_user->role == USER_ROLE_ADMIN) {
        return current_user->id;
    }

    sqlite3 *db = get_db_handle();
    pthread_mutex_t *db_mutex = get_db_mutex();
    if (!db || !db_mutex) {
        return current_user ? current_user->id : 0;
    }

    pthread_mutex_lock(db_mutex);
    sqlite3_stmt *stmt = NULL;
    int64_t admin_user_id = LIVE_LAYOUT_UNOWNED_USER_ID;
    int rc = sqlite3_prepare_v2(db,
        "SELECT id FROM users WHERE role = 0 AND is_active = 1 ORDER BY id LIMIT 1;",
        -1, &stmt, NULL);
    if (rc == SQLITE_OK && sqlite3_step(stmt) == SQLITE_ROW) {
        admin_user_id = sqlite3_column_int64(stmt, 0);
    }
    if (stmt) sqlite3_finalize(stmt);
    pthread_mutex_unlock(db_mutex);

    if (admin_user_id != LIVE_LAYOUT_UNOWNED_USER_ID) {
        return admin_user_id;
    }
    return current_user ? current_user->id : 0;
}

#define LIVE_LAYOUT_SHARE_MAX 64

static void live_layout_background_path(const char *layout_id, char *path, size_t size);

// Users a layout is shared with (Nx Witness style: they see it read-only)
static bool live_layout_shared_with(const cJSON *layout, int64_t user_id) {
    const cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(layout, "sharedWith")) {
        if (cJSON_IsNumber(item) && (int64_t)item->valuedouble == user_id) {
            return true;
        }
    }
    return false;
}

// Copy sharing, lock and background settings of a layout into its normalized form
static void add_live_layout_extras(cJSON *layout, const cJSON *input_layout, int64_t owner_user_id) {
    if (cJSON_IsTrue(cJSON_GetObjectItem(input_layout, "locked"))) {
        cJSON_AddBoolToObject(layout, "locked", true);
    }

    // Shared with: valid user ids, not the owner, each once
    cJSON *shared = cJSON_CreateArray();
    const cJSON *item;
    cJSON_ArrayForEach(item, cJSON_GetObjectItem(input_layout, "sharedWith")) {
        if (!cJSON_IsNumber(item) || cJSON_GetArraySize(shared) >= LIVE_LAYOUT_SHARE_MAX) continue;
        int64_t id = (int64_t)item->valuedouble;
        bool duplicate = false;
        const cJSON *existing;
        cJSON_ArrayForEach(existing, shared) {
            if ((int64_t)existing->valuedouble == id) duplicate = true;
        }
        if (id <= 0 || id == owner_user_id || duplicate) continue;
        cJSON_AddItemToArray(shared, cJSON_CreateNumber((double)id));
    }
    if (cJSON_GetArraySize(shared) > 0) {
        cJSON_AddItemToObject(layout, "sharedWith", shared);
    } else {
        cJSON_Delete(shared);
    }

    // Background image (map/plan) behind the cameras; the picture itself is a file
    const cJSON *background = cJSON_GetObjectItem(input_layout, "background");
    const cJSON *version = cJSON_GetObjectItem(background, "version");
    if (cJSON_IsNumber(version) && version->valuedouble > 0) {
        const cJSON *opacity = cJSON_GetObjectItem(background, "opacity");
        double value = cJSON_IsNumber(opacity) ? opacity->valuedouble : 0.6;
        if (value < 0.1) value = 0.1;
        if (value > 1.0) value = 1.0;
        cJSON *bg = cJSON_AddObjectToObject(layout, "background");
        cJSON_AddNumberToObject(bg, "version", (double)(int64_t)version->valuedouble);
        cJSON_AddNumberToObject(bg, "opacity", value);
    }
}

static bool add_normalized_layout_tile(cJSON *tiles, cJSON *cameras, cJSON *allowed_cameras,
                                       const char *tile_id,
                                       const char *camera_name, int x, int y, int w, int h,
                                       char *error, size_t error_size) {
    if (!is_valid_layout_tile_id(tile_id)) {
        snprintf(error, error_size, "Layout tile ids may only contain letters, numbers, dashes, and underscores");
        return false;
    }
    if (!is_valid_layout_camera_name(camera_name)) {
        snprintf(error, error_size, "Camera names must be 1-%d characters", LIVE_LAYOUT_CAMERA_MAX_LEN);
        return false;
    }
    if (!live_layout_camera_allowed(allowed_cameras, camera_name)) {
        return true;
    }

    cJSON *tile = cJSON_CreateObject();
    if (!tile) {
        snprintf(error, error_size, "Out of memory");
        return false;
    }

    cJSON_AddStringToObject(tile, "id", tile_id);
    cJSON_AddStringToObject(tile, "camera", camera_name);
    cJSON_AddNumberToObject(tile, "x", x);
    cJSON_AddNumberToObject(tile, "y", y);
    cJSON_AddNumberToObject(tile, "w", w);
    cJSON_AddNumberToObject(tile, "h", h);

    cJSON *camera_item = cJSON_CreateString(camera_name);
    if (!camera_item) {
        cJSON_Delete(tile);
        snprintf(error, error_size, "Out of memory");
        return false;
    }

    cJSON_AddItemToArray(tiles, tile);
    cJSON_AddItemToArray(cameras, camera_item);
    return true;
}

static cJSON *normalize_live_layouts_json(cJSON *input, const user_t *user, bool only_current_user,
                                          bool reject_foreign_layouts, cJSON *allowed_cameras,
                                          char *error, size_t error_size) {
    if (!input || !cJSON_IsObject(input)) {
        snprintf(error, error_size, "Live layouts must be a JSON object");
        return NULL;
    }
    if (!user) {
        snprintf(error, error_size, "Authenticated user is required");
        return NULL;
    }

    cJSON *input_layouts = cJSON_GetObjectItem(input, "layouts");
    if (input_layouts && !cJSON_IsArray(input_layouts)) {
        snprintf(error, error_size, "layouts must be an array");
        return NULL;
    }

    cJSON *normalized = cJSON_CreateObject();
    cJSON *layouts = cJSON_CreateArray();
    if (!normalized || !layouts) {
        cJSON_Delete(normalized);
        cJSON_Delete(layouts);
        snprintf(error, error_size, "Out of memory");
        return NULL;
    }
    cJSON_AddItemToObject(normalized, "layouts", layouts);

    if (!input_layouts) {
        return normalized;
    }

    int64_t legacy_owner_user_id = get_legacy_live_layout_owner_user_id(user);

    cJSON *input_layout = NULL;
    cJSON_ArrayForEach(input_layout, input_layouts) {
        if (!cJSON_IsObject(input_layout)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Each layout must be an object");
            return NULL;
        }

        cJSON *id_json = cJSON_GetObjectItem(input_layout, "id");
        cJSON *name_json = cJSON_GetObjectItem(input_layout, "name");
        if (!cJSON_IsString(id_json) || !id_json->valuestring ||
            !cJSON_IsString(name_json) || !name_json->valuestring) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Each layout requires id and name");
            return NULL;
        }

        char layout_id[LIVE_LAYOUT_ID_MAX_LEN + 1];
        char layout_name[LIVE_LAYOUT_NAME_MAX_LEN + 1];
        trim_location_value(id_json->valuestring, layout_id, sizeof(layout_id));
        trim_location_value(name_json->valuestring, layout_name, sizeof(layout_name));
        if (!is_valid_layout_id(layout_id)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Layout ids may only contain letters, numbers, dashes, and underscores");
            return NULL;
        }
        if (!is_valid_layout_name(layout_name)) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Layout names must be 1-%d characters", LIVE_LAYOUT_NAME_MAX_LEN);
            return NULL;
        }

        int64_t owner_user_id = get_live_layout_user_id(input_layout);
        if (owner_user_id == LIVE_LAYOUT_UNOWNED_USER_ID) {
            owner_user_id = reject_foreign_layouts ? user->id : legacy_owner_user_id;
        }
        if (reject_foreign_layouts && owner_user_id != user->id) {
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Forbidden: layout belongs to another user");
            return NULL;
        }
        bool shared_with_me = owner_user_id != user->id && live_layout_shared_with(input_layout, user->id);
        if (only_current_user && owner_user_id != user->id && !shared_with_me) {
            continue;
        }

        int cols = clamp_layout_int(cJSON_GetObjectItem(input_layout, "cols"), 0, 0, LIVE_LAYOUT_GRID_MAX_SIDE);
        int rows = clamp_layout_int(cJSON_GetObjectItem(input_layout, "rows"), 0, 0, LIVE_LAYOUT_GRID_MAX_SIDE);

        cJSON *layout = cJSON_CreateObject();
        cJSON *tiles = cJSON_CreateArray();
        cJSON *cameras = cJSON_CreateArray();
        if (!layout || !tiles || !cameras) {
            cJSON_Delete(layout);
            cJSON_Delete(tiles);
            cJSON_Delete(cameras);
            cJSON_Delete(normalized);
            snprintf(error, error_size, "Out of memory");
            return NULL;
        }
        cJSON_AddStringToObject(layout, "id", layout_id);
        cJSON_AddNumberToObject(layout, "userId", (double)owner_user_id);
        cJSON_AddStringToObject(layout, "name", layout_name);
        if (cols > 0) cJSON_AddNumberToObject(layout, "cols", cols);
        if (rows > 0) cJSON_AddNumberToObject(layout, "rows", rows);
        // Shape of the layout's cells ("auto" follows the first camera)
        const cJSON *cell_aspect = cJSON_GetObjectItem(input_layout, "cellAspect");
        if (cJSON_IsString(cell_aspect) &&
            (strcmp(cell_aspect->valuestring, "4:3") == 0 || strcmp(cell_aspect->valuestring, "16:9") == 0 ||
             strcmp(cell_aspect->valuestring, "1:1") == 0 || strcmp(cell_aspect->valuestring, "3:4") == 0 ||
             strcmp(cell_aspect->valuestring, "9:16") == 0)) {
            cJSON_AddStringToObject(layout, "cellAspect", cell_aspect->valuestring);
        }
        // Tile positions are in whole scene cells (older layouts used a 48-unit grid)
        const cJSON *units = cJSON_GetObjectItem(input_layout, "units");
        if (cJSON_IsString(units) && strcmp(units->valuestring, "cells") == 0) {
            cJSON_AddStringToObject(layout, "units", "cells");
        }
        cJSON_AddItemToObject(layout, "tiles", tiles);
        cJSON_AddItemToObject(layout, "cameras", cameras);
        add_live_layout_extras(layout, input_layout, owner_user_id);

        // Empty slots (places for cameras, e.g. from a 2x2 preset)
        cJSON *slots = cJSON_CreateArray();
        const cJSON *slot_json;
        cJSON_ArrayForEach(slot_json, cJSON_GetObjectItem(input_layout, "slots")) {
            if (!cJSON_IsObject(slot_json) || cJSON_GetArraySize(slots) >= LIVE_LAYOUT_MAX_ITEMS_LIMIT) continue;
            const cJSON *slot_id_json = cJSON_GetObjectItem(slot_json, "id");
            char slot_id[LIVE_LAYOUT_TILE_MAX_LEN + 1];
            if (cJSON_IsString(slot_id_json) && slot_id_json->valuestring) {
                trim_location_value(slot_id_json->valuestring, slot_id, sizeof(slot_id));
            } else {
                snprintf(slot_id, sizeof(slot_id), "slot-%d", cJSON_GetArraySize(slots) + 1);
            }
            if (!is_valid_layout_tile_id(slot_id)) continue;
            cJSON *slot = cJSON_CreateObject();
            cJSON_AddStringToObject(slot, "id", slot_id);
            cJSON_AddNumberToObject(slot, "x", clamp_layout_int(cJSON_GetObjectItem(slot_json, "x"), 0, 0, LIVE_LAYOUT_GRID_MAX_SIDE - 1));
            cJSON_AddNumberToObject(slot, "y", clamp_layout_int(cJSON_GetObjectItem(slot_json, "y"), 0, 0, LIVE_LAYOUT_GRID_MAX_SIDE - 1));
            cJSON_AddNumberToObject(slot, "w", clamp_layout_int(cJSON_GetObjectItem(slot_json, "w"), 1, 1, LIVE_LAYOUT_GRID_MAX_SIDE));
            cJSON_AddNumberToObject(slot, "h", clamp_layout_int(cJSON_GetObjectItem(slot_json, "h"), 1, 1, LIVE_LAYOUT_GRID_MAX_SIDE));
            cJSON_AddItemToArray(slots, slot);
        }
        if (cJSON_GetArraySize(slots) > 0) {
            cJSON_AddItemToObject(layout, "slots", slots);
        } else {
            cJSON_Delete(slots);
        }
        if (only_current_user && shared_with_me) {
            // Shown read-only to the people it is shared with
            cJSON_DeleteItemFromObject(layout, "sharedWith");
            cJSON_AddBoolToObject(layout, "sharedWithMe", true);
            user_t owner;
            if (db_auth_get_user_by_id(owner_user_id, &owner) == 0) {
                cJSON_AddStringToObject(layout, "ownerName", owner.username);
            }
        }

        cJSON *input_tiles = cJSON_GetObjectItem(input_layout, "tiles");
        if (input_tiles && !cJSON_IsArray(input_tiles)) {
            cJSON_Delete(layout);
            cJSON_Delete(normalized);
            snprintf(error, error_size, "layout tiles must be an array");
            return NULL;
        }

        if (input_tiles) {
            cJSON *tile_json = NULL;
            int tile_index = 0;
            cJSON_ArrayForEach(tile_json, input_tiles) {
                if (!cJSON_IsObject(tile_json)) {
                    cJSON_Delete(layout);
                    cJSON_Delete(normalized);
                    snprintf(error, error_size, "Layout tiles must be objects");
                    return NULL;
                }

                cJSON *tile_id_json = cJSON_GetObjectItem(tile_json, "id");
                cJSON *camera_json = cJSON_GetObjectItem(tile_json, "camera");
                if (!camera_json) camera_json = cJSON_GetObjectItem(tile_json, "cameraName");
                if (!cJSON_IsString(camera_json) || !camera_json->valuestring) {
                    cJSON_Delete(layout);
                    cJSON_Delete(normalized);
                    snprintf(error, error_size, "Layout tiles require a camera");
                    return NULL;
                }

                char tile_id[LIVE_LAYOUT_TILE_MAX_LEN + 1];
                char camera_name[LIVE_LAYOUT_CAMERA_MAX_LEN + 1];
                if (cJSON_IsString(tile_id_json) && tile_id_json->valuestring) {
                    trim_location_value(tile_id_json->valuestring, tile_id, sizeof(tile_id));
                } else {
                    snprintf(tile_id, sizeof(tile_id), "tile-%d", tile_index + 1);
                }
                trim_location_value(camera_json->valuestring, camera_name, sizeof(camera_name));

                int fallback_x = cols > 0 ? tile_index % cols : tile_index;
                int fallback_y = cols > 0 ? tile_index / cols : 0;
                int x = clamp_layout_int(cJSON_GetObjectItem(tile_json, "x"), fallback_x, 0, LIVE_LAYOUT_GRID_MAX_SIDE - 1);
                int y = clamp_layout_int(cJSON_GetObjectItem(tile_json, "y"), fallback_y, 0, LIVE_LAYOUT_GRID_MAX_SIDE - 1);
                int w = clamp_layout_int(cJSON_GetObjectItem(tile_json, "w"), 1, 1, LIVE_LAYOUT_GRID_MAX_SIDE);
                int h = clamp_layout_int(cJSON_GetObjectItem(tile_json, "h"), 1, 1, LIVE_LAYOUT_GRID_MAX_SIDE);

                int tiles_before = cJSON_GetArraySize(tiles);
                if (tiles_before >= g_config.live_layout_max_items) {
                    cJSON_Delete(layout);
                    cJSON_Delete(normalized);
                    snprintf(error, error_size, "A layout can hold at most %d cameras", g_config.live_layout_max_items);
                    return NULL;
                }
                if (!add_normalized_layout_tile(tiles, cameras, allowed_cameras, tile_id, camera_name, x, y, w, h, error, error_size)) {
                    cJSON_Delete(layout);
                    cJSON_Delete(normalized);
                    return NULL;
                }
                // Item resolution of the tile in Live View (auto is the default, not stored)
                const cJSON *quality = cJSON_GetObjectItem(tile_json, "quality");
                if (cJSON_GetArraySize(tiles) > tiles_before && cJSON_IsString(quality) &&
                    (strcmp(quality->valuestring, "high") == 0 || strcmp(quality->valuestring, "low") == 0)) {
                    cJSON_AddStringToObject(cJSON_GetArrayItem(tiles, tiles_before), "quality", quality->valuestring);
                }
                tile_index++;
            }

            cJSON_AddItemToArray(layouts, layout);
            continue;
        }

        cJSON *input_cameras = cJSON_GetObjectItem(input_layout, "cameras");
        if (input_cameras && !cJSON_IsArray(input_cameras)) {
            cJSON_Delete(layout);
            cJSON_Delete(normalized);
            snprintf(error, error_size, "layout cameras must be an array");
            return NULL;
        }

        cJSON *camera_json = NULL;
        int camera_index = 0;
        cJSON_ArrayForEach(camera_json, input_cameras) {
            if (!cJSON_IsString(camera_json) || !camera_json->valuestring) {
                cJSON_Delete(layout);
                cJSON_Delete(normalized);
                snprintf(error, error_size, "Camera names must be strings");
                return NULL;
            }

            char camera_name[LIVE_LAYOUT_CAMERA_MAX_LEN + 1];
            trim_location_value(camera_json->valuestring, camera_name, sizeof(camera_name));
            if (!is_valid_layout_camera_name(camera_name)) {
                cJSON_Delete(layout);
                cJSON_Delete(normalized);
                snprintf(error, error_size, "Camera names must be 1-%d characters", LIVE_LAYOUT_CAMERA_MAX_LEN);
                return NULL;
            }

            char tile_id[LIVE_LAYOUT_TILE_MAX_LEN + 1];
            snprintf(tile_id, sizeof(tile_id), "tile-%d", camera_index + 1);
            int fallback_x = cols > 0 ? camera_index % cols : camera_index;
            int fallback_y = cols > 0 ? camera_index / cols : 0;
            if (!add_normalized_layout_tile(tiles, cameras, allowed_cameras, tile_id, camera_name, fallback_x, fallback_y, 1, 1, error, error_size)) {
                cJSON_Delete(layout);
                cJSON_Delete(normalized);
                return NULL;
            }
            camera_index++;
        }

        cJSON_AddItemToArray(layouts, layout);
    }

    return normalized;
}

static cJSON *find_live_layout_by_id(cJSON *layouts, const char *layout_id) {
    if (!layouts || !layout_id) return NULL;

    cJSON *layout = NULL;
    cJSON_ArrayForEach(layout, layouts) {
        cJSON *id_json = cJSON_GetObjectItem(layout, "id");
        if (cJSON_IsString(id_json) && id_json->valuestring &&
            strcmp(id_json->valuestring, layout_id) == 0) {
            return layout;
        }
    }
    return NULL;
}

static bool validate_live_layout_id_ownership(cJSON *stored, cJSON *submitted, const user_t *user,
                                              char *error, size_t error_size) {
    cJSON *stored_layouts = cJSON_GetObjectItem(stored, "layouts");
    cJSON *submitted_layouts = cJSON_GetObjectItem(submitted, "layouts");
    if (!stored_layouts || !submitted_layouts) return true;

    cJSON *layout = NULL;
    cJSON_ArrayForEach(layout, submitted_layouts) {
        cJSON *id_json = cJSON_GetObjectItem(layout, "id");
        if (!cJSON_IsString(id_json) || !id_json->valuestring) continue;

        cJSON *existing = find_live_layout_by_id(stored_layouts, id_json->valuestring);
        if (!existing) continue;

        int64_t existing_owner = get_live_layout_user_id(existing);
        if (existing_owner == LIVE_LAYOUT_UNOWNED_USER_ID && user->role == USER_ROLE_ADMIN) continue;
        if (existing_owner != user->id) {
            snprintf(error, error_size, "Forbidden: layout belongs to another user");
            return false;
        }
    }
    return true;
}

static cJSON *merge_user_live_layouts(cJSON *stored, cJSON *user_layouts, const user_t *user,
                                      char *error, size_t error_size) {
    cJSON *merged = cJSON_CreateObject();
    cJSON *merged_layouts = cJSON_CreateArray();
    if (!merged || !merged_layouts) {
        cJSON_Delete(merged);
        cJSON_Delete(merged_layouts);
        snprintf(error, error_size, "Out of memory");
        return NULL;
    }
    cJSON_AddItemToObject(merged, "layouts", merged_layouts);

    cJSON *stored_layouts = cJSON_GetObjectItem(stored, "layouts");
    cJSON *layout = NULL;
    cJSON_ArrayForEach(layout, stored_layouts) {
        int64_t owner_user_id = get_live_layout_user_id(layout);
        if (owner_user_id == user->id) continue;
        if (owner_user_id == LIVE_LAYOUT_UNOWNED_USER_ID && user->role == USER_ROLE_ADMIN) continue;

        cJSON *copy = cJSON_Duplicate(layout, true);
        if (!copy) {
            cJSON_Delete(merged);
            snprintf(error, error_size, "Out of memory");
            return NULL;
        }
        cJSON_AddItemToArray(merged_layouts, copy);
    }

    cJSON *submitted_layouts = cJSON_GetObjectItem(user_layouts, "layouts");
    cJSON_ArrayForEach(layout, submitted_layouts) {
        cJSON *copy = cJSON_Duplicate(layout, true);
        if (!copy) {
            cJSON_Delete(merged);
            snprintf(error, error_size, "Out of memory");
            return NULL;
        }
        cJSON_DeleteItemFromObject(copy, "userId");
        cJSON_DeleteItemFromObject(copy, "ownerUserId");
        cJSON_DeleteItemFromObject(copy, "owner_user_id");
        cJSON_AddNumberToObject(copy, "userId", (double)user->id);
        cJSON_AddItemToArray(merged_layouts, copy);
    }

    return merged;
}

void handle_get_locations(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/locations request");

    if (g_config.web_auth_enabled) {
        user_t user;
        if (!httpd_check_viewer_access(req, &user)) {
            http_response_set_json_error(res, 401, "Unauthorized");
            return;
        }
    }

    char catalog[LOCATION_CATALOG_MAX_BYTES] = {0};
    if (db_get_system_setting(LOCATION_CATALOG_SETTING_KEY, catalog, sizeof(catalog)) != 0 || catalog[0] == '\0') {
        http_response_set_json(res, 200, "{\"buildings\":[]}");
        return;
    }

    cJSON *parsed = cJSON_Parse(catalog);
    if (!parsed) {
        log_warn("Stored location catalog is invalid JSON; returning empty catalog");
        http_response_set_json(res, 200, "{\"buildings\":[]}");
        return;
    }

    char error[256] = {0};
    cJSON *normalized = normalize_location_catalog_json(parsed, error, sizeof(error));
    cJSON_Delete(parsed);
    if (!normalized) {
        log_warn("Stored location catalog is invalid: %s; returning empty catalog",
                 error[0] ? error : "unknown error");
        http_response_set_json(res, 200, "{\"buildings\":[]}");
        return;
    }

    char *json = cJSON_PrintUnformatted(normalized);
    cJSON_Delete(normalized);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize location catalog");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}

void handle_put_locations(const http_request_t *req, http_response_t *res) {
    log_info("Handling PUT /api/locations request");

    if (!httpd_check_admin_privileges(req, res)) {
        return;
    }

    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON body");
        return;
    }

    char error[256] = {0};
    cJSON *normalized = normalize_location_catalog_json(body, error, sizeof(error));
    cJSON_Delete(body);

    if (!normalized) {
        http_response_set_json_error(res, 400, error[0] ? error : "Invalid location catalog");
        return;
    }

    char *json = cJSON_PrintUnformatted(normalized);
    cJSON_Delete(normalized);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize location catalog");
        return;
    }

    if (strlen(json) >= LOCATION_CATALOG_MAX_BYTES) {
        free(json);
        http_response_set_json_error(res, 400, "Location catalog is too large");
        return;
    }

    if (db_set_system_setting(LOCATION_CATALOG_SETTING_KEY, json) != 0) {
        free(json);
        http_response_set_json_error(res, 500, "Failed to save location catalog");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}

// Layouts other people shared with this user come back read-only: ignore them
static void drop_layouts_shared_with_user(cJSON *body, cJSON *stored, const user_t *user) {
    cJSON *layouts = cJSON_GetObjectItem(body, "layouts");
    cJSON *stored_layouts = cJSON_GetObjectItem(stored, "layouts");
    for (int i = cJSON_GetArraySize(layouts) - 1; i >= 0; i--) {
        cJSON *layout = cJSON_GetArrayItem(layouts, i);
        cJSON *id_json = cJSON_GetObjectItem(layout, "id");
        cJSON *existing = cJSON_IsString(id_json) ? find_live_layout_by_id(stored_layouts, id_json->valuestring) : NULL;
        bool foreign_shared = existing && get_live_layout_user_id(existing) != user->id &&
                              live_layout_shared_with(existing, user->id);
        if (foreign_shared || cJSON_IsTrue(cJSON_GetObjectItem(layout, "sharedWithMe"))) {
            cJSON_DeleteItemFromArray(layouts, i);
        }
    }
}

// What a lock protects: name, cell shape, background, tiles (not their resolution) and slots
static char *live_layout_locked_content(const cJSON *layout) {
    cJSON *content = cJSON_CreateObject();
    const char *keys[] = { "name", "cellAspect", "background", "slots" };
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        const cJSON *item = cJSON_GetObjectItem(layout, keys[i]);
        if (item) cJSON_AddItemToObject(content, keys[i], cJSON_Duplicate(item, true));
    }
    cJSON *tiles = cJSON_AddArrayToObject(content, "tiles");
    const cJSON *tile;
    cJSON_ArrayForEach(tile, cJSON_GetObjectItem(layout, "tiles")) {
        cJSON *copy = cJSON_Duplicate(tile, true);
        cJSON_DeleteItemFromObject(copy, "quality");
        cJSON_AddItemToArray(tiles, copy);
    }
    char *json = cJSON_PrintUnformatted(content);
    cJSON_Delete(content);
    return json;
}

// A locked layout cannot be changed or deleted until its owner unlocks it
static bool check_locked_live_layouts(cJSON *stored, cJSON *submitted, const user_t *user,
                                      char *error, size_t error_size) {
    const cJSON *old_layout;
    cJSON_ArrayForEach(old_layout, cJSON_GetObjectItem(stored, "layouts")) {
        if (!cJSON_IsTrue(cJSON_GetObjectItem(old_layout, "locked"))) continue;
        int64_t owner = get_live_layout_user_id((cJSON *)old_layout);
        if (owner != user->id && !(owner == LIVE_LAYOUT_UNOWNED_USER_ID && user->role == USER_ROLE_ADMIN)) continue;

        const char *id = cJSON_GetObjectItem(old_layout, "id")->valuestring;
        const char *name = cJSON_GetObjectItem(old_layout, "name")->valuestring;
        cJSON *new_layout = find_live_layout_by_id(cJSON_GetObjectItem(submitted, "layouts"), id);
        if (!new_layout) {
            snprintf(error, error_size, "Layout '%s' is locked. Unlock it before deleting it.", name);
            return false;
        }
        if (!cJSON_IsTrue(cJSON_GetObjectItem(new_layout, "locked"))) continue;  // being unlocked

        char *before = live_layout_locked_content(old_layout);
        char *after = live_layout_locked_content(new_layout);
        bool changed = !before || !after || strcmp(before, after) != 0;
        free(before);
        free(after);
        if (changed) {
            snprintf(error, error_size, "Layout '%s' is locked. Unlock it before changing it.", name);
            return false;
        }
    }
    return true;
}

void handle_get_live_layouts(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/live-layouts request");

    user_t user;
    if (g_config.web_auth_enabled) {
        if (!httpd_check_viewer_access(req, &user)) {
            http_response_set_json_error(res, 401, "Unauthorized");
            return;
        }
    } else if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }

    char layouts_json[LIVE_LAYOUTS_MAX_BYTES] = {0};
    if (db_get_system_setting(LIVE_LAYOUTS_SETTING_KEY, layouts_json, sizeof(layouts_json)) != 0 ||
        layouts_json[0] == '\0') {
        http_response_set_json(res, 200, "{\"layouts\":[]}");
        return;
    }

    cJSON *parsed = cJSON_Parse(layouts_json);
    if (!parsed) {
        log_warn("Stored live layouts JSON is invalid; returning empty layouts");
        http_response_set_json(res, 200, "{\"layouts\":[]}");
        return;
    }

    cJSON *allowed_cameras = build_allowed_live_layout_cameras(&user);
    if (!allowed_cameras) {
        cJSON_Delete(parsed);
        http_response_set_json_error(res, 500, "Failed to load camera permissions");
        return;
    }

    char error[256] = {0};
    cJSON *normalized = normalize_live_layouts_json(parsed, &user, true, false, allowed_cameras, error, sizeof(error));
    cJSON_Delete(allowed_cameras);
    cJSON_Delete(parsed);
    if (!normalized) {
        log_warn("Stored live layouts are invalid: %s; returning empty layouts",
                 error[0] ? error : "unknown error");
        http_response_set_json(res, 200, "{\"layouts\":[]}");
        return;
    }

    char *json = cJSON_PrintUnformatted(normalized);
    cJSON_Delete(normalized);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize live layouts");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}

void handle_put_live_layouts(const http_request_t *req, http_response_t *res) {
    log_info("Handling PUT /api/live-layouts request");

    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }

    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON body");
        return;
    }

    char layouts_json[LIVE_LAYOUTS_MAX_BYTES] = {0};
    cJSON *stored = NULL;
    if (db_get_system_setting(LIVE_LAYOUTS_SETTING_KEY, layouts_json, sizeof(layouts_json)) == 0 &&
        layouts_json[0] != '\0') {
        stored = cJSON_Parse(layouts_json);
        if (!stored) {
            log_warn("Stored live layouts JSON is invalid; replacing current user's layouts only");
        }
    }
    if (!stored) {
        stored = cJSON_CreateObject();
        cJSON_AddItemToObject(stored, "layouts", cJSON_CreateArray());
    }
    if (!stored) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 500, "Failed to load existing layouts");
        return;
    }

    cJSON *allowed_cameras = build_allowed_live_layout_cameras(&user);
    if (!allowed_cameras) {
        cJSON_Delete(body);
        cJSON_Delete(stored);
        http_response_set_json_error(res, 500, "Failed to load camera permissions");
        return;
    }

    char error[256] = {0};
    cJSON *normalized_stored = normalize_live_layouts_json(stored, &user, false, false, NULL, error, sizeof(error));
    cJSON_Delete(stored);
    if (!normalized_stored) {
        cJSON_Delete(body);
        cJSON_Delete(allowed_cameras);
        http_response_set_json_error(res, 500, error[0] ? error : "Invalid stored live layouts");
        return;
    }

    drop_layouts_shared_with_user(body, normalized_stored, &user);

    if (!validate_live_layout_id_ownership(normalized_stored, body, &user, error, sizeof(error))) {
        cJSON_Delete(body);
        cJSON_Delete(normalized_stored);
        cJSON_Delete(allowed_cameras);
        http_response_set_json_error(res, 403, error[0] ? error : "Forbidden");
        return;
    }

    cJSON *normalized = normalize_live_layouts_json(body, &user, true, true, allowed_cameras, error, sizeof(error));
    cJSON_Delete(body);
    cJSON_Delete(allowed_cameras);

    if (!normalized) {
        cJSON_Delete(normalized_stored);
        http_response_set_json_error(res, 400, error[0] ? error : "Invalid live layouts");
        return;
    }

    // Background pictures of this user's layouts that are being deleted
    char deleted_backgrounds[16][LIVE_LAYOUT_ID_MAX_LEN + 1];
    int deleted_background_count = 0;
    const cJSON *old_layout;
    cJSON_ArrayForEach(old_layout, cJSON_GetObjectItem(normalized_stored, "layouts")) {
        if (get_live_layout_user_id((cJSON *)old_layout) != user.id || !cJSON_GetObjectItem(old_layout, "background")) continue;
        const char *old_id = cJSON_GetObjectItem(old_layout, "id")->valuestring;
        if (!find_live_layout_by_id(cJSON_GetObjectItem(normalized, "layouts"), old_id) && deleted_background_count < 16) {
            snprintf(deleted_backgrounds[deleted_background_count++], LIVE_LAYOUT_ID_MAX_LEN + 1, "%s", old_id);
        }
    }

    if (!check_locked_live_layouts(normalized_stored, normalized, &user, error, sizeof(error))) {
        cJSON_Delete(normalized_stored);
        cJSON_Delete(normalized);
        http_response_set_json_error(res, 409, error);
        return;
    }

    cJSON *merged = merge_user_live_layouts(normalized_stored, normalized, &user, error, sizeof(error));
    cJSON_Delete(normalized_stored);
    if (!merged) {
        cJSON_Delete(normalized);
        http_response_set_json_error(res, 500, error[0] ? error : "Failed to merge live layouts");
        return;
    }

    char *json = cJSON_PrintUnformatted(merged);
    cJSON_Delete(merged);
    if (!json) {
        cJSON_Delete(normalized);
        http_response_set_json_error(res, 500, "Failed to serialize live layouts");
        return;
    }

    if (strlen(json) >= LIVE_LAYOUTS_MAX_BYTES) {
        free(json);
        http_response_set_json_error(res, 400, "Live layouts payload is too large");
        return;
    }

    if (db_set_system_setting(LIVE_LAYOUTS_SETTING_KEY, json) != 0) {
        free(json);
        http_response_set_json_error(res, 500, "Failed to save live layouts");
        return;
    }

    for (int i = 0; i < deleted_background_count; i++) {
        char background_path[MAX_PATH_LENGTH];
        live_layout_background_path(deleted_backgrounds[i], background_path, sizeof(background_path));
        unlink(background_path);
    }

    // Reply with what GET would now return: own layouts plus those shared with this user
    cJSON *merged_view = cJSON_Parse(json);
    cJSON *allowed_view = build_allowed_live_layout_cameras(&user);
    cJSON *view = (merged_view && allowed_view)
        ? normalize_live_layouts_json(merged_view, &user, true, false, allowed_view, error, sizeof(error))
        : NULL;
    cJSON_Delete(merged_view);
    cJSON_Delete(allowed_view);
    char *response_json = cJSON_PrintUnformatted(view ? view : normalized);
    cJSON_Delete(view);
    cJSON_Delete(normalized);
    if (!response_json) {
        free(json);
        http_response_set_json_error(res, 500, "Failed to serialize live layouts");
        return;
    }

    http_response_set_json(res, 200, response_json);
    free(json);
    free(response_json);
}

/**
 * @brief Background task for MQTT reinit after settings change.
 *
 * MQTT cleanup and reconnection can take several seconds due to timeouts,
 * so we run it in a detached thread (same pattern as go2rtc below).
 */
typedef struct {
    bool mqtt_now_enabled;  // Whether MQTT is enabled after the settings change
} mqtt_settings_task_t;

static void mqtt_settings_worker(mqtt_settings_task_t *task) {
    if (!task) return;

    log_set_thread_context("Settings", NULL);
    log_info("MQTT settings worker: reinitializing MQTT client...");

    int rc = mqtt_reinit(&g_config);
    // cppcheck-suppress knownConditionTrueFalse
    if (rc != 0) {
        log_error("MQTT settings worker: reinit failed (rc=%d)", rc);
    } else {
        log_info("MQTT settings worker: reinit complete (mqtt_enabled=%s)",
                 task->mqtt_now_enabled ? "true" : "false");
    }

    free(task);
}

/**
 * @brief Background task for go2rtc start/stop after settings change.
 *
 * The actual go2rtc start/stop involves multiple sleep() calls (5-15+ seconds)
 * so we run it in a detached thread to avoid blocking the API response.
 */
typedef struct {
    bool becoming_enabled;   // true = user enabled go2rtc, false = user disabled it
} go2rtc_settings_task_t;

static void go2rtc_settings_worker(go2rtc_settings_task_t *task) {
    if (!task) return;

    log_set_thread_context("Settings", NULL);
    stream_config_t *all_streams = calloc(g_config.max_streams, sizeof(stream_config_t));
    if (!all_streams) {
        log_error("go2rtc_settings_worker: out of memory");
        free(task);
        return;
    }
    int stream_count = get_all_stream_configs(all_streams, g_config.max_streams);

    if (!task->becoming_enabled) {
        // go2rtc is being DISABLED — stop health monitor, stop go2rtc, start native HLS
        log_info("go2rtc settings worker: disabling go2rtc...");

        // Stop the health monitor first so it doesn't restart go2rtc
        go2rtc_integration_cleanup();

        if (go2rtc_process_is_running()) {
            // Stop HLS streams that were routed through go2rtc
            for (int i = 0; i < stream_count; i++) {
                if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                    all_streams[i].streaming_enabled) {
                    stop_hls_stream(all_streams[i].name);
                }
            }

            // Stop MP4 recordings that were using go2rtc RTSP URLs
            // They will be restarted below with direct camera URLs
            for (int i = 0; i < stream_count; i++) {
                if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                    all_streams[i].record) {
                    log_info("Stopping MP4 recording for %s before go2rtc shutdown", all_streams[i].name);
                    stop_mp4_recording(all_streams[i].name);
                }
            }

            if (!go2rtc_process_stop()) {
                log_warn("Failed to stop go2rtc process cleanly");
            }
            sleep(2);
        }

        // Fully reset the stream module (process manager + API client) so that
        // a subsequent re-enable gets a completely fresh go2rtc_stream_init().
        // Without this, the stream module remains "initialized" with potentially
        // stale state, and go2rtc_integration_full_start() skips the init step.
        go2rtc_stream_cleanup();

        // Restart MP4 recordings with direct camera URLs (go2rtc is now disabled)
        for (int i = 0; i < stream_count; i++) {
            if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                all_streams[i].record) {
                log_info("Restarting MP4 recording for %s with direct camera URL", all_streams[i].name);
                if (start_mp4_recording(all_streams[i].name) != 0) {
                    log_warn("Failed to restart MP4 recording for stream %s", all_streams[i].name);
                }
            }
        }

        // Start native HLS threads
        for (int i = 0; i < stream_count; i++) {
            if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                all_streams[i].streaming_enabled) {
                if (start_hls_stream(all_streams[i].name) != 0) {
                    log_warn("Failed to start native HLS for stream %s", all_streams[i].name);
                }
            }
        }

        log_info("go2rtc settings worker: go2rtc disabled, native HLS and recordings restarted");
    } else {
        // go2rtc is being ENABLED (or config changed) — restart go2rtc
        log_info("go2rtc settings worker: enabling go2rtc...");

        // Stop any existing HLS threads first
        for (int i = 0; i < stream_count; i++) {
            if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                all_streams[i].streaming_enabled) {
                stop_hls_stream(all_streams[i].name);
            }
        }

        // Stop MP4 recordings so they can be restarted with go2rtc RTSP URLs
        for (int i = 0; i < stream_count; i++) {
            if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                all_streams[i].record) {
                log_info("Stopping MP4 recording for %s before go2rtc startup", all_streams[i].name);
                stop_mp4_recording(all_streams[i].name);
            }
        }

        // Stop go2rtc if already running
        if (go2rtc_process_is_running()) {
            if (!go2rtc_process_stop()) {
                log_warn("Failed to stop go2rtc process cleanly, continuing anyway");
            }
            sleep(2);
        }

        // Full go2rtc startup: init, start, register streams
        if (!go2rtc_integration_full_start()) {
            log_error("Failed to start go2rtc integration");

            // go2rtc failed to start — restart recordings with direct URLs as fallback
            for (int i = 0; i < stream_count; i++) {
                if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                    all_streams[i].record) {
                    log_info("Restarting MP4 recording for %s with direct URL (go2rtc failed)", all_streams[i].name);
                    if (start_mp4_recording(all_streams[i].name) != 0) {
                        log_warn("Failed to restart MP4 recording for stream %s", all_streams[i].name);
                    }
                }
            }
        } else {
            // Restart MP4 recordings routed through go2rtc
            for (int i = 0; i < stream_count; i++) {
                if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                    all_streams[i].record) {
                    log_info("Restarting MP4 recording for %s via go2rtc", all_streams[i].name);
                    if (go2rtc_integration_start_recording(all_streams[i].name) != 0) {
                        log_warn("Failed to restart MP4 recording for stream %s via go2rtc", all_streams[i].name);
                    }
                }
            }

            // Start HLS streams routed through go2rtc
            for (int i = 0; i < stream_count; i++) {
                if (all_streams[i].name[0] != '\0' && all_streams[i].enabled &&
                    all_streams[i].streaming_enabled) {
                    if (stream_start_hls(all_streams[i].name) != 0) {
                        log_warn("Failed to start HLS for stream %s", all_streams[i].name);
                    }
                }
            }
            log_info("go2rtc settings worker: go2rtc enabled, streams and recordings restarted");
        }
    }

    free(all_streams);
    free(task);
}

/**
 * @brief Direct handler for GET /api/settings
 */
void handle_get_settings(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/settings request");

    // Check authentication if enabled
    // In demo mode, allow unauthenticated viewer access to read settings
    if (g_config.web_auth_enabled) {
        user_t user;
        if (g_config.demo_mode) {
            if (!httpd_check_viewer_access(req, &user)) {
                log_error("Authentication failed for GET /api/settings request");
                http_response_set_json_error(res, 401, "Unauthorized");
                return;
            }
        } else {
            if (!httpd_get_authenticated_user(req, &user)) {
                log_error("Authentication failed for GET /api/settings request");
                http_response_set_json_error(res, 401, "Unauthorized");
                return;
            }
        }
    }

    // Get global configuration
    // Create JSON object
    cJSON *settings = cJSON_CreateObject();
    if (!settings) {
        log_error("Failed to create settings JSON object");
        http_response_set_json_error(res, 500, "Failed to create settings JSON");
        return;
    }
    
    // Add settings properties
    cJSON_AddNumberToObject(settings, "web_thread_pool_size", g_config.web_thread_pool_size);
    cJSON_AddNumberToObject(settings, "web_port", g_config.web_port);
    cJSON_AddStringToObject(settings, "web_root", g_config.web_root);
    cJSON_AddBoolToObject(settings, "web_auth_enabled", g_config.web_auth_enabled);
    cJSON_AddBoolToObject(settings, "demo_mode", g_config.demo_mode);
    // Note: web_username and web_password removed - user management is now fully database-based
    cJSON_AddBoolToObject(settings, "webrtc_disabled", g_config.webrtc_disabled);
    
    cJSON_AddStringToObject(settings, "storage_path", g_config.storage_path);
    cJSON_AddStringToObject(settings, "storage_path_hls", g_config.storage_path_hls);
    cJSON_AddNumberToObject(settings, "max_storage_size", (double)g_config.max_storage_size);
    cJSON_AddNumberToObject(settings, "retention_days", g_config.retention_days);
    cJSON_AddBoolToObject(settings, "auto_delete_oldest", g_config.auto_delete_oldest);
    cJSON_AddBoolToObject(settings, "generate_thumbnails", g_config.generate_thumbnails);
    cJSON_AddNumberToObject(settings, "max_streams", g_config.max_streams);
    cJSON_AddStringToObject(settings, "log_file", g_config.log_file);
    cJSON_AddNumberToObject(settings, "log_level", g_config.log_level);
    cJSON_AddStringToObject(settings, "pid_file", g_config.pid_file);
    cJSON_AddStringToObject(settings, "db_path", g_config.db_path);
    cJSON_AddNumberToObject(settings, "db_backup_interval_minutes", g_config.db_backup_interval_minutes);
    cJSON_AddNumberToObject(settings, "db_backup_retention_count", g_config.db_backup_retention_count);
    cJSON_AddStringToObject(settings, "db_post_backup_script", g_config.db_post_backup_script);
    cJSON_AddStringToObject(settings, "models_path", g_config.models_path);
    cJSON_AddNumberToObject(settings, "buffer_size", g_config.buffer_size);
    cJSON_AddBoolToObject(settings, "use_swap", g_config.use_swap);
    cJSON_AddNumberToObject(settings, "swap_size", (double)g_config.swap_size / (double)(1024ULL * 1024ULL)); // Convert bytes to MB

    // Syslog settings
    cJSON_AddBoolToObject(settings, "syslog_enabled", g_config.syslog_enabled);
    cJSON_AddStringToObject(settings, "syslog_ident", g_config.syslog_ident);
    // Convert facility number to name for the API
    {
        const char *facility_name;
        switch (g_config.syslog_facility) {
            case LOG_USER: facility_name = "LOG_USER"; break;
            case LOG_DAEMON: facility_name = "LOG_DAEMON"; break;
            case LOG_LOCAL0: facility_name = "LOG_LOCAL0"; break;
            case LOG_LOCAL1: facility_name = "LOG_LOCAL1"; break;
            case LOG_LOCAL2: facility_name = "LOG_LOCAL2"; break;
            case LOG_LOCAL3: facility_name = "LOG_LOCAL3"; break;
            case LOG_LOCAL4: facility_name = "LOG_LOCAL4"; break;
            case LOG_LOCAL5: facility_name = "LOG_LOCAL5"; break;
            case LOG_LOCAL6: facility_name = "LOG_LOCAL6"; break;
            case LOG_LOCAL7: facility_name = "LOG_LOCAL7"; break;
            default: facility_name = "LOG_USER"; break;
        }
        cJSON_AddStringToObject(settings, "syslog_facility", facility_name);
    }

    // API detection settings
    cJSON_AddStringToObject(settings, "api_detection_url", g_config.api_detection_url);
    cJSON_AddStringToObject(settings, "api_detection_backend", g_config.api_detection_backend);

    // Detection defaults
    cJSON_AddNumberToObject(settings, "default_detection_threshold", g_config.default_detection_threshold);
    cJSON_AddNumberToObject(settings, "pre_detection_buffer", g_config.default_pre_detection_buffer);
    cJSON_AddNumberToObject(settings, "post_detection_buffer", g_config.default_post_detection_buffer);
    cJSON_AddStringToObject(settings, "buffer_strategy", g_config.default_buffer_strategy);

    // Auth timeout
    cJSON_AddNumberToObject(settings, "auth_timeout_hours", g_config.auth_timeout_hours);
    cJSON_AddNumberToObject(settings, "auth_absolute_timeout_hours", g_config.auth_absolute_timeout_hours);
    cJSON_AddNumberToObject(settings, "trusted_device_days", g_config.trusted_device_days);
    cJSON_AddStringToObject(settings, "trusted_proxy_cidrs", g_config.trusted_proxy_cidrs);

    // Security settings
    cJSON_AddBoolToObject(settings, "force_mfa_on_login", g_config.force_mfa_on_login);
    cJSON_AddBoolToObject(settings, "login_rate_limit_enabled", g_config.login_rate_limit_enabled);
    cJSON_AddNumberToObject(settings, "login_rate_limit_max_attempts", g_config.login_rate_limit_max_attempts);
    cJSON_AddNumberToObject(settings, "login_rate_limit_window_seconds", g_config.login_rate_limit_window_seconds);

    // go2rtc settings
    cJSON_AddBoolToObject(settings, "go2rtc_enabled", g_config.go2rtc_enabled);
    cJSON_AddStringToObject(settings, "go2rtc_binary_path", g_config.go2rtc_binary_path);
    cJSON_AddStringToObject(settings, "go2rtc_config_dir", g_config.go2rtc_config_dir);
    cJSON_AddNumberToObject(settings, "go2rtc_api_port", g_config.go2rtc_api_port);
    cJSON_AddNumberToObject(settings, "go2rtc_rtsp_port", g_config.go2rtc_rtsp_port);
    cJSON_AddBoolToObject(settings, "go2rtc_webrtc_enabled", g_config.go2rtc_webrtc_enabled);
    cJSON_AddNumberToObject(settings, "go2rtc_webrtc_listen_port", g_config.go2rtc_webrtc_listen_port);
    cJSON_AddBoolToObject(settings, "go2rtc_stun_enabled", g_config.go2rtc_stun_enabled);
    cJSON_AddStringToObject(settings, "go2rtc_stun_server", g_config.go2rtc_stun_server);
    cJSON_AddStringToObject(settings, "go2rtc_external_ip", g_config.go2rtc_external_ip);
    cJSON_AddStringToObject(settings, "go2rtc_ice_servers", g_config.go2rtc_ice_servers);
    cJSON_AddBoolToObject(settings, "go2rtc_force_native_hls", g_config.go2rtc_force_native_hls);

    // MQTT settings
    cJSON_AddBoolToObject(settings, "mqtt_enabled", g_config.mqtt_enabled);
    cJSON_AddStringToObject(settings, "mqtt_broker_host", g_config.mqtt_broker_host);
    cJSON_AddNumberToObject(settings, "mqtt_broker_port", g_config.mqtt_broker_port);
    cJSON_AddStringToObject(settings, "mqtt_username", g_config.mqtt_username);
    // Don't include the password for security reasons
    cJSON_AddStringToObject(settings, "mqtt_password", g_config.mqtt_password[0] ? "********" : "");
    cJSON_AddStringToObject(settings, "mqtt_client_id", g_config.mqtt_client_id);
    cJSON_AddStringToObject(settings, "mqtt_topic_prefix", g_config.mqtt_topic_prefix);
    cJSON_AddBoolToObject(settings, "mqtt_tls_enabled", g_config.mqtt_tls_enabled);
    cJSON_AddNumberToObject(settings, "mqtt_keepalive", g_config.mqtt_keepalive);
    cJSON_AddNumberToObject(settings, "mqtt_qos", g_config.mqtt_qos);
    cJSON_AddBoolToObject(settings, "mqtt_retain", g_config.mqtt_retain);

    // Home Assistant MQTT auto-discovery settings
    cJSON_AddBoolToObject(settings, "mqtt_ha_discovery", g_config.mqtt_ha_discovery);
    cJSON_AddStringToObject(settings, "mqtt_ha_discovery_prefix", g_config.mqtt_ha_discovery_prefix);
    cJSON_AddNumberToObject(settings, "mqtt_ha_snapshot_interval", g_config.mqtt_ha_snapshot_interval);

    // TURN server settings for WebRTC relay
    cJSON_AddBoolToObject(settings, "turn_enabled", g_config.turn_enabled);
    cJSON_AddStringToObject(settings, "turn_server_url", g_config.turn_server_url);
    cJSON_AddStringToObject(settings, "turn_username", g_config.turn_username);
    // Don't include the password for security reasons
    cJSON_AddStringToObject(settings, "turn_password", g_config.turn_password[0] ? "********" : "");

    // ONVIF discovery settings
    cJSON_AddBoolToObject(settings, "onvif_discovery_enabled", g_config.onvif_discovery_enabled);
    cJSON_AddNumberToObject(settings, "onvif_discovery_interval", g_config.onvif_discovery_interval);
    cJSON_AddStringToObject(settings, "onvif_discovery_network", g_config.onvif_discovery_network);
    cJSON_AddStringToObject(settings, "onvif_discovery_ignored", g_config.onvif_discovery_ignored);
    cJSON_AddNumberToObject(settings, "live_layout_max_items", g_config.live_layout_max_items);

    // Convert to string
    char *json_str = cJSON_PrintUnformatted(settings);
    if (!json_str) {
        log_error("Failed to convert settings JSON to string");
        cJSON_Delete(settings);
        http_response_set_json_error(res, 500, "Failed to convert settings JSON to string");
        return;
    }
    
    // Send response
    http_response_set_json(res, 200, json_str);
    
    // Clean up
    free(json_str);
    cJSON_Delete(settings);
    
    log_info("Successfully handled GET /api/settings request");
}

/**
 * @brief Direct handler for POST /api/settings
 */
void handle_post_settings(const http_request_t *req, http_response_t *res) {
    log_info("Handling POST /api/settings request");

    // Check if user has admin privileges to modify settings
    if (!httpd_check_admin_privileges(req, res)) {
        return;  // Error response already sent
    }

    // Parse JSON from request body
    cJSON *settings = httpd_parse_json_body(req);
    if (!settings) {
        log_error("Failed to parse settings JSON from request body");
        http_response_set_json_error(res, 400, "Invalid JSON in request body");
        return;
    }

    // Update settings
    bool settings_changed = false;
    bool restart_required = false;
    bool web_thread_pool_restart_required = false;
    bool storage_manager_changed = false;
    bool go2rtc_config_changed = false;  // Track if go2rtc-related settings changed
    bool go2rtc_becoming_enabled = false;  // Track transition direction
    bool mqtt_config_changed = false;     // Track if MQTT-related settings changed

    const uint64_t old_max_storage_size = g_config.max_storage_size;
    const int old_retention_days = g_config.retention_days;

    // Snapshot current MQTT settings before parsing new values
    bool old_mqtt_enabled = g_config.mqtt_enabled;
    char old_mqtt_broker_host[256];
    strncpy(old_mqtt_broker_host, g_config.mqtt_broker_host, sizeof(old_mqtt_broker_host));
    int old_mqtt_broker_port = g_config.mqtt_broker_port;
    char old_mqtt_username[128];
    strncpy(old_mqtt_username, g_config.mqtt_username, sizeof(old_mqtt_username));
    char old_mqtt_password[128];
    strncpy(old_mqtt_password, g_config.mqtt_password, sizeof(old_mqtt_password));
    char old_mqtt_client_id[128];
    strncpy(old_mqtt_client_id, g_config.mqtt_client_id, sizeof(old_mqtt_client_id));
    char old_mqtt_topic_prefix[256];
    strncpy(old_mqtt_topic_prefix, g_config.mqtt_topic_prefix, sizeof(old_mqtt_topic_prefix));
    bool old_mqtt_tls_enabled = g_config.mqtt_tls_enabled;
    int old_mqtt_keepalive = g_config.mqtt_keepalive;
    int old_mqtt_qos = g_config.mqtt_qos;
    bool old_mqtt_retain = g_config.mqtt_retain;
    bool old_mqtt_ha_discovery = g_config.mqtt_ha_discovery;
    char old_mqtt_ha_discovery_prefix[128];
    strncpy(old_mqtt_ha_discovery_prefix, g_config.mqtt_ha_discovery_prefix, sizeof(old_mqtt_ha_discovery_prefix));
    int old_mqtt_ha_snapshot_interval = g_config.mqtt_ha_snapshot_interval;

    // Web thread pool size (requires restart; stored in config only)
    cJSON *web_thread_pool_size_j = cJSON_GetObjectItem(settings, "web_thread_pool_size");
    if (web_thread_pool_size_j && cJSON_IsNumber(web_thread_pool_size_j)) {
        int v = web_thread_pool_size_j->valueint;
        if (v < 2)   v = 2;
        if (v > 128) v = 128;
        if (v != g_config.web_thread_pool_size) {
            g_config.web_thread_pool_size = v;
            settings_changed = true;
            restart_required = true;
            web_thread_pool_restart_required = true;
            log_info("Updated web_thread_pool_size: %d (restart required)", v);
        }
    }

    // Web port
    cJSON *web_port = cJSON_GetObjectItem(settings, "web_port");
    if (web_port && cJSON_IsNumber(web_port)) {
        g_config.web_port = web_port->valueint;
        settings_changed = true;
        log_info("Updated web_port: %d", g_config.web_port);
    }

    // Web root
    cJSON *web_root = cJSON_GetObjectItem(settings, "web_root");
    if (web_root && cJSON_IsString(web_root)) {
        strncpy(g_config.web_root, web_root->valuestring, sizeof(g_config.web_root) - 1);
        g_config.web_root[sizeof(g_config.web_root) - 1] = '\0';
        settings_changed = true;
        log_info("Updated web_root: %s", g_config.web_root);
    }

    // Web auth enabled
    cJSON *web_auth_enabled = cJSON_GetObjectItem(settings, "web_auth_enabled");
    if (web_auth_enabled && cJSON_IsBool(web_auth_enabled)) {
        g_config.web_auth_enabled = cJSON_IsTrue(web_auth_enabled);
        settings_changed = true;
        log_info("Updated web_auth_enabled: %s", g_config.web_auth_enabled ? "true" : "false");
    }

    // Demo mode
    cJSON *demo_mode = cJSON_GetObjectItem(settings, "demo_mode");
    if (demo_mode && cJSON_IsBool(demo_mode)) {
        g_config.demo_mode = cJSON_IsTrue(demo_mode);
        settings_changed = true;
        log_info("Updated demo_mode: %s", g_config.demo_mode ? "true" : "false");
    }

    // Note: web_username and web_password settings removed - user management is now fully database-based

    // WebRTC disabled - track old value to detect changes
    cJSON *webrtc_disabled = cJSON_GetObjectItem(settings, "webrtc_disabled");
    if (webrtc_disabled && cJSON_IsBool(webrtc_disabled)) {
        bool old_webrtc_disabled = g_config.webrtc_disabled;
        g_config.webrtc_disabled = cJSON_IsTrue(webrtc_disabled);
        settings_changed = true;
        log_info("Updated webrtc_disabled: %s", g_config.webrtc_disabled ? "true" : "false");

        // If webrtc_disabled changed, we need to restart go2rtc
        if (old_webrtc_disabled != g_config.webrtc_disabled) {
            go2rtc_config_changed = true;
            go2rtc_becoming_enabled = g_config.go2rtc_enabled;  // restart, not a toggle
            log_info("WebRTC disabled setting changed, will restart go2rtc");
        }
    }

    // Auth timeout hours
    cJSON *auth_timeout_hours = cJSON_GetObjectItem(settings, "auth_timeout_hours");
    if (auth_timeout_hours && cJSON_IsNumber(auth_timeout_hours)) {
        int value = auth_timeout_hours->valueint;
        if (value < 1) value = 1; // Minimum 1 hour
        g_config.auth_timeout_hours = value;
        settings_changed = true;
        log_info("Updated auth_timeout_hours: %d", g_config.auth_timeout_hours);
    }

    cJSON *auth_absolute_timeout_hours = cJSON_GetObjectItem(settings, "auth_absolute_timeout_hours");
    if (auth_absolute_timeout_hours && cJSON_IsNumber(auth_absolute_timeout_hours)) {
        int value = auth_absolute_timeout_hours->valueint;
        if (value < 1) value = 1;
        g_config.auth_absolute_timeout_hours = value;
        settings_changed = true;
        log_info("Updated auth_absolute_timeout_hours: %d", g_config.auth_absolute_timeout_hours);
    }

    cJSON *trusted_device_days = cJSON_GetObjectItem(settings, "trusted_device_days");
    if (trusted_device_days && cJSON_IsNumber(trusted_device_days)) {
        int value = trusted_device_days->valueint;
        if (value < 0) value = 0;
        g_config.trusted_device_days = value;
        settings_changed = true;
        log_info("Updated trusted_device_days: %d", g_config.trusted_device_days);
    }

    cJSON *trusted_proxy_cidrs = cJSON_GetObjectItem(settings, "trusted_proxy_cidrs");
    if (trusted_proxy_cidrs && cJSON_IsString(trusted_proxy_cidrs)) {
        if (db_auth_validate_allowed_login_cidrs(trusted_proxy_cidrs->valuestring) != 0) {
            log_warn("Rejected invalid trusted_proxy_cidrs setting");
            cJSON_Delete(settings);
            http_response_set_json_error(res, 400, "Invalid trusted_proxy_cidrs: expected comma- or newline-separated IPv4/IPv6 CIDRs");
            return;
        }
        strncpy(g_config.trusted_proxy_cidrs, trusted_proxy_cidrs->valuestring,
                sizeof(g_config.trusted_proxy_cidrs) - 1);
        g_config.trusted_proxy_cidrs[sizeof(g_config.trusted_proxy_cidrs) - 1] = '\0';
        settings_changed = true;
        log_info("Updated trusted_proxy_cidrs");
    }

    if (g_config.auth_absolute_timeout_hours < g_config.auth_timeout_hours) {
        g_config.auth_absolute_timeout_hours = g_config.auth_timeout_hours;
    }

    // Force MFA on login
    cJSON *force_mfa_on_login = cJSON_GetObjectItem(settings, "force_mfa_on_login");
    if (force_mfa_on_login && cJSON_IsBool(force_mfa_on_login)) {
        g_config.force_mfa_on_login = cJSON_IsTrue(force_mfa_on_login);
        settings_changed = true;
        log_info("Updated force_mfa_on_login: %s", g_config.force_mfa_on_login ? "true" : "false");
    }

    // Login rate limit enabled
    cJSON *login_rate_limit_enabled = cJSON_GetObjectItem(settings, "login_rate_limit_enabled");
    if (login_rate_limit_enabled && cJSON_IsBool(login_rate_limit_enabled)) {
        g_config.login_rate_limit_enabled = cJSON_IsTrue(login_rate_limit_enabled);
        settings_changed = true;
        log_info("Updated login_rate_limit_enabled: %s", g_config.login_rate_limit_enabled ? "true" : "false");
    }

    // Login rate limit max attempts
    cJSON *login_rate_limit_max_attempts = cJSON_GetObjectItem(settings, "login_rate_limit_max_attempts");
    if (login_rate_limit_max_attempts && cJSON_IsNumber(login_rate_limit_max_attempts)) {
        int value = login_rate_limit_max_attempts->valueint;
        if (value < 1) value = 1;
        g_config.login_rate_limit_max_attempts = value;
        settings_changed = true;
        log_info("Updated login_rate_limit_max_attempts: %d", g_config.login_rate_limit_max_attempts);
    }

    // Login rate limit window seconds
    cJSON *login_rate_limit_window_seconds = cJSON_GetObjectItem(settings, "login_rate_limit_window_seconds");
    if (login_rate_limit_window_seconds && cJSON_IsNumber(login_rate_limit_window_seconds)) {
        int value = login_rate_limit_window_seconds->valueint;
        if (value < 10) value = 10; // Minimum 10 seconds
        g_config.login_rate_limit_window_seconds = value;
        settings_changed = true;
        log_info("Updated login_rate_limit_window_seconds: %d", g_config.login_rate_limit_window_seconds);
    }

    // Storage path — validate before accepting to prevent shell injection
    cJSON *storage_path = cJSON_GetObjectItem(settings, "storage_path");
    if (storage_path && cJSON_IsString(storage_path)) {
        if (!is_safe_storage_path(storage_path->valuestring)) {
            log_warn("Rejected unsafe storage_path: %s", storage_path->valuestring);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 400,
                "Invalid storage_path: must be an absolute path without shell metacharacters");
            return;
        }
        strncpy(g_config.storage_path, storage_path->valuestring, sizeof(g_config.storage_path) - 1);
        g_config.storage_path[sizeof(g_config.storage_path) - 1] = '\0';
        settings_changed = true;
        log_info("Updated storage_path: %s", g_config.storage_path);
    }

    // Storage path for HLS segments — optional field, empty string means "use storage_path"
    cJSON *storage_path_hls = cJSON_GetObjectItem(settings, "storage_path_hls");
    if (storage_path_hls && cJSON_IsString(storage_path_hls)) {
        const char *hls_path_val = storage_path_hls->valuestring;
        // Only validate when non-empty; empty string clears the override
        if (hls_path_val[0] != '\0' && !is_safe_storage_path(hls_path_val)) {
            log_warn("Rejected unsafe storage_path_hls: %s", hls_path_val);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 400,
                "Invalid storage_path_hls: must be an absolute path without shell metacharacters");
            return;
        }
        strncpy(g_config.storage_path_hls, hls_path_val, sizeof(g_config.storage_path_hls) - 1);
        g_config.storage_path_hls[sizeof(g_config.storage_path_hls) - 1] = '\0';
        settings_changed = true;
        log_info("Updated storage_path_hls: %s",
                 hls_path_val[0] ? hls_path_val : "(cleared, will use storage_path)");
    }
    
    // Max storage size
    cJSON *max_storage_size = cJSON_GetObjectItem(settings, "max_storage_size");
    if (max_storage_size && cJSON_IsNumber(max_storage_size)) {
        g_config.max_storage_size = max_storage_size->valueint;
        if (g_config.max_storage_size != old_max_storage_size) {
            storage_manager_changed = true;
        }
        settings_changed = true;
        log_info("Updated max_storage_size: %" PRIu64, g_config.max_storage_size);
    }
    
    // Retention days
    cJSON *retention_days = cJSON_GetObjectItem(settings, "retention_days");
    if (retention_days && cJSON_IsNumber(retention_days)) {
        g_config.retention_days = retention_days->valueint;
        if (g_config.retention_days != old_retention_days) {
            storage_manager_changed = true;
        }
        settings_changed = true;
        log_info("Updated retention_days: %d", g_config.retention_days);
    }
    
    // Auto delete oldest
    cJSON *auto_delete_oldest = cJSON_GetObjectItem(settings, "auto_delete_oldest");
    if (auto_delete_oldest && cJSON_IsBool(auto_delete_oldest)) {
        g_config.auto_delete_oldest = cJSON_IsTrue(auto_delete_oldest);
        settings_changed = true;
        log_info("Updated auto_delete_oldest: %s", g_config.auto_delete_oldest ? "true" : "false");
    }

    // Generate thumbnails (grid view)
    cJSON *generate_thumbnails = cJSON_GetObjectItem(settings, "generate_thumbnails");
    if (generate_thumbnails && cJSON_IsBool(generate_thumbnails)) {
        g_config.generate_thumbnails = cJSON_IsTrue(generate_thumbnails);
        settings_changed = true;
        log_info("Updated generate_thumbnails: %s", g_config.generate_thumbnails ? "true" : "false");
    }

    // Models path
    cJSON *models_path = cJSON_GetObjectItem(settings, "models_path");
    if (models_path && cJSON_IsString(models_path)) {
        strncpy(g_config.models_path, models_path->valuestring, sizeof(g_config.models_path) - 1);
        g_config.models_path[sizeof(g_config.models_path) - 1] = '\0';
        settings_changed = true;
        log_info("Updated models_path: %s", g_config.models_path);
    }
    
    // max_streams is retained as an initial runtime capacity hint. The stream
    // managers now grow when more cameras are added.
    cJSON *max_streams_j = cJSON_GetObjectItem(settings, "max_streams");
    if (max_streams_j && cJSON_IsNumber(max_streams_j)) {
        int new_max = max_streams_j->valueint;
        if (new_max < 1) new_max = 1;
        if (new_max != g_config.max_streams) {
            if (ensure_stream_config_capacity(&g_config, new_max) == 0) {
                settings_changed = true;
                log_info("Updated stream config capacity hint: %d", new_max);
            } else {
                log_warn("Failed to update stream config capacity hint to %d", new_max);
            }
        }
    }

    // Log file
    cJSON *log_file = cJSON_GetObjectItem(settings, "log_file");
    if (log_file && cJSON_IsString(log_file)) {
        strncpy(g_config.log_file, log_file->valuestring, sizeof(g_config.log_file) - 1);
        g_config.log_file[sizeof(g_config.log_file) - 1] = '\0';
        settings_changed = true;
        log_info("Updated log_file: %s", g_config.log_file);
    }
    
    // Log level
    cJSON *log_level = cJSON_GetObjectItem(settings, "log_level");
    if (log_level && cJSON_IsNumber(log_level)) {
        g_config.log_level = log_level->valueint;
        set_log_level(g_config.log_level);
        settings_changed = true;
        log_info("Updated log_level: %d", g_config.log_level);
    }

    // Syslog enabled
    cJSON *syslog_enabled = cJSON_GetObjectItem(settings, "syslog_enabled");
    if (syslog_enabled && cJSON_IsBool(syslog_enabled)) {
        g_config.syslog_enabled = cJSON_IsTrue(syslog_enabled);
        settings_changed = true;
        log_info("Updated syslog_enabled: %s", g_config.syslog_enabled ? "true" : "false");
    }

    // Syslog ident
    cJSON *syslog_ident = cJSON_GetObjectItem(settings, "syslog_ident");
    if (syslog_ident && cJSON_IsString(syslog_ident)) {
        strncpy(g_config.syslog_ident, syslog_ident->valuestring, sizeof(g_config.syslog_ident) - 1);
        g_config.syslog_ident[sizeof(g_config.syslog_ident) - 1] = '\0';
        settings_changed = true;
        log_info("Updated syslog_ident: %s", g_config.syslog_ident);
    }

    // Syslog facility
    cJSON *syslog_facility = cJSON_GetObjectItem(settings, "syslog_facility");
    if (syslog_facility && cJSON_IsString(syslog_facility)) {
        const char *val = syslog_facility->valuestring;
        if (strcmp(val, "LOG_DAEMON") == 0) g_config.syslog_facility = LOG_DAEMON;
        else if (strcmp(val, "LOG_LOCAL0") == 0) g_config.syslog_facility = LOG_LOCAL0;
        else if (strcmp(val, "LOG_LOCAL1") == 0) g_config.syslog_facility = LOG_LOCAL1;
        else if (strcmp(val, "LOG_LOCAL2") == 0) g_config.syslog_facility = LOG_LOCAL2;
        else if (strcmp(val, "LOG_LOCAL3") == 0) g_config.syslog_facility = LOG_LOCAL3;
        else if (strcmp(val, "LOG_LOCAL4") == 0) g_config.syslog_facility = LOG_LOCAL4;
        else if (strcmp(val, "LOG_LOCAL5") == 0) g_config.syslog_facility = LOG_LOCAL5;
        else if (strcmp(val, "LOG_LOCAL6") == 0) g_config.syslog_facility = LOG_LOCAL6;
        else if (strcmp(val, "LOG_LOCAL7") == 0) g_config.syslog_facility = LOG_LOCAL7;
        else g_config.syslog_facility = LOG_USER;
        settings_changed = true;
        log_info("Updated syslog_facility: %d", g_config.syslog_facility);
    }

    // Buffer size
    cJSON *buffer_size = cJSON_GetObjectItem(settings, "buffer_size");
    if (buffer_size && cJSON_IsNumber(buffer_size)) {
        g_config.buffer_size = buffer_size->valueint;
        settings_changed = true;
        log_info("Updated buffer_size: %d", g_config.buffer_size);
    }
    
    // Use swap
    cJSON *use_swap = cJSON_GetObjectItem(settings, "use_swap");
    if (use_swap && cJSON_IsBool(use_swap)) {
        g_config.use_swap = cJSON_IsTrue(use_swap);
        settings_changed = true;
        log_info("Updated use_swap: %s", g_config.use_swap ? "true" : "false");
    }
    
    // Swap size
    cJSON *swap_size = cJSON_GetObjectItem(settings, "swap_size");
    if (swap_size && cJSON_IsNumber(swap_size)) {
        g_config.swap_size = (uint64_t)swap_size->valueint * 1024 * 1024; // Convert MB to bytes
        settings_changed = true;
        log_info("Updated swap_size: %llu bytes", (unsigned long long)g_config.swap_size);
    }

    // Default detection threshold
    cJSON *default_detection_threshold = cJSON_GetObjectItem(settings, "default_detection_threshold");
    if (default_detection_threshold && cJSON_IsNumber(default_detection_threshold)) {
        int value = default_detection_threshold->valueint;
        // Clamp to valid range
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        g_config.default_detection_threshold = value;
        settings_changed = true;
        log_info("Updated default_detection_threshold: %d%%", g_config.default_detection_threshold);
    }

    // Pre-detection buffer (default for new streams)
    cJSON *pre_detection_buffer = cJSON_GetObjectItem(settings, "pre_detection_buffer");
    if (pre_detection_buffer && cJSON_IsNumber(pre_detection_buffer)) {
        int value = pre_detection_buffer->valueint;
        // Clamp to valid range
        if (value < 0) value = 0;
        if (value > 60) value = 60;
        g_config.default_pre_detection_buffer = value;
        settings_changed = true;
        log_info("Updated default_pre_detection_buffer: %d seconds", g_config.default_pre_detection_buffer);
    }

    // Post-detection buffer (default for new streams)
    cJSON *post_detection_buffer = cJSON_GetObjectItem(settings, "post_detection_buffer");
    if (post_detection_buffer && cJSON_IsNumber(post_detection_buffer)) {
        int value = post_detection_buffer->valueint;
        // Clamp to valid range
        if (value < 0) value = 0;
        if (value > 300) value = 300;
        g_config.default_post_detection_buffer = value;
        settings_changed = true;
        log_info("Updated default_post_detection_buffer: %d seconds", g_config.default_post_detection_buffer);
    }

    // Buffer strategy (default for new streams)
    cJSON *buffer_strategy = cJSON_GetObjectItem(settings, "buffer_strategy");
    if (buffer_strategy && cJSON_IsString(buffer_strategy)) {
        strncpy(g_config.default_buffer_strategy, buffer_strategy->valuestring, sizeof(g_config.default_buffer_strategy) - 1);
        g_config.default_buffer_strategy[sizeof(g_config.default_buffer_strategy) - 1] = '\0';
        settings_changed = true;
        log_info("Updated default_buffer_strategy: %s", g_config.default_buffer_strategy);
    }

    // API detection URL
    cJSON *api_detection_url = cJSON_GetObjectItem(settings, "api_detection_url");
    if (api_detection_url && cJSON_IsString(api_detection_url)) {
        strncpy(g_config.api_detection_url, api_detection_url->valuestring, sizeof(g_config.api_detection_url) - 1);
        g_config.api_detection_url[sizeof(g_config.api_detection_url) - 1] = '\0';
        settings_changed = true;
        log_info("Updated api_detection_url: %s", g_config.api_detection_url);
    }

    // API detection backend
    cJSON *api_detection_backend = cJSON_GetObjectItem(settings, "api_detection_backend");
    if (api_detection_backend && cJSON_IsString(api_detection_backend)) {
        strncpy(g_config.api_detection_backend, api_detection_backend->valuestring, sizeof(g_config.api_detection_backend) - 1);
        g_config.api_detection_backend[sizeof(g_config.api_detection_backend) - 1] = '\0';
        settings_changed = true;
        log_info("Updated api_detection_backend: %s", g_config.api_detection_backend);
    }

    // go2rtc settings
    cJSON *go2rtc_enabled = cJSON_GetObjectItem(settings, "go2rtc_enabled");
    if (go2rtc_enabled && cJSON_IsBool(go2rtc_enabled)) {
        bool old_go2rtc_enabled = g_config.go2rtc_enabled;
        g_config.go2rtc_enabled = cJSON_IsTrue(go2rtc_enabled);
        settings_changed = true;
        log_info("Updated go2rtc_enabled: %s", g_config.go2rtc_enabled ? "true" : "false");

        // If go2rtc_enabled changed, we need to start/stop go2rtc
        if (old_go2rtc_enabled != g_config.go2rtc_enabled) {
            go2rtc_config_changed = true;
            go2rtc_becoming_enabled = g_config.go2rtc_enabled;
            log_info("go2rtc_enabled setting changed from %s to %s",
                    old_go2rtc_enabled ? "true" : "false",
                    g_config.go2rtc_enabled ? "true" : "false");
        }
    }

    cJSON *go2rtc_binary_path = cJSON_GetObjectItem(settings, "go2rtc_binary_path");
    if (go2rtc_binary_path && cJSON_IsString(go2rtc_binary_path)) {
        strncpy(g_config.go2rtc_binary_path, go2rtc_binary_path->valuestring, sizeof(g_config.go2rtc_binary_path) - 1);
        g_config.go2rtc_binary_path[sizeof(g_config.go2rtc_binary_path) - 1] = '\0';
        settings_changed = true;
        log_info("Updated go2rtc_binary_path: %s", g_config.go2rtc_binary_path);
    }

    cJSON *go2rtc_config_dir = cJSON_GetObjectItem(settings, "go2rtc_config_dir");
    if (go2rtc_config_dir && cJSON_IsString(go2rtc_config_dir)) {
        strncpy(g_config.go2rtc_config_dir, go2rtc_config_dir->valuestring, sizeof(g_config.go2rtc_config_dir) - 1);
        g_config.go2rtc_config_dir[sizeof(g_config.go2rtc_config_dir) - 1] = '\0';
        settings_changed = true;
        log_info("Updated go2rtc_config_dir: %s", g_config.go2rtc_config_dir);
    }

    cJSON *go2rtc_api_port = cJSON_GetObjectItem(settings, "go2rtc_api_port");
    if (go2rtc_api_port && cJSON_IsNumber(go2rtc_api_port)) {
        g_config.go2rtc_api_port = go2rtc_api_port->valueint;
        settings_changed = true;
        log_info("Updated go2rtc_api_port: %d", g_config.go2rtc_api_port);
    }

    cJSON *go2rtc_rtsp_port = cJSON_GetObjectItem(settings, "go2rtc_rtsp_port");
    if (go2rtc_rtsp_port && cJSON_IsNumber(go2rtc_rtsp_port)) {
        g_config.go2rtc_rtsp_port = go2rtc_rtsp_port->valueint;
        settings_changed = true;
        log_info("Updated go2rtc_rtsp_port: %d", g_config.go2rtc_rtsp_port);
    }

    cJSON *go2rtc_webrtc_enabled = cJSON_GetObjectItem(settings, "go2rtc_webrtc_enabled");
    if (go2rtc_webrtc_enabled && cJSON_IsBool(go2rtc_webrtc_enabled)) {
        g_config.go2rtc_webrtc_enabled = cJSON_IsTrue(go2rtc_webrtc_enabled);
        settings_changed = true;
        log_info("Updated go2rtc_webrtc_enabled: %s", g_config.go2rtc_webrtc_enabled ? "true" : "false");
    }

    cJSON *go2rtc_webrtc_listen_port = cJSON_GetObjectItem(settings, "go2rtc_webrtc_listen_port");
    if (go2rtc_webrtc_listen_port && cJSON_IsNumber(go2rtc_webrtc_listen_port)) {
        g_config.go2rtc_webrtc_listen_port = go2rtc_webrtc_listen_port->valueint;
        settings_changed = true;
        log_info("Updated go2rtc_webrtc_listen_port: %d", g_config.go2rtc_webrtc_listen_port);
    }

    cJSON *go2rtc_stun_enabled = cJSON_GetObjectItem(settings, "go2rtc_stun_enabled");
    if (go2rtc_stun_enabled && cJSON_IsBool(go2rtc_stun_enabled)) {
        g_config.go2rtc_stun_enabled = cJSON_IsTrue(go2rtc_stun_enabled);
        settings_changed = true;
        log_info("Updated go2rtc_stun_enabled: %s", g_config.go2rtc_stun_enabled ? "true" : "false");
    }

    cJSON *go2rtc_stun_server = cJSON_GetObjectItem(settings, "go2rtc_stun_server");
    if (go2rtc_stun_server && cJSON_IsString(go2rtc_stun_server)) {
        strncpy(g_config.go2rtc_stun_server, go2rtc_stun_server->valuestring, sizeof(g_config.go2rtc_stun_server) - 1);
        g_config.go2rtc_stun_server[sizeof(g_config.go2rtc_stun_server) - 1] = '\0';
        settings_changed = true;
        log_info("Updated go2rtc_stun_server: %s", g_config.go2rtc_stun_server);
    }

    cJSON *go2rtc_external_ip = cJSON_GetObjectItem(settings, "go2rtc_external_ip");
    if (go2rtc_external_ip && cJSON_IsString(go2rtc_external_ip)) {
        strncpy(g_config.go2rtc_external_ip, go2rtc_external_ip->valuestring, sizeof(g_config.go2rtc_external_ip) - 1);
        g_config.go2rtc_external_ip[sizeof(g_config.go2rtc_external_ip) - 1] = '\0';
        settings_changed = true;
        log_info("Updated go2rtc_external_ip: %s", g_config.go2rtc_external_ip);
    }

    cJSON *go2rtc_ice_servers = cJSON_GetObjectItem(settings, "go2rtc_ice_servers");
    if (go2rtc_ice_servers && cJSON_IsString(go2rtc_ice_servers)) {
        strncpy(g_config.go2rtc_ice_servers, go2rtc_ice_servers->valuestring, sizeof(g_config.go2rtc_ice_servers) - 1);
        g_config.go2rtc_ice_servers[sizeof(g_config.go2rtc_ice_servers) - 1] = '\0';
        settings_changed = true;
        log_info("Updated go2rtc_ice_servers: %s", g_config.go2rtc_ice_servers);
    }

    cJSON *go2rtc_force_native_hls = cJSON_GetObjectItem(settings, "go2rtc_force_native_hls");
    if (go2rtc_force_native_hls && cJSON_IsBool(go2rtc_force_native_hls)) {
        g_config.go2rtc_force_native_hls = cJSON_IsTrue(go2rtc_force_native_hls);
        settings_changed = true;
        log_info("Updated go2rtc_force_native_hls: %s", g_config.go2rtc_force_native_hls ? "true" : "false");
    }

    // MQTT enabled
    cJSON *mqtt_enabled = cJSON_GetObjectItem(settings, "mqtt_enabled");
    if (mqtt_enabled && cJSON_IsBool(mqtt_enabled)) {
        g_config.mqtt_enabled = cJSON_IsTrue(mqtt_enabled);
        settings_changed = true;
        log_info("Updated mqtt_enabled: %s", g_config.mqtt_enabled ? "true" : "false");
    }

    // MQTT broker host
    cJSON *mqtt_broker_host = cJSON_GetObjectItem(settings, "mqtt_broker_host");
    if (mqtt_broker_host && cJSON_IsString(mqtt_broker_host)) {
        strncpy(g_config.mqtt_broker_host, mqtt_broker_host->valuestring, sizeof(g_config.mqtt_broker_host) - 1);
        g_config.mqtt_broker_host[sizeof(g_config.mqtt_broker_host) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_broker_host: %s", g_config.mqtt_broker_host);
    }

    // MQTT broker port
    cJSON *mqtt_broker_port = cJSON_GetObjectItem(settings, "mqtt_broker_port");
    if (mqtt_broker_port && cJSON_IsNumber(mqtt_broker_port)) {
        g_config.mqtt_broker_port = mqtt_broker_port->valueint;
        settings_changed = true;
        log_info("Updated mqtt_broker_port: %d", g_config.mqtt_broker_port);
    }

    // MQTT username
    cJSON *mqtt_username = cJSON_GetObjectItem(settings, "mqtt_username");
    if (mqtt_username && cJSON_IsString(mqtt_username)) {
        strncpy(g_config.mqtt_username, mqtt_username->valuestring, sizeof(g_config.mqtt_username) - 1);
        g_config.mqtt_username[sizeof(g_config.mqtt_username) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_username: %s", g_config.mqtt_username);
    }

    // MQTT password (only update if not masked)
    cJSON *mqtt_password = cJSON_GetObjectItem(settings, "mqtt_password");
    if (mqtt_password && cJSON_IsString(mqtt_password) && strcmp(mqtt_password->valuestring, "********") != 0) {
        strncpy(g_config.mqtt_password, mqtt_password->valuestring, sizeof(g_config.mqtt_password) - 1);
        g_config.mqtt_password[sizeof(g_config.mqtt_password) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_password");
    }

    // MQTT client ID
    cJSON *mqtt_client_id = cJSON_GetObjectItem(settings, "mqtt_client_id");
    if (mqtt_client_id && cJSON_IsString(mqtt_client_id)) {
        strncpy(g_config.mqtt_client_id, mqtt_client_id->valuestring, sizeof(g_config.mqtt_client_id) - 1);
        g_config.mqtt_client_id[sizeof(g_config.mqtt_client_id) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_client_id: %s", g_config.mqtt_client_id);
    }

    // MQTT topic prefix
    cJSON *mqtt_topic_prefix = cJSON_GetObjectItem(settings, "mqtt_topic_prefix");
    if (mqtt_topic_prefix && cJSON_IsString(mqtt_topic_prefix)) {
        strncpy(g_config.mqtt_topic_prefix, mqtt_topic_prefix->valuestring, sizeof(g_config.mqtt_topic_prefix) - 1);
        g_config.mqtt_topic_prefix[sizeof(g_config.mqtt_topic_prefix) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_topic_prefix: %s", g_config.mqtt_topic_prefix);
    }

    // MQTT TLS enabled
    cJSON *mqtt_tls_enabled = cJSON_GetObjectItem(settings, "mqtt_tls_enabled");
    if (mqtt_tls_enabled && cJSON_IsBool(mqtt_tls_enabled)) {
        g_config.mqtt_tls_enabled = cJSON_IsTrue(mqtt_tls_enabled);
        settings_changed = true;
        log_info("Updated mqtt_tls_enabled: %s", g_config.mqtt_tls_enabled ? "true" : "false");
    }

    // MQTT keepalive
    cJSON *mqtt_keepalive = cJSON_GetObjectItem(settings, "mqtt_keepalive");
    if (mqtt_keepalive && cJSON_IsNumber(mqtt_keepalive)) {
        g_config.mqtt_keepalive = mqtt_keepalive->valueint;
        settings_changed = true;
        log_info("Updated mqtt_keepalive: %d", g_config.mqtt_keepalive);
    }

    // MQTT QoS
    cJSON *mqtt_qos = cJSON_GetObjectItem(settings, "mqtt_qos");
    if (mqtt_qos && cJSON_IsNumber(mqtt_qos)) {
        int qos = mqtt_qos->valueint;
        if (qos < 0) qos = 0;
        if (qos > 2) qos = 2;
        g_config.mqtt_qos = qos;
        settings_changed = true;
        log_info("Updated mqtt_qos: %d", g_config.mqtt_qos);
    }

    // MQTT retain
    cJSON *mqtt_retain = cJSON_GetObjectItem(settings, "mqtt_retain");
    if (mqtt_retain && cJSON_IsBool(mqtt_retain)) {
        g_config.mqtt_retain = cJSON_IsTrue(mqtt_retain);
        settings_changed = true;
        log_info("Updated mqtt_retain: %s", g_config.mqtt_retain ? "true" : "false");
    }

    // MQTT HA discovery enabled
    cJSON *mqtt_ha_discovery = cJSON_GetObjectItem(settings, "mqtt_ha_discovery");
    if (mqtt_ha_discovery && cJSON_IsBool(mqtt_ha_discovery)) {
        g_config.mqtt_ha_discovery = cJSON_IsTrue(mqtt_ha_discovery);
        settings_changed = true;
        log_info("Updated mqtt_ha_discovery: %s", g_config.mqtt_ha_discovery ? "true" : "false");
    }

    // MQTT HA discovery prefix
    cJSON *mqtt_ha_discovery_prefix = cJSON_GetObjectItem(settings, "mqtt_ha_discovery_prefix");
    if (mqtt_ha_discovery_prefix && cJSON_IsString(mqtt_ha_discovery_prefix)) {
        strncpy(g_config.mqtt_ha_discovery_prefix, mqtt_ha_discovery_prefix->valuestring, sizeof(g_config.mqtt_ha_discovery_prefix) - 1);
        g_config.mqtt_ha_discovery_prefix[sizeof(g_config.mqtt_ha_discovery_prefix) - 1] = '\0';
        settings_changed = true;
        log_info("Updated mqtt_ha_discovery_prefix: %s", g_config.mqtt_ha_discovery_prefix);
    }

    // MQTT HA snapshot interval
    cJSON *mqtt_ha_snapshot_interval = cJSON_GetObjectItem(settings, "mqtt_ha_snapshot_interval");
    if (mqtt_ha_snapshot_interval && cJSON_IsNumber(mqtt_ha_snapshot_interval)) {
        int interval = mqtt_ha_snapshot_interval->valueint;
        if (interval < 0) interval = 0;
        if (interval > 300) interval = 300;
        g_config.mqtt_ha_snapshot_interval = interval;
        settings_changed = true;
        log_info("Updated mqtt_ha_snapshot_interval: %d", g_config.mqtt_ha_snapshot_interval);
    }

    // Detect if any MQTT setting actually changed
    if (old_mqtt_enabled != g_config.mqtt_enabled ||
        strcmp(old_mqtt_broker_host, g_config.mqtt_broker_host) != 0 ||
        old_mqtt_broker_port != g_config.mqtt_broker_port ||
        strcmp(old_mqtt_username, g_config.mqtt_username) != 0 ||
        strcmp(old_mqtt_password, g_config.mqtt_password) != 0 ||
        strcmp(old_mqtt_client_id, g_config.mqtt_client_id) != 0 ||
        strcmp(old_mqtt_topic_prefix, g_config.mqtt_topic_prefix) != 0 ||
        old_mqtt_tls_enabled != g_config.mqtt_tls_enabled ||
        old_mqtt_keepalive != g_config.mqtt_keepalive ||
        old_mqtt_qos != g_config.mqtt_qos ||
        old_mqtt_retain != g_config.mqtt_retain ||
        old_mqtt_ha_discovery != g_config.mqtt_ha_discovery ||
        strcmp(old_mqtt_ha_discovery_prefix, g_config.mqtt_ha_discovery_prefix) != 0 ||
        old_mqtt_ha_snapshot_interval != g_config.mqtt_ha_snapshot_interval) {
        mqtt_config_changed = true;
        log_info("MQTT settings changed, will reinitialize MQTT client");
    }

    // TURN server settings for WebRTC relay
    // Changes to TURN settings require go2rtc restart to regenerate config
    cJSON *turn_enabled = cJSON_GetObjectItem(settings, "turn_enabled");
    if (turn_enabled && cJSON_IsBool(turn_enabled)) {
        bool old_turn_enabled = g_config.turn_enabled;
        g_config.turn_enabled = cJSON_IsTrue(turn_enabled);
        settings_changed = true;
        log_info("Updated turn_enabled: %s", g_config.turn_enabled ? "true" : "false");
        if (old_turn_enabled != g_config.turn_enabled && g_config.go2rtc_enabled) {
            go2rtc_config_changed = true;
            go2rtc_becoming_enabled = true;  // Restart go2rtc to apply new TURN config
            log_info("TURN enabled setting changed, will restart go2rtc");
        }
    }

    cJSON *turn_server_url = cJSON_GetObjectItem(settings, "turn_server_url");
    if (turn_server_url && cJSON_IsString(turn_server_url)) {
        char old_turn_server_url[256];
        strncpy(old_turn_server_url, g_config.turn_server_url, sizeof(old_turn_server_url) - 1);
        old_turn_server_url[sizeof(old_turn_server_url) - 1] = '\0';
        strncpy(g_config.turn_server_url, turn_server_url->valuestring, sizeof(g_config.turn_server_url) - 1);
        g_config.turn_server_url[sizeof(g_config.turn_server_url) - 1] = '\0';
        settings_changed = true;
        log_info("Updated turn_server_url: %s", g_config.turn_server_url);
        if (strcmp(old_turn_server_url, g_config.turn_server_url) != 0 && g_config.go2rtc_enabled && g_config.turn_enabled) {
            go2rtc_config_changed = true;
            go2rtc_becoming_enabled = true;  // Restart go2rtc to apply new TURN config
            log_info("TURN server URL changed, will restart go2rtc");
        }
    }

    cJSON *turn_username = cJSON_GetObjectItem(settings, "turn_username");
    if (turn_username && cJSON_IsString(turn_username)) {
        char old_turn_username[128];
        strncpy(old_turn_username, g_config.turn_username, sizeof(old_turn_username) - 1);
        old_turn_username[sizeof(old_turn_username) - 1] = '\0';
        strncpy(g_config.turn_username, turn_username->valuestring, sizeof(g_config.turn_username) - 1);
        g_config.turn_username[sizeof(g_config.turn_username) - 1] = '\0';
        settings_changed = true;
        log_info("Updated turn_username: %s", g_config.turn_username);
        if (strcmp(old_turn_username, g_config.turn_username) != 0 && g_config.go2rtc_enabled && g_config.turn_enabled) {
            go2rtc_config_changed = true;
            go2rtc_becoming_enabled = true;  // Restart go2rtc to apply new TURN config
            log_info("TURN username changed, will restart go2rtc");
        }
    }

    cJSON *turn_password = cJSON_GetObjectItem(settings, "turn_password");
    if (turn_password && cJSON_IsString(turn_password)) {
        // Only update if not the masked value
        if (strcmp(turn_password->valuestring, "********") != 0) {
            char old_turn_password[128];
            strncpy(old_turn_password, g_config.turn_password, sizeof(old_turn_password) - 1);
            old_turn_password[sizeof(old_turn_password) - 1] = '\0';
            strncpy(g_config.turn_password, turn_password->valuestring, sizeof(g_config.turn_password) - 1);
            g_config.turn_password[sizeof(g_config.turn_password) - 1] = '\0';
            settings_changed = true;
            log_info("Updated turn_password");
            if (strcmp(old_turn_password, g_config.turn_password) != 0 && g_config.go2rtc_enabled && g_config.turn_enabled) {
                go2rtc_config_changed = true;
                go2rtc_becoming_enabled = true;  // Restart go2rtc to apply new TURN config
                log_info("TURN password changed, will restart go2rtc");
            }
        }
    }

    // ONVIF discovery enabled
    cJSON *onvif_discovery_enabled = cJSON_GetObjectItem(settings, "onvif_discovery_enabled");
    if (onvif_discovery_enabled && cJSON_IsBool(onvif_discovery_enabled)) {
        g_config.onvif_discovery_enabled = cJSON_IsTrue(onvif_discovery_enabled);
        settings_changed = true;
        log_info("Updated onvif_discovery_enabled: %s", g_config.onvif_discovery_enabled ? "true" : "false");
    }

    // ONVIF discovery interval
    cJSON *onvif_discovery_interval = cJSON_GetObjectItem(settings, "onvif_discovery_interval");
    if (onvif_discovery_interval && cJSON_IsNumber(onvif_discovery_interval)) {
        int value = onvif_discovery_interval->valueint;
        if (value < 30) value = 30;
        if (value > 3600) value = 3600;
        g_config.onvif_discovery_interval = value;
        settings_changed = true;
        log_info("Updated onvif_discovery_interval: %d", g_config.onvif_discovery_interval);
    }

    // ONVIF discovery network
    cJSON *onvif_discovery_network = cJSON_GetObjectItem(settings, "onvif_discovery_network");
    if (onvif_discovery_network && cJSON_IsString(onvif_discovery_network)) {
        strncpy(g_config.onvif_discovery_network, onvif_discovery_network->valuestring, sizeof(g_config.onvif_discovery_network) - 1);
        g_config.onvif_discovery_network[sizeof(g_config.onvif_discovery_network) - 1] = '\0';
        settings_changed = true;
        log_info("Updated onvif_discovery_network: %s", g_config.onvif_discovery_network);
    }

    // Device addresses the user removed from the discovery list. Written
    // verbatim to the ini file, so keep only address characters: a newline
    // or '=' here would corrupt the config.
    cJSON *onvif_discovery_ignored = cJSON_GetObjectItem(settings, "onvif_discovery_ignored");
    if (onvif_discovery_ignored && cJSON_IsString(onvif_discovery_ignored)) {
        size_t out = 0;
        for (const char *p = onvif_discovery_ignored->valuestring;
             *p && out < sizeof(g_config.onvif_discovery_ignored) - 1; p++) {
            if (isalnum((unsigned char)*p) || *p == '.' || *p == ':' || *p == ',' ||
                *p == '_' || *p == '-') {
                g_config.onvif_discovery_ignored[out++] = *p;
            }
        }
        g_config.onvif_discovery_ignored[out] = '\0';
        settings_changed = true;
        log_info("Updated onvif_discovery_ignored: %s", g_config.onvif_discovery_ignored);
    }

    // Most cameras on one Live View layout
    cJSON *live_layout_max_items = cJSON_GetObjectItem(settings, "live_layout_max_items");
    if (live_layout_max_items && cJSON_IsNumber(live_layout_max_items)) {
        int value = live_layout_max_items->valueint;
        if (value < 1 || value > LIVE_LAYOUT_MAX_ITEMS_LIMIT) {
            cJSON_Delete(settings);
            http_response_set_json_error(res, 400, "Cameras per layout must be between 1 and 144");
            return;
        }
        g_config.live_layout_max_items = value;
        settings_changed = true;
        log_info("Updated live_layout_max_items: %d", value);
    }

    cJSON *db_backup_interval_minutes = cJSON_GetObjectItem(settings, "db_backup_interval_minutes");
    if (db_backup_interval_minutes && cJSON_IsNumber(db_backup_interval_minutes)) {
        int value = db_backup_interval_minutes->valueint;
        if (value < 0) value = 0;
        g_config.db_backup_interval_minutes = value;
        settings_changed = true;
        log_info("Updated db_backup_interval_minutes: %d", g_config.db_backup_interval_minutes);
    }

    cJSON *db_backup_retention_count = cJSON_GetObjectItem(settings, "db_backup_retention_count");
    if (db_backup_retention_count && cJSON_IsNumber(db_backup_retention_count)) {
        int value = db_backup_retention_count->valueint;
        if (value < 0) value = 0;
        g_config.db_backup_retention_count = value;
        settings_changed = true;
        log_info("Updated db_backup_retention_count: %d", g_config.db_backup_retention_count);
    }

    cJSON *db_post_backup_script = cJSON_GetObjectItem(settings, "db_post_backup_script");
    if (db_post_backup_script && cJSON_IsString(db_post_backup_script)) {
        const char *script_path = db_post_backup_script->valuestring;
        if (script_path[0] != '\0' && !is_safe_storage_path(script_path)) {
            log_warn("Rejected unsafe db_post_backup_script: %s", script_path);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 400,
                "Invalid db_post_backup_script: must be an absolute path without shell metacharacters");
            return;
        }

        strncpy(g_config.db_post_backup_script, script_path, sizeof(g_config.db_post_backup_script) - 1);
        g_config.db_post_backup_script[sizeof(g_config.db_post_backup_script) - 1] = '\0';
        settings_changed = true;
        log_info("Updated db_post_backup_script: %s",
                 g_config.db_post_backup_script[0] ? g_config.db_post_backup_script : "(disabled)");
    }

    // Database path
    cJSON *db_path = cJSON_GetObjectItem(settings, "db_path");
    if (db_path && cJSON_IsString(db_path) && 
        strcmp(g_config.db_path, db_path->valuestring) != 0) {
        
        char old_db_path[MAX_PATH_LENGTH];
        strncpy(old_db_path, g_config.db_path, sizeof(old_db_path) - 1);
        old_db_path[sizeof(old_db_path) - 1] = '\0';
        
        // Update the config with the new path
        strncpy(g_config.db_path, db_path->valuestring, sizeof(g_config.db_path) - 1);
        g_config.db_path[sizeof(g_config.db_path) - 1] = '\0';
        settings_changed = true;
        log_info("Database path changed from %s to %s", old_db_path, g_config.db_path);
        
        // First, stop all HLS streams explicitly to ensure they're properly shut down
        log_info("Stopping all HLS streams before changing database path...");
        
        // Get a list of all active streams (heap-allocated; 256 * 256 B on stack is too large)
        char (*active_streams)[MAX_STREAM_NAME] = calloc(g_config.max_streams, MAX_STREAM_NAME);
        if (!active_streams) {
            log_error("handle_post_settings: out of memory for active_streams");
            cJSON_Delete(settings);
            http_response_set_json_error(res, 500, "Internal error");
            return;
        }
        int active_stream_count = 0;

        log_info("Scanning for active streams...");
        for (int i = 0; i < g_config.max_streams; i++) {
            log_info("Checking stream slot %d: name='%s', enabled=%d", 
                    i, g_config.streams[i].name, g_config.streams[i].enabled);
            
            if (g_config.streams[i].name[0] != '\0') {
                // Explicitly stop HLS streaming for all streams, even if they're not enabled
                log_info("Explicitly stopping HLS streaming for stream: %s", g_config.streams[i].name);
                stream_stop_hls(g_config.streams[i].name);
                
                // Only add enabled streams to the active list
                if (g_config.streams[i].enabled) {
                    // Copy the stream name for later use
                    strncpy(active_streams[active_stream_count], g_config.streams[i].name, MAX_STREAM_NAME - 1);
                    active_streams[active_stream_count][MAX_STREAM_NAME - 1] = '\0';
                    log_info("Added active stream %d: %s", active_stream_count, active_streams[active_stream_count]);
                    active_stream_count++;
                    
                    // Stop the stream
                    log_info("Stopping stream: %s", g_config.streams[i].name);
                    
                    // Get the stream handle
                    stream_handle_t stream = get_stream_by_name(g_config.streams[i].name);
                    if (stream) {
                        // Stop the stream
                        if (stop_stream(stream) == 0) {
                            log_info("Stream stopped: %s", g_config.streams[i].name);
                        } else {
                            log_warn("Failed to stop stream: %s", g_config.streams[i].name);
                        }
                    } else {
                        log_warn("Failed to get stream handle for: %s", g_config.streams[i].name);
                    }
                }
            }
        }
        
        log_info("Found %d active streams", active_stream_count);
        
        // Wait a bit to ensure all streams are fully stopped
        log_info("Waiting for streams to fully stop...");
        sleep(2);
        
        // We need to restart the database and stream manager
        log_info("Shutting down stream manager to change database path...");
        shutdown_stream_manager();
        
        log_info("Shutting down database...");
        shutdown_database();
        
        log_info("Initializing database with new path: %s", g_config.db_path);
        if (init_database(g_config.db_path) != 0) {
            log_error("Failed to initialize database with new path, reverting to old path");
            
            // Revert to the old path
            strncpy(g_config.db_path, old_db_path, sizeof(g_config.db_path) - 1);
            g_config.db_path[sizeof(g_config.db_path) - 1] = '\0';
            
            // Try to reinitialize with the old path
            if (init_database(g_config.db_path) != 0) {
                log_error("Failed to reinitialize database with old path, database may be unavailable");
            } else {
                log_info("Successfully reinitialized database with old path");
            }
            
            // Reinitialize stream manager
            if (init_stream_manager(g_config.max_streams) != 0) {
                log_error("Failed to reinitialize stream manager");
            } else {
                log_info("Successfully reinitialized stream manager");
            }

            // Send error response
            free(active_streams);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 500, "Failed to initialize database with new path");
            return;
        }

        log_info("Reinitializing stream manager...");
        if (init_stream_manager(g_config.max_streams) != 0) {
            log_error("Failed to reinitialize stream manager");

            // Send error response
            free(active_streams);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 500, "Failed to reinitialize stream manager");
            return;
        }
        
        // Restart streams from configuration
        log_info("Restarting streams from configuration...");
        
        // Restart all streams that were previously active
        log_info("Active stream count: %d", active_stream_count);
        for (int i = 0; i < active_stream_count; i++) {
            log_info("Processing active stream %d: %s", i, active_streams[i]);
            log_info("Restarting stream: %s", active_streams[i]);
            
            // Get the stream handle
            stream_handle_t stream = get_stream_by_name(active_streams[i]);
            if (stream) {
                // Get the stream configuration
                stream_config_t config;
                if (get_stream_config(stream, &config) != 0) {
                    log_error("Failed to get stream configuration for %s", active_streams[i]);
                    continue;
                }
                
                // Start the stream
                if (start_stream(stream) == 0) {
                    log_info("Stream restarted: %s", active_streams[i]);
                    
                    // Explicitly start HLS streaming if enabled
                    if (config.streaming_enabled) {
                        log_info("Starting HLS streaming for stream: %s", active_streams[i]);
                        
                        // Try multiple times to start HLS streaming
                        bool hls_started = false;
                        for (int retry = 0; retry < 3 && !hls_started; retry++) {
                            if (retry > 0) {
                                log_info("Retry %d starting HLS streaming for stream: %s", retry, active_streams[i]);
                                // Wait a bit before retrying
                                usleep(500000); // 500ms
                            }
                            
                            if (stream_start_hls(active_streams[i]) == 0) {
                                log_info("HLS streaming started for stream: %s", active_streams[i]);
                                hls_started = true;
                            } else {
                                log_warn("Failed to start HLS streaming for stream: %s (attempt %d/3)", 
                                        active_streams[i], retry + 1);
                            }
                        }
                        
                        if (!hls_started) {
                            log_error("Failed to start HLS streaming for stream: %s after multiple attempts", 
                                    active_streams[i]);
                        }
                    }
                } else {
                    log_warn("Failed to restart stream: %s", active_streams[i]);
                }
            } else {
                log_warn("Failed to get stream handle for: %s", active_streams[i]);
                
                // Try to find the stream configuration in the global config
                const stream_config_t *config = NULL;
                for (int j = 0; j < g_config.max_streams; j++) {
                    if (strcmp(g_config.streams[j].name, active_streams[i]) == 0) {
                        config = &g_config.streams[j];
                        break;
                    }
                }
                
                if (config) {
                    // Try to add the stream first
                    stream = add_stream(config);
                    if (stream) {
                        log_info("Added stream: %s", active_streams[i]);
                        
                        // Start the stream
                        if (start_stream(stream) == 0) {
                            log_info("Stream started: %s", active_streams[i]);
                            
                            // Explicitly start HLS streaming if enabled
                            if (config->streaming_enabled) {
                                log_info("Starting HLS streaming for stream: %s", active_streams[i]);
                                
                                // Try multiple times to start HLS streaming
                                bool hls_started = false;
                                for (int retry = 0; retry < 3 && !hls_started; retry++) {
                                    if (retry > 0) {
                                        log_info("Retry %d starting HLS streaming for stream: %s", retry, active_streams[i]);
                                        // Wait a bit before retrying
                                        usleep(500000); // 500ms
                                    }
                                    
                                    if (stream_start_hls(active_streams[i]) == 0) {
                                        log_info("HLS streaming started for stream: %s", active_streams[i]);
                                        hls_started = true;
                                    } else {
                                        log_warn("Failed to start HLS streaming for stream: %s (attempt %d/3)", 
                                                active_streams[i], retry + 1);
                                    }
                                }
                                
                                if (!hls_started) {
                                    log_error("Failed to start HLS streaming for stream: %s after multiple attempts", 
                                            active_streams[i]);
                                }
                            }
                        } else {
                            log_warn("Failed to start stream: %s", active_streams[i]);
                        }
                    } else {
                        log_error("Failed to add stream: %s", active_streams[i]);
                    }
                } else {
                    log_error("Failed to find configuration for stream: %s", active_streams[i]);
                }
            }
        }
        
        // Wait a bit to ensure all streams have time to start
        log_info("Waiting for streams to fully start...");
        sleep(2);
        
        // Force restart all HLS streams to ensure they're properly started
        log_info("Force restarting all HLS streams to ensure they're properly started...");
        for (int i = 0; i < active_stream_count; i++) {
            log_info("Force restarting HLS for active stream %d: %s", i, active_streams[i]);
            
            // Get the stream handle
            stream_handle_t stream = get_stream_by_name(active_streams[i]);
            if (stream) {
                // Get the stream configuration
                stream_config_t config;
                if (get_stream_config(stream, &config) != 0) {
                    log_error("Failed to get stream configuration for %s", active_streams[i]);
                    continue;
                }
                
                // Explicitly restart HLS streaming if enabled
                if (config.streaming_enabled) {
                    log_info("Force restarting HLS streaming for stream: %s", active_streams[i]);
                    
                    // First stop the HLS stream
                    if (stream_stop_hls(active_streams[i]) != 0) {
                        log_warn("Failed to stop HLS stream for restart: %s", active_streams[i]);
                    }

                    // Wait a bit to ensure the stream is fully stopped
                    usleep(500000); // 500ms

                    // Start the HLS stream again
                    if (stream_start_hls(active_streams[i]) == 0) {
                        log_info("HLS streaming force restarted for stream: %s", active_streams[i]);
                    } else {
                        log_warn("Failed to force restart HLS streaming for stream: %s", active_streams[i]);
                    }
                } else {
                    log_warn("Streaming not enabled for stream: %s", active_streams[i]);
                }
            } else {
                log_warn("Failed to get stream handle for force restart: %s", active_streams[i]);
            }
        }
        
        // Always start all streams from the database after changing the database path
        log_info("Starting all streams from the database after changing database path...");
        
        // Get all stream configurations from the database (heap-allocated)
        stream_config_t *db_streams = calloc(g_config.max_streams, sizeof(stream_config_t));
        if (!db_streams) {
            log_error("handle_post_settings: out of memory for db_streams");
            free(active_streams);
            cJSON_Delete(settings);
            http_response_set_json_error(res, 500, "Internal error");
            return;
        }
        int count = get_all_stream_configs(db_streams, g_config.max_streams);
        
        if (count > 0) {
            log_info("Found %d streams in the database", count);
            
            // Start each stream
            for (int i = 0; i < count; i++) {
                if (db_streams[i].name[0] != '\0' && db_streams[i].enabled) {
                    log_info("Starting stream from database: %s (streaming_enabled=%d)", 
                            db_streams[i].name, db_streams[i].streaming_enabled);
                    
                    // Add the stream
                    stream_handle_t stream = add_stream(&db_streams[i]);
                    if (stream) {
                        log_info("Added stream from database: %s", db_streams[i].name);
                        
                        // Start the stream
                        if (start_stream(stream) == 0) {
                            log_info("Started stream from database: %s", db_streams[i].name);
                            
                            // Explicitly start HLS streaming if enabled
                            if (db_streams[i].streaming_enabled) {
                                log_info("Starting HLS streaming for database stream: %s", db_streams[i].name);
                                
                                // Try multiple times to start HLS streaming
                                bool hls_started = false;
                                for (int retry = 0; retry < 3 && !hls_started; retry++) {
                                    if (retry > 0) {
                                        log_info("Retry %d starting HLS streaming for database stream: %s", 
                                                retry, db_streams[i].name);
                                        // Wait a bit before retrying
                                        usleep(500000); // 500ms
                                    }
                                    
                                    if (stream_start_hls(db_streams[i].name) == 0) {
                                        log_info("HLS streaming started for database stream: %s", db_streams[i].name);
                                        hls_started = true;
                                    } else {
                                        log_warn("Failed to start HLS streaming for database stream: %s (attempt %d/3)", 
                                                db_streams[i].name, retry + 1);
                                    }
                                }
                                
                                if (!hls_started) {
                                    log_error("Failed to start HLS streaming for database stream: %s after multiple attempts", 
                                            db_streams[i].name);
                                }
                            } else {
                                log_warn("HLS streaming not enabled for database stream: %s", db_streams[i].name);
                            }
                        } else {
                            log_warn("Failed to start stream from database: %s", db_streams[i].name);
                        }
                    } else {
                        log_error("Failed to add stream from database: %s", db_streams[i].name);
                    }
                }
            }
            
            // Wait a bit to ensure all streams have time to start
            log_info("Waiting for database streams to fully start...");
            sleep(2);
            
            // Force restart all HLS streams to ensure they're properly started
            log_info("Force restarting all HLS streams from database to ensure they're properly started...");
            for (int i = 0; i < count; i++) {
                if (db_streams[i].name[0] != '\0' && db_streams[i].enabled && db_streams[i].streaming_enabled) {
                    log_info("Force restarting HLS for database stream: %s", db_streams[i].name);
                    
                    // First stop the HLS stream
                    if (stream_stop_hls(db_streams[i].name) != 0) {
                        log_warn("Failed to stop HLS stream for restart: %s", db_streams[i].name);
                    }

                    // Wait a bit to ensure the stream is fully stopped
                    usleep(500000); // 500ms

                    // Start the HLS stream again
                    if (stream_start_hls(db_streams[i].name) == 0) {
                        log_info("HLS streaming force restarted for database stream: %s", db_streams[i].name);
                    } else {
                        log_warn("Failed to force restart HLS streaming for database stream: %s", db_streams[i].name);
                    }
                }
            }
        } else {
            log_warn("No streams found in the database");
        }
        free(db_streams);
        free(active_streams);

        log_info("Database path changed successfully");
    }

    if (storage_manager_changed) {
        if (set_max_storage_size(g_config.max_storage_size) != 0) {
            log_warn("Failed to update storage manager max storage size");
        } else {
            log_info("Runtime max storage size updated to %" PRIu64, g_config.max_storage_size);
        }

        if (set_retention_days(g_config.retention_days) != 0) {
            log_warn("Failed to update storage manager retention days");
        } else {
            log_info("Runtime retention days updated to %d", g_config.retention_days);
        }

        if (g_config.max_storage_size != old_max_storage_size ||
            g_config.retention_days != old_retention_days) {
            trigger_storage_cleanup(false);
            log_info("Triggered storage cleanup after storage policy change");
        }
    }

        // Save settings if changed
        if (settings_changed) {
            // Use the loaded config path - save_config will handle this automatically
            const char* config_path = get_loaded_config_path();
            log_info("Saving configuration to file: %s", config_path ? config_path : "default path");
            
            // Print the current database path to verify it's set correctly
            log_info("Current database path before saving: %s", g_config.db_path);
            
            // Save to the specific config file path if available
            int save_result;
            if (config_path) {
                save_result = save_config(&g_config, config_path);
            } else {
                save_result = save_config(&g_config, NULL);
            }
            
            if (save_result != 0) {
                log_error("Failed to save configuration, error code: %d", save_result);
                cJSON_Delete(settings);
                http_response_set_json_error(res, 500, "Failed to save configuration");
                return;
            }
            
            log_info("Configuration saved successfully");

            // Reload the configuration to ensure changes are applied
            log_info("Reloading configuration after save");
            if (reload_config(&g_config) != 0) {
                log_warn("Failed to reload configuration after save, changes may not be applied until restart");
            } else {
                log_info("Configuration reloaded successfully");

                // Verify the database path after reload
                log_info("Database path after reload: %s", g_config.db_path);
            }

            // If go2rtc-related settings changed, spawn background thread
            // to handle start/stop (avoids blocking the API response for 5-15+ seconds)
            if (go2rtc_config_changed) {
                go2rtc_settings_task_t *task = calloc(1, sizeof(go2rtc_settings_task_t));
                if (task) {
                    task->becoming_enabled = go2rtc_becoming_enabled;

                    pthread_t thread_id;
                    pthread_attr_t attr;
                    pthread_attr_init(&attr);
                    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

                    if (pthread_create(&thread_id, &attr,
                                       (void *(*)(void *))go2rtc_settings_worker, task) != 0) {
                        log_error("Failed to create go2rtc settings worker thread");
                        free(task);
                    } else {
                        log_info("go2rtc settings change dispatched to background thread (becoming_%s)",
                                 go2rtc_becoming_enabled ? "enabled" : "disabled");
                    }
                    pthread_attr_destroy(&attr);
                } else {
                    log_error("Failed to allocate go2rtc settings task");
                }
            }

            // If MQTT-related settings changed, spawn background thread
            // to handle cleanup + reinit (avoids blocking the API response)
            if (mqtt_config_changed) {
                mqtt_settings_task_t *task = calloc(1, sizeof(mqtt_settings_task_t));
                if (task) {
                    task->mqtt_now_enabled = g_config.mqtt_enabled;

                    pthread_t thread_id;
                    pthread_attr_t attr;
                    pthread_attr_init(&attr);
                    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

                    if (pthread_create(&thread_id, &attr,
                                       (void *(*)(void *))mqtt_settings_worker, task) != 0) {
                        log_error("Failed to create MQTT settings worker thread");
                        free(task);
                    } else {
                        log_info("MQTT settings change dispatched to background thread");
                    }
                    pthread_attr_destroy(&attr);
                } else {
                    log_error("Failed to allocate MQTT settings task");
                }
            }
        } else {
            log_info("No settings changed");
        }
    
    // Clean up
    cJSON_Delete(settings);
    
    // Create success response using cJSON
    cJSON *success = cJSON_CreateObject();
    if (!success) {
        log_error("Failed to create success JSON object");
        http_response_set_json_error(res, 500, "Failed to create success JSON");
        return;
    }
    
    cJSON_AddBoolToObject(success, "success", true);
    cJSON_AddBoolToObject(success, "restart_required", restart_required);

    if (restart_required) {
        if (web_thread_pool_restart_required) {
            cJSON_AddStringToObject(success, "restart_required_message",
                                    "Worker thread pool size was saved, but LightNVR must be restarted before the new thread pool takes effect.");
        }
    }
    
    // Convert to string
    char *json_str = cJSON_PrintUnformatted(success);
    if (!json_str) {
        log_error("Failed to convert success JSON to string");
        cJSON_Delete(success);
        http_response_set_json_error(res, 500, "Failed to convert success JSON to string");
        return;
    }
    
    // Send response
    http_response_set_json(res, 200, json_str);
    
    // Clean up
    free(json_str);
    cJSON_Delete(success);
    
    log_info("Successfully handled POST /api/settings request");
}

/* ---------------------------------------------------------------------------
 * Layout background image (Nx Witness style map/plan behind the cameras)
 *
 * GET    /api/live-layouts/<id>/background   the picture (owner, shared users, admins)
 * POST   /api/live-layouts/<id>/background   raw JPEG/PNG/WebP body, at most 1 MB (owner)
 * DELETE /api/live-layouts/<id>/background   remove it (owner)
 * ------------------------------------------------------------------------ */

#define LIVE_LAYOUT_BACKGROUND_MAX_BYTES (1024 * 1024)

static bool get_layout_id_from_background_path(const http_request_t *req, char *layout_id, size_t size) {
    char param[LIVE_LAYOUT_ID_MAX_LEN + 32] = {0};
    if (http_request_extract_path_param(req, "/api/live-layouts/", param, sizeof(param)) != 0) return false;
    char *slash = strchr(param, '/');
    if (slash) *slash = '\0';
    snprintf(layout_id, size, "%s", param);
    return is_valid_layout_id(layout_id);
}

static void live_layout_background_path(const char *layout_id, char *path, size_t size) {
    snprintf(path, size, "%s/layout-backgrounds/%s.img", g_config.storage_path, layout_id);
}

static cJSON *load_stored_live_layouts(void) {
    char *layouts_json = calloc(1, LIVE_LAYOUTS_MAX_BYTES);
    cJSON *stored = NULL;
    if (layouts_json && db_get_system_setting(LIVE_LAYOUTS_SETTING_KEY, layouts_json, LIVE_LAYOUTS_MAX_BYTES) == 0 &&
        layouts_json[0] != '\0') {
        stored = cJSON_Parse(layouts_json);
    }
    free(layouts_json);
    return stored;
}

static const char *sniff_image_type(const unsigned char *data, size_t len) {
    if (len >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) return "image/jpeg";
    if (len >= 8 && memcmp(data, "\x89PNG\r\n\x1a\n", 8) == 0) return "image/png";
    if (len >= 12 && memcmp(data, "RIFF", 4) == 0 && memcmp(data + 8, "WEBP", 4) == 0) return "image/webp";
    return NULL;
}

void handle_get_live_layout_background(const http_request_t *req, http_response_t *res) {
    user_t user;
    if (!httpd_check_viewer_access(req, &user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return;
    }
    char layout_id[LIVE_LAYOUT_ID_MAX_LEN + 1];
    if (!get_layout_id_from_background_path(req, layout_id, sizeof(layout_id))) {
        http_response_set_json_error(res, 400, "Invalid layout id");
        return;
    }
    cJSON *stored = load_stored_live_layouts();
    cJSON *layout = stored ? find_live_layout_by_id(cJSON_GetObjectItem(stored, "layouts"), layout_id) : NULL;
    bool allowed = layout && (get_live_layout_user_id(layout) == user.id || user.role == USER_ROLE_ADMIN ||
                              live_layout_shared_with(layout, user.id));
    cJSON_Delete(stored);
    if (!allowed) {
        http_response_set_json_error(res, 404, "Layout not found");
        return;
    }

    char path[MAX_PATH_LENGTH];
    live_layout_background_path(layout_id, path, sizeof(path));
    FILE *file = fopen(path, "rb");
    unsigned char head[16] = {0};
    size_t head_len = file ? fread(head, 1, sizeof(head), file) : 0;
    if (file) fclose(file);
    const char *type = sniff_image_type(head, head_len);
    if (!type) {
        http_response_set_json_error(res, 404, "This layout has no background");
        return;
    }
    if (http_serve_file(req, res, path, type, "Cache-Control: private, max-age=86400\r\n") != 0) {
        http_response_set_json_error(res, 500, "Failed to send the background");
    }
}

// Load layouts, find one the user owns; on failure sets the response and returns NULL
static cJSON *load_owned_layout_for_background(const http_request_t *req, http_response_t *res, user_t *user,
                                               char *layout_id, size_t id_size, cJSON **stored_out) {
    if (!httpd_check_viewer_access(req, user)) {
        http_response_set_json_error(res, 401, "Unauthorized");
        return NULL;
    }
    if (!get_layout_id_from_background_path(req, layout_id, id_size)) {
        http_response_set_json_error(res, 400, "Invalid layout id");
        return NULL;
    }
    cJSON *stored = load_stored_live_layouts();
    cJSON *layout = stored ? find_live_layout_by_id(cJSON_GetObjectItem(stored, "layouts"), layout_id) : NULL;
    int64_t owner = layout ? get_live_layout_user_id(layout) : LIVE_LAYOUT_UNOWNED_USER_ID;
    if (!layout || (owner != user->id && !(owner == LIVE_LAYOUT_UNOWNED_USER_ID && user->role == USER_ROLE_ADMIN))) {
        cJSON_Delete(stored);
        http_response_set_json_error(res, 404, "Layout not found");
        return NULL;
    }
    if (cJSON_IsTrue(cJSON_GetObjectItem(layout, "locked"))) {
        cJSON_Delete(stored);
        http_response_set_json_error(res, 409, "This layout is locked. Unlock it before changing its background.");
        return NULL;
    }
    *stored_out = stored;
    return layout;
}

static void respond_with_layout_background(http_response_t *res, cJSON *stored, cJSON *layout) {
    char *json = cJSON_PrintUnformatted(stored);
    if (!json || db_set_system_setting(LIVE_LAYOUTS_SETTING_KEY, json) != 0) {
        free(json);
        http_response_set_json_error(res, 500, "Failed to save the layout");
        return;
    }
    free(json);
    cJSON *background = cJSON_GetObjectItem(layout, "background");
    cJSON *reply = cJSON_CreateObject();
    cJSON_AddItemToObject(reply, "background", background ? cJSON_Duplicate(background, true) : cJSON_CreateNull());
    char *reply_json = cJSON_PrintUnformatted(reply);
    cJSON_Delete(reply);
    http_response_set_json(res, 200, reply_json ? reply_json : "{}");
    free(reply_json);
}

void handle_post_live_layout_background(const http_request_t *req, http_response_t *res) {
    user_t user;
    char layout_id[LIVE_LAYOUT_ID_MAX_LEN + 1];
    cJSON *stored = NULL;
    cJSON *layout = load_owned_layout_for_background(req, res, &user, layout_id, sizeof(layout_id), &stored);
    if (!layout) return;

    if (!req->body || req->body_len == 0 || req->body_len > LIVE_LAYOUT_BACKGROUND_MAX_BYTES ||
        !sniff_image_type(req->body, req->body_len)) {
        cJSON_Delete(stored);
        http_response_set_json_error(res, 400, "Send a JPEG, PNG or WebP picture of at most 1 MB");
        return;
    }

    char dir[MAX_PATH_LENGTH];
    snprintf(dir, sizeof(dir), "%s/layout-backgrounds", g_config.storage_path);
    mkdir(dir, 0755);
    char path[MAX_PATH_LENGTH];
    live_layout_background_path(layout_id, path, sizeof(path));
    FILE *file = fopen(path, "wb");
    bool written = file && fwrite(req->body, 1, req->body_len, file) == req->body_len;
    if (file) fclose(file);
    if (!written) {
        cJSON_Delete(stored);
        http_response_set_json_error(res, 500, "Failed to store the background");
        return;
    }

    cJSON *old_background = cJSON_GetObjectItem(layout, "background");
    const cJSON *old_opacity = cJSON_GetObjectItem(old_background, "opacity");
    double opacity = cJSON_IsNumber(old_opacity) ? old_opacity->valuedouble : 0.6;
    cJSON_DeleteItemFromObject(layout, "background");
    cJSON *background = cJSON_AddObjectToObject(layout, "background");
    cJSON_AddNumberToObject(background, "version", (double)time(NULL));
    cJSON_AddNumberToObject(background, "opacity", opacity);
    log_info("Layout %s background updated by %s (%zu bytes)", layout_id, user.username, req->body_len);
    respond_with_layout_background(res, stored, layout);
    cJSON_Delete(stored);
}

void handle_delete_live_layout_background(const http_request_t *req, http_response_t *res) {
    user_t user;
    char layout_id[LIVE_LAYOUT_ID_MAX_LEN + 1];
    cJSON *stored = NULL;
    cJSON *layout = load_owned_layout_for_background(req, res, &user, layout_id, sizeof(layout_id), &stored);
    if (!layout) return;

    char path[MAX_PATH_LENGTH];
    live_layout_background_path(layout_id, path, sizeof(path));
    unlink(path);
    cJSON_DeleteItemFromObject(layout, "background");
    log_info("Layout %s background removed by %s", layout_id, user.username);
    respond_with_layout_background(res, stored, layout);
    cJSON_Delete(stored);
}
