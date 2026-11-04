/**
 * Cloud storage settings API (admin only).
 *
 *   GET  /api/storage/cloud             settings (without the secret) and status
 *   POST /api/storage/cloud/test        try settings without saving them
 *   POST /api/storage/cloud/connect     save and start uploading new recordings
 *   POST /api/storage/cloud/disconnect  stop uploading
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cjson/cJSON.h>

#include "web/api_handlers_cloud.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#include "storage/cloud_storage.h"
#include "core/logger.h"

static void respond(http_response_t *res, int code, cJSON *doc) {
    char *json = cJSON_PrintUnformatted(doc);
    cJSON_Delete(doc);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to build response");
        return;
    }
    http_response_set_json(res, code, json);
    free(json);
}

static cJSON *settings_doc(void) {
    cloud_config_t cfg;
    cloud_status_t st;
    cloud_get_config(&cfg);
    cloud_get_status(&st);
    cJSON *doc = cJSON_CreateObject();
    cJSON_AddBoolToObject(doc, "enabled", cfg.enabled);
    cJSON_AddStringToObject(doc, "provider", cfg.provider[0] ? cfg.provider : "s3");
    cJSON_AddStringToObject(doc, "s3_provider", cfg.s3_provider[0] ? cfg.s3_provider : "AWS");
    cJSON_AddStringToObject(doc, "endpoint", cfg.endpoint);
    cJSON_AddStringToObject(doc, "region", cfg.region);
    cJSON_AddStringToObject(doc, "bucket", cfg.bucket);
    cJSON_AddStringToObject(doc, "access_key", cfg.access_key);
    cJSON_AddBoolToObject(doc, "has_secret", cfg.secret_key[0] != '\0');
    cJSON_AddStringToObject(doc, "prefix", cfg.prefix);
    cJSON_AddBoolToObject(doc, "events_only", cfg.events_only);
    cJSON_AddNumberToObject(doc, "bwlimit_mbps", cfg.bwlimit_mbps);
    cJSON_AddNumberToObject(doc, "enabled_since", (double)cfg.enabled_since);
    cJSON *status = cJSON_AddObjectToObject(doc, "status");
    cJSON_AddStringToObject(status, "state", cloud_state_name(st.state));
    cJSON_AddNumberToObject(status, "queue_waiting", st.queue_waiting);
    cJSON_AddNumberToObject(status, "uploaded_today", st.uploaded_today);
    cJSON_AddNumberToObject(status, "uploaded_today_bytes", (double)st.uploaded_today_bytes);
    cJSON_AddNumberToObject(status, "last_upload_at", (double)st.last_upload_at);
    cJSON_AddStringToObject(status, "error", st.error);
    return doc;
}

/* Settings from the body. An empty secret keeps the saved one for the same
   provider, bucket and key (so it need not be retyped). */
static int parse_body(const http_request_t *req, cloud_config_t *cfg) {
    cJSON *body = httpd_parse_json_body(req);
    if (!body) return -1;
    memset(cfg, 0, sizeof(*cfg));
    const cJSON *v;
#define COPY(field) \
    if ((v = cJSON_GetObjectItem(body, #field)) && cJSON_IsString(v)) \
        snprintf(cfg->field, sizeof(cfg->field), "%s", v->valuestring)
    COPY(provider);
    COPY(s3_provider);
    COPY(endpoint);
    COPY(region);
    COPY(bucket);
    COPY(access_key);
    COPY(secret_key);
    COPY(prefix);
#undef COPY
    cfg->events_only = cJSON_IsTrue(cJSON_GetObjectItem(body, "events_only"));
    if ((v = cJSON_GetObjectItem(body, "bwlimit_mbps")) && cJSON_IsNumber(v)) cfg->bwlimit_mbps = v->valueint;
    cJSON_Delete(body);

    if (cfg->secret_key[0] == '\0') {
        cloud_config_t saved;
        cloud_get_config(&saved);
        if (strcmp(saved.provider, cfg->provider) == 0 && strcmp(saved.access_key, cfg->access_key) == 0) {
            snprintf(cfg->secret_key, sizeof(cfg->secret_key), "%s", saved.secret_key);
        }
    }
    return 0;
}

void handle_get_cloud_settings(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    respond(res, 200, settings_doc());
}

void handle_post_cloud_test(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    cloud_config_t cfg;
    if (parse_body(req, &cfg) != 0) {
        http_response_set_json_error(res, 400, "Invalid request");
        return;
    }
    char err[256] = {0};
    cJSON *doc = cJSON_CreateObject();
    if (cloud_test(&cfg, err, sizeof(err)) == 0) {
        cJSON_AddBoolToObject(doc, "ok", true);
        cJSON_AddStringToObject(doc, "message", "Connected: the bucket can be listed and written");
    } else {
        cJSON_AddBoolToObject(doc, "ok", false);
        cJSON_AddStringToObject(doc, "message", err);
        log_warn("Cloud test failed (%s %s): %s", cfg.provider, cfg.bucket, err);
    }
    respond(res, 200, doc);
}

void handle_post_cloud_connect(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    cloud_config_t cfg;
    if (parse_body(req, &cfg) != 0) {
        http_response_set_json_error(res, 400, "Invalid request");
        return;
    }
    char err[256] = {0};
    if (cloud_connect(&cfg, err, sizeof(err)) != 0) {
        http_response_set_json_error(res, 400, err[0] ? err : "Could not connect to the cloud");
        return;
    }
    cJSON *doc = settings_doc();
    if (err[0]) cJSON_AddStringToObject(doc, "warning", err);
    respond(res, 200, doc);
}

void handle_post_cloud_disconnect(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    cJSON *doc = NULL;
    if (cloud_disconnect() != 0) {
        doc = settings_doc();
        cJSON_AddStringToObject(doc, "warning", "Disconnected, but the setting could not be saved");
    } else {
        doc = settings_doc();
    }
    respond(res, 200, doc);
}
