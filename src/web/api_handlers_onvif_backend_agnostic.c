#define _XOPEN_SOURCE
#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <pthread.h>

#include "web/api_handlers_onvif.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#define LOG_COMPONENT "ONVIFAPI"
#include "core/logger.h"
#include "core/config.h"
#include "core/url_utils.h"
#include "video/onvif_discovery.h"
#include "video/onvif_soap.h"
#include "video/stream_manager.h"
#include <cjson/cJSON.h>

static bool string_contains_case_insensitive(const char *haystack, const char *needle) {
    if (!haystack || !needle || needle[0] == '\0') {
        return false;
    }

    return strcasestr(haystack, needle) != NULL;
}

static bool onvif_device_hint_is_dahua_family(const char *manufacturer, const char *model) {
    return string_contains_case_insensitive(manufacturer, "dahua") ||
           string_contains_case_insensitive(model, "dahua") ||
           string_contains_case_insensitive(manufacturer, "amcrest") ||
           string_contains_case_insensitive(model, "amcrest") ||
           string_contains_case_insensitive(model, "networkvideotransmitter");
}

static bool rtsp_uri_uses_generic_live_path(const char *uri) {
    if (!uri) {
        return false;
    }

    const char *scheme = strstr(uri, "://");
    const char *path = scheme ? strpbrk(scheme + 3, "/?#") : NULL;
    if (!path) {
        return false;
    }

    return strncmp(path, "/live", 5) == 0 ||
           strncmp(path, "/stream", 7) == 0 ||
           strncmp(path, "/ch0_", 5) == 0;
}

static bool build_dahua_rtsp_uri_from_base(const char *source_uri,
                                           bool secondary,
                                           char *out_uri,
                                           size_t out_size) {
    char stripped_uri[MAX_URL_LENGTH];

    if (!source_uri || !out_uri || out_size == 0) {
        return false;
    }

    if (url_strip_credentials(source_uri, stripped_uri, sizeof(stripped_uri)) != 0) {
        snprintf(stripped_uri, sizeof(stripped_uri), "%s", source_uri);
    }

    const char *scheme = strstr(stripped_uri, "://");
    if (!scheme) {
        return false;
    }

    const char *authority_start = scheme + 3;
    const char *path_start = strpbrk(authority_start, "/?#");
    size_t base_len = path_start ? (size_t)(path_start - stripped_uri) : strlen(stripped_uri);
    int subtype = secondary ? 1 : 0;
    int written = snprintf(out_uri, out_size, "%.*s/cam/realmonitor?channel=1&subtype=%d",
                           (int)base_len, stripped_uri, subtype);
    return written > 0 && (size_t)written < out_size;
}

static void normalize_dahua_profile_stream_uri(const char *manufacturer,
                                               const char *model,
                                               bool secondary,
                                               char *stream_uri,
                                               size_t stream_uri_size) {
    if (!onvif_device_hint_is_dahua_family(manufacturer, model) ||
        !rtsp_uri_uses_generic_live_path(stream_uri)) {
        return;
    }

    char normalized_uri[MAX_URL_LENGTH];
    if (!build_dahua_rtsp_uri_from_base(stream_uri, secondary, normalized_uri, sizeof(normalized_uri))) {
        return;
    }

    snprintf(stream_uri, stream_uri_size, "%s", normalized_uri);
}

static double profile_rank_score(const onvif_profile_t *profile) {
    if (!profile) {
        return 0.0;
    }

    const double area = (double)((profile->width > 0 ? profile->width : 0) * (profile->height > 0 ? profile->height : 0));
    const double bitrate = (double)(profile->bitrate > 0 ? profile->bitrate : 0);
    const double fps = (double)(profile->fps > 0 ? profile->fps : 0);
    double score = area + (bitrate * 8.0) + (fps * 250.0);

    const bool primary_hint =
        string_contains_case_insensitive(profile->name, "main") ||
        string_contains_case_insensitive(profile->name, "primary") ||
        string_contains_case_insensitive(profile->name, "high") ||
        string_contains_case_insensitive(profile->name, "stream 1") ||
        string_contains_case_insensitive(profile->name, "stream1");
    const bool secondary_hint =
        string_contains_case_insensitive(profile->name, "sub") ||
        string_contains_case_insensitive(profile->name, "secondary") ||
        string_contains_case_insensitive(profile->name, "low") ||
        string_contains_case_insensitive(profile->name, "stream 2") ||
        string_contains_case_insensitive(profile->name, "stream2");

    if (primary_hint) {
        score += 100000000.0;
    }
    if (secondary_hint) {
        score -= 50000000.0;
    }

    return score;
}

static int compare_profile_rank_desc(const void *a, const void *b) {
    const onvif_profile_t *const *profile_a = (const onvif_profile_t *const *)a;
    const onvif_profile_t *const *profile_b = (const onvif_profile_t *const *)b;
    const double score_a = profile_rank_score(*profile_a);
    const double score_b = profile_rank_score(*profile_b);

    if (score_a > score_b) {
        return -1;
    }
    if (score_a < score_b) {
        return 1;
    }

    return strcmp((*profile_a)->name, (*profile_b)->name);
}

/**
 * @brief Backend-agnostic handler for GET /api/onvif/discovery/status
 */
void handle_get_onvif_discovery_status(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/onvif/discovery/status request");
    
    // Create JSON response
    cJSON *root = cJSON_CreateObject();
    if (!root) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }
    
    // Add discovery status
    cJSON_AddBoolToObject(root, "enabled", g_config.onvif_discovery_enabled);
    cJSON_AddStringToObject(root, "network", g_config.onvif_discovery_network);
    cJSON_AddNumberToObject(root, "interval", g_config.onvif_discovery_interval);
    
    // Convert to string
    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    
    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }
    
    // Send response
    http_response_set_json(res, 200, json_str);
    
    // Clean up
    free(json_str);
    
    log_info("Successfully handled GET /api/onvif/discovery/status request");
}

/**
 * @brief Backend-agnostic handler for GET /api/onvif/devices
 */
void handle_get_discovered_onvif_devices(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/onvif/devices request");
    
    // Get discovered devices
    onvif_device_info_t devices[32];
    int count = get_discovered_onvif_devices(devices, 32);
    
    if (count < 0) {
        log_error("Failed to get discovered ONVIF devices");
        http_response_set_json_error(res, 500, "Failed to get discovered ONVIF devices");
        return;
    }
    
    // Create JSON response
    cJSON *root = cJSON_CreateObject();
    if (!root) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }
    
    cJSON *devices_array = cJSON_AddArrayToObject(root, "devices");
    if (!devices_array) {
        log_error("Failed to create JSON response");
        cJSON_Delete(root);
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }
    
    // Add devices to array
    for (int i = 0; i < count; i++) {
        cJSON *device = cJSON_CreateObject();
        if (!device) {
            log_error("Failed to create JSON response");
            cJSON_Delete(root);
            http_response_set_json_error(res, 500, "Failed to create JSON response");
            return;
        }

        cJSON_AddStringToObject(device, "endpoint", devices[i].endpoint);
        cJSON_AddStringToObject(device, "device_service", devices[i].device_service);
        cJSON_AddStringToObject(device, "media_service", devices[i].media_service);
        cJSON_AddStringToObject(device, "ptz_service", devices[i].ptz_service);
        cJSON_AddStringToObject(device, "imaging_service", devices[i].imaging_service);
        cJSON_AddStringToObject(device, "manufacturer", devices[i].manufacturer);
        cJSON_AddStringToObject(device, "model", devices[i].model);
        cJSON_AddStringToObject(device, "firmware_version", devices[i].firmware_version);
        cJSON_AddStringToObject(device, "serial_number", devices[i].serial_number);
        cJSON_AddStringToObject(device, "hardware_id", devices[i].hardware_id);
        cJSON_AddStringToObject(device, "ip_address", devices[i].ip_address);
        cJSON_AddStringToObject(device, "mac_address", devices[i].mac_address);
        cJSON_AddNumberToObject(device, "discovery_time", (double)devices[i].discovery_time);
        cJSON_AddBoolToObject(device, "online", devices[i].online);

        cJSON_AddItemToArray(devices_array, device);
    }
    
    // Convert to string
    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    
    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }
    
    // Send response
    http_response_set_json(res, 200, json_str);
    
    // Clean up
    free(json_str);
    
    log_info("Successfully handled GET /api/onvif/devices request");
}

/**
 * @brief Backend-agnostic handler for POST /api/onvif/discovery/discover
 */
void handle_post_discover_onvif_devices(const http_request_t *req, http_response_t *res) {
    log_info("Handling POST /api/onvif/discovery/discover request");

    // Parse JSON request
    cJSON *root = httpd_parse_json_body(req);
    if (!root) {
        log_error("Invalid JSON request");
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    // Extract parameters
    cJSON *network_json = cJSON_GetObjectItem(root, "network");

    // Get network parameter (can be NULL for auto-detection)
    const char *network = NULL;
    if (network_json && cJSON_IsString(network_json)) {
        network = network_json->valuestring;

        // Check if network is "auto" or empty, which means auto-detect
        if (strcmp(network, "auto") == 0 || strlen(network) == 0) {
            network = NULL; // This will trigger auto-detection
        }
    }

    // If network is NULL, we'll use auto-detection
    if (!network) {
        log_info("Network parameter not provided or set to 'auto', will use auto-detection");
    }

    // Discover ONVIF devices
    onvif_device_info_t devices[32];
    int count = discover_onvif_devices(network, devices, 32);

    cJSON_Delete(root);

    if (count < 0) {
        log_error("Failed to discover ONVIF devices");
        http_response_set_json_error(res, 500, "Failed to discover ONVIF devices");
        return;
    }

    // Create JSON response
    cJSON *response_json = cJSON_CreateObject();
    if (!response_json) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    cJSON *devices_array = cJSON_AddArrayToObject(response_json, "devices");
    if (!devices_array) {
        log_error("Failed to create JSON response");
        cJSON_Delete(response_json);
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    // Add devices to array
    for (int i = 0; i < count; i++) {
        cJSON *device = cJSON_CreateObject();
        if (!device) {
            log_error("Failed to create JSON response");
            cJSON_Delete(response_json);
            http_response_set_json_error(res, 500, "Failed to create JSON response");
            return;
        }

        cJSON_AddStringToObject(device, "endpoint", devices[i].endpoint);
        cJSON_AddStringToObject(device, "device_service", devices[i].device_service);
        cJSON_AddStringToObject(device, "media_service", devices[i].media_service);
        cJSON_AddStringToObject(device, "ptz_service", devices[i].ptz_service);
        cJSON_AddStringToObject(device, "imaging_service", devices[i].imaging_service);
        cJSON_AddStringToObject(device, "manufacturer", devices[i].manufacturer);
        cJSON_AddStringToObject(device, "model", devices[i].model);
        cJSON_AddStringToObject(device, "firmware_version", devices[i].firmware_version);
        cJSON_AddStringToObject(device, "serial_number", devices[i].serial_number);
        cJSON_AddStringToObject(device, "hardware_id", devices[i].hardware_id);
        cJSON_AddStringToObject(device, "ip_address", devices[i].ip_address);
        cJSON_AddStringToObject(device, "mac_address", devices[i].mac_address);
        cJSON_AddNumberToObject(device, "discovery_time", (double)devices[i].discovery_time);
        cJSON_AddBoolToObject(device, "online", devices[i].online);

        cJSON_AddItemToArray(devices_array, device);
    }

    // Convert to string
    char *json_str = cJSON_PrintUnformatted(response_json);
    cJSON_Delete(response_json);

    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }

    // Send response
    http_response_set_json(res, 200, json_str);

    // Clean up
    free(json_str);

    log_info("Successfully handled POST /api/onvif/discovery/discover request");
}

/**
 * @brief Backend-agnostic handler for GET /api/onvif/device/profiles
 */
// If the camera answered the last ONVIF request with a SOAP fault, send the
// user a clear error for it and return true. A rejected login usually means
// the user is not in the camera's separate ONVIF user list.
static bool respond_with_onvif_fault(http_response_t *res) {
    const char *fault = onvif_get_last_fault();
    if (fault[0] == '\0') {
        return false;
    }
    char message[512];
    if (strcasestr(fault, "NotAuthorized") || strcasestr(fault, "not authorized")) {
        snprintf(message, sizeof(message),
                 "The camera rejected this username and password for ONVIF. Many cameras "
                 "(e.g. Axis, Hikvision) keep a separate list of ONVIF users: add this user "
                 "as an ONVIF user in the camera's settings, then try again.");
        // Not 401: the web UI treats 401 as an expired LightNVR session and logs out
        http_response_set_json_error(res, 422, message);
    } else {
        snprintf(message, sizeof(message), "The camera returned an ONVIF error: %s", fault);
        http_response_set_json_error(res, 502, message);
    }
    return true;
}

void handle_get_onvif_device_profiles(const http_request_t *req, http_response_t *res) {
    log_info("Handling GET /api/onvif/device/profiles request");

    // Get URL parameters from headers
    const char *device_url_param = http_request_get_header(req, "X-Device-URL");
    const char *username_param = http_request_get_header(req, "X-Username");
    const char *password_param = http_request_get_header(req, "X-Password");
    const char *manufacturer_param = http_request_get_header(req, "X-Device-Manufacturer");
    const char *model_param = http_request_get_header(req, "X-Device-Model");

    if (!device_url_param) {
        log_error("Missing device_url parameter");
        http_response_set_json_error(res, 400, "Missing device_url parameter");
        return;
    }

    // Extract parameters
    char device_url[MAX_URL_LENGTH];
    char username[64] = {0};
    char password[64] = {0};

    strncpy(device_url, device_url_param, sizeof(device_url) - 1);
    device_url[sizeof(device_url) - 1] = '\0';

    if (username_param) {
        strncpy(username, username_param, sizeof(username) - 1);
        username[sizeof(username) - 1] = '\0';
    }

    if (password_param) {
        strncpy(password, password_param, sizeof(password) - 1);
        password[sizeof(password) - 1] = '\0';
    }

    // Get device profiles
    onvif_profile_t profiles[16];
    onvif_clear_last_fault();
    int count = get_onvif_device_profiles(device_url,
                                         username[0] ? username : NULL,
                                         password[0] ? password : NULL,
                                         profiles, 16);

    if (count < 0) {
        log_error("Failed to get ONVIF device profiles");
        http_response_set_json_error(res, 500, "Failed to get ONVIF device profiles");
        return;
    }

    // No profiles because the camera refused the request: say why instead of
    // returning an empty list the UI cannot explain
    if (count == 0 && respond_with_onvif_fault(res)) {
        return;
    }

    // Create JSON response
    cJSON *root = cJSON_CreateObject();
    if (!root) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    cJSON *profiles_array = cJSON_AddArrayToObject(root, "profiles");
    if (!profiles_array) {
        log_error("Failed to create JSON response");
        cJSON_Delete(root);
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    const onvif_profile_t *ordered_profiles[16];
    for (int i = 0; i < count; i++) {
        ordered_profiles[i] = &profiles[i];
    }
    qsort(ordered_profiles, count, sizeof(ordered_profiles[0]), compare_profile_rank_desc);

    // Add profiles to array
    for (int i = 0; i < count; i++) {
        const onvif_profile_t *profile_info = ordered_profiles[i];
        cJSON *profile = cJSON_CreateObject();
        if (!profile) {
            log_error("Failed to create JSON response");
            cJSON_Delete(root);
            http_response_set_json_error(res, 500, "Failed to create JSON response");
            return;
        }

        cJSON_AddStringToObject(profile, "token", profile_info->token);
        cJSON_AddStringToObject(profile, "name", profile_info->name);
        char safe_snapshot_uri[MAX_URL_LENGTH];
        char safe_stream_uri[MAX_URL_LENGTH];
        char normalized_stream_uri[MAX_URL_LENGTH];

        snprintf(normalized_stream_uri, sizeof(normalized_stream_uri), "%s", profile_info->stream_uri);
        normalize_dahua_profile_stream_uri(manufacturer_param,
                                           model_param,
                                           i == 1,
                                           normalized_stream_uri,
                                           sizeof(normalized_stream_uri));

        if (url_strip_credentials(profile_info->snapshot_uri, safe_snapshot_uri, sizeof(safe_snapshot_uri)) != 0) {
            strncpy(safe_snapshot_uri, profile_info->snapshot_uri, sizeof(safe_snapshot_uri) - 1);
            safe_snapshot_uri[sizeof(safe_snapshot_uri) - 1] = '\0';
        }
        if (url_strip_credentials(normalized_stream_uri, safe_stream_uri, sizeof(safe_stream_uri)) != 0) {
            strncpy(safe_stream_uri, normalized_stream_uri, sizeof(safe_stream_uri) - 1);
            safe_stream_uri[sizeof(safe_stream_uri) - 1] = '\0';
        }

        cJSON_AddStringToObject(profile, "snapshot_uri", safe_snapshot_uri);
        cJSON_AddStringToObject(profile, "stream_uri", safe_stream_uri);
        cJSON_AddNumberToObject(profile, "width", profile_info->width);
        cJSON_AddNumberToObject(profile, "height", profile_info->height);
        cJSON_AddStringToObject(profile, "encoding", profile_info->encoding);
        cJSON_AddNumberToObject(profile, "fps", profile_info->fps);
        cJSON_AddNumberToObject(profile, "bitrate", profile_info->bitrate);
        cJSON_AddStringToObject(profile, "stream_role",
                                i == 0 ? "primary" : (i == 1 ? "secondary" : "additional"));

        cJSON_AddItemToArray(profiles_array, profile);
    }

    // Convert to string
    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }

    // Send response
    http_response_set_json(res, 200, json_str);

    // Clean up
    free(json_str);

    log_info("Successfully handled GET /api/onvif/device/profiles request");
}

/**
 * @brief Backend-agnostic handler for POST /api/onvif/device/add
 */
void handle_post_add_onvif_device_as_stream(const http_request_t *req, http_response_t *res) {
    log_info("Handling POST /api/onvif/device/add request");

    // Parse JSON request
    cJSON *root = httpd_parse_json_body(req);
    if (!root) {
        log_error("Invalid JSON request");
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    // Extract parameters
    cJSON *device_url_json = cJSON_GetObjectItem(root, "device_url");
    cJSON *profile_token_json = cJSON_GetObjectItem(root, "profile_token");
    cJSON *stream_name_json = cJSON_GetObjectItem(root, "stream_name");
    cJSON *username_json = cJSON_GetObjectItem(root, "username");
    cJSON *password_json = cJSON_GetObjectItem(root, "password");

    if (!device_url_json || !cJSON_IsString(device_url_json) ||
        !profile_token_json || !cJSON_IsString(profile_token_json) ||
        !stream_name_json || !cJSON_IsString(stream_name_json)) {
        cJSON_Delete(root);
        log_error("Missing or invalid parameters");
        http_response_set_json_error(res, 400, "Missing or invalid parameters");
        return;
    }

    const char *device_url = device_url_json->valuestring;
    const char *profile_token = profile_token_json->valuestring;
    const char *stream_name = stream_name_json->valuestring;
    const char *username = username_json && cJSON_IsString(username_json) ? username_json->valuestring : NULL;
    const char *password = password_json && cJSON_IsString(password_json) ? password_json->valuestring : NULL;

    // Validate parameters
    if (strlen(device_url) == 0 || strlen(profile_token) == 0 || strlen(stream_name) == 0) {
        cJSON_Delete(root);
        log_error("Invalid parameters");
        http_response_set_json_error(res, 400, "Invalid parameters");
        return;
    }

    // Get device profiles
    onvif_profile_t profiles[16];
    int count = get_onvif_device_profiles(device_url, username, password, profiles, 16);

    if (count < 0) {
        cJSON_Delete(root);
        log_error("Failed to get ONVIF device profiles");
        http_response_set_json_error(res, 500, "Failed to get ONVIF device profiles");
        return;
    }

    // Find the requested profile
    const onvif_profile_t *profile = NULL;
    for (int i = 0; i < count; i++) {
        if (strcmp(profiles[i].token, profile_token) == 0) {
            profile = &profiles[i];
            break;
        }
    }

    if (!profile) {
        cJSON_Delete(root);
        log_error("Profile not found");
        http_response_set_json_error(res, 404, "Profile not found");
        return;
    }

    // Create device info
    onvif_device_info_t device_info;
    memset(&device_info, 0, sizeof(device_info));
    strncpy(device_info.device_service, device_url, sizeof(device_info.device_service) - 1);

    // Add ONVIF device as stream
    int result = add_onvif_device_as_stream(&device_info, profile, username, password, stream_name);
    cJSON_Delete(root);

    if (result != 0) {
        log_error("Failed to add ONVIF device as stream");
        http_response_set_json_error(res, 500, "Failed to add ONVIF device as stream");
        return;
    }

    // Create success response
    cJSON *response_json = cJSON_CreateObject();
    if (!response_json) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    cJSON_AddBoolToObject(response_json, "success", true);
    cJSON_AddStringToObject(response_json, "message", "ONVIF device added as stream successfully");
    cJSON_AddStringToObject(response_json, "stream_name", stream_name);

    // Convert to string
    char *json_str = cJSON_PrintUnformatted(response_json);
    cJSON_Delete(response_json);

    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }

    // Send response
    http_response_set_json(res, 200, json_str);

    // Clean up
    free(json_str);

    log_info("Successfully handled POST /api/onvif/device/add request");
}

/**
 * @brief Backend-agnostic handler for POST /api/onvif/device/test
 */
void handle_post_test_onvif_connection(const http_request_t *req, http_response_t *res) {
    log_info("Handling POST /api/onvif/device/test request");

    // Parse JSON request
    cJSON *root = httpd_parse_json_body(req);
    if (!root) {
        log_error("Invalid JSON request");
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    // Extract parameters
    cJSON *url_json = cJSON_GetObjectItem(root, "url");
    cJSON *username_json = cJSON_GetObjectItem(root, "username");
    cJSON *password_json = cJSON_GetObjectItem(root, "password");

    if (!url_json || !cJSON_IsString(url_json)) {
        cJSON_Delete(root);
        log_error("Missing or invalid parameters");
        http_response_set_json_error(res, 400, "Missing or invalid parameters");
        return;
    }

    const char *url = url_json->valuestring;
    const char *username = username_json && cJSON_IsString(username_json) ? username_json->valuestring : NULL;
    const char *password = password_json && cJSON_IsString(password_json) ? password_json->valuestring : NULL;

    // Validate parameters
    if (strlen(url) == 0) {
        cJSON_Delete(root);
        log_error("Invalid parameters");
        http_response_set_json_error(res, 400, "Invalid parameters");
        return;
    }

    // Test ONVIF connection
    onvif_clear_last_fault();
    int result = test_onvif_connection(url, username, password);
    cJSON_Delete(root);

    if (result != 0) {
        log_error("Failed to connect to ONVIF device");
        if (respond_with_onvif_fault(res)) {
            return;
        }
        http_response_set_json_error(res, 500, "Failed to connect to ONVIF device");
        return;
    }

    // Create success response
    cJSON *response_json = cJSON_CreateObject();
    if (!response_json) {
        log_error("Failed to create JSON response");
        http_response_set_json_error(res, 500, "Failed to create JSON response");
        return;
    }

    cJSON_AddBoolToObject(response_json, "success", true);
    cJSON_AddStringToObject(response_json, "message", "Successfully connected to ONVIF device");

    // Convert to string
    char *json_str = cJSON_PrintUnformatted(response_json);
    cJSON_Delete(response_json);

    if (!json_str) {
        log_error("Failed to generate JSON response");
        http_response_set_json_error(res, 500, "Failed to generate JSON response");
        return;
    }

    // Send response
    http_response_set_json(res, 200, json_str);

    // Clean up
    free(json_str);

    log_info("Successfully handled POST /api/onvif/device/test request");
}
