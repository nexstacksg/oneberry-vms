/**
 * Network storage (NAS) settings API (admin only).
 *
 *   GET  /api/storage/nas             settings (without password) and status
 *   POST /api/storage/nas/test        try a share without saving it
 *   POST /api/storage/nas/connect     save, mount and record new recordings there
 *   POST /api/storage/nas/disconnect  record to the local disk again
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cjson/cJSON.h>

#include "web/api_handlers_nas.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#include "storage/nas_storage.h"
#include "core/logger.h"

static void add_status(cJSON *doc, const nas_status_t *st) {
    cJSON *status = cJSON_AddObjectToObject(doc, "status");
    cJSON_AddStringToObject(status, "state", nas_state_name(st->state));
    cJSON_AddNumberToObject(status, "total_bytes", (double)st->total_bytes);
    cJSON_AddNumberToObject(status, "free_bytes", (double)st->free_bytes);
    cJSON_AddNumberToObject(status, "last_check", (double)st->last_check);
    cJSON_AddNumberToObject(status, "connected_since", (double)st->connected_since);
    cJSON_AddStringToObject(status, "error", st->error);
}

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
    nas_config_t cfg;
    nas_status_t st;
    nas_get_config(&cfg);
    nas_get_status(&st);
    cJSON *doc = cJSON_CreateObject();
    cJSON_AddBoolToObject(doc, "enabled", cfg.enabled);
    cJSON_AddStringToObject(doc, "type", cfg.type[0] ? cfg.type : "nfs");
    cJSON_AddStringToObject(doc, "server", cfg.server);
    cJSON_AddStringToObject(doc, "share", cfg.share);
    cJSON_AddStringToObject(doc, "username", cfg.username);
    cJSON_AddBoolToObject(doc, "has_password", cfg.password[0] != '\0');
    cJSON_AddStringToObject(doc, "version", cfg.version);
    cJSON_AddStringToObject(doc, "recordings_path", NAS_RECORDINGS_DIR);
    add_status(doc, &st);
    return doc;
}

/* Settings from the request body. An empty password keeps the saved one
   when the NAS, share and user are the same (so it need not be retyped). */
static int parse_body(const http_request_t *req, nas_config_t *cfg) {
    cJSON *body = httpd_parse_json_body(req);
    if (!body) return -1;
    memset(cfg, 0, sizeof(*cfg));
    const cJSON *v;
#define COPY(field) \
    if ((v = cJSON_GetObjectItem(body, #field)) && cJSON_IsString(v)) \
        snprintf(cfg->field, sizeof(cfg->field), "%s", v->valuestring)
    COPY(type);
    COPY(server);
    COPY(share);
    COPY(username);
    COPY(password);
    COPY(version);
#undef COPY
    cJSON_Delete(body);

    for (char *c = cfg->type; *c; c++) {
        if (*c >= 'A' && *c <= 'Z') *c = (char)(*c - 'A' + 'a');
    }
    if (strcmp(cfg->type, "cifs") == 0) snprintf(cfg->type, sizeof(cfg->type), "smb");

    if (cfg->password[0] == '\0') {
        nas_config_t saved;
        nas_get_config(&saved);
        if (strcmp(saved.type, cfg->type) == 0 && strcmp(saved.server, cfg->server) == 0 &&
            strcmp(saved.username, cfg->username) == 0) {
            snprintf(cfg->password, sizeof(cfg->password), "%s", saved.password);
        }
    }
    return 0;
}

void handle_get_nas_settings(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    respond(res, 200, settings_doc());
}

void handle_post_nas_test(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    nas_config_t cfg;
    if (parse_body(req, &cfg) != 0) {
        http_response_set_json_error(res, 400, "Invalid request");
        return;
    }
    nas_status_t result;
    char err[256] = {0};
    cJSON *doc = cJSON_CreateObject();
    if (nas_test(&cfg, &result, err, sizeof(err)) == 0) {
        cJSON_AddBoolToObject(doc, "ok", true);
        cJSON_AddNumberToObject(doc, "total_bytes", (double)result.total_bytes);
        cJSON_AddNumberToObject(doc, "free_bytes", (double)result.free_bytes);
        cJSON_AddStringToObject(doc, "message", "Connected and able to write");
    } else {
        cJSON_AddBoolToObject(doc, "ok", false);
        cJSON_AddStringToObject(doc, "message", err);
        log_warn("NAS test failed for %s server %s: %s", cfg.type, cfg.server, err);
    }
    respond(res, 200, doc);
}

void handle_post_nas_connect(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    nas_config_t cfg;
    if (parse_body(req, &cfg) != 0) {
        http_response_set_json_error(res, 400, "Invalid request");
        return;
    }
    char err[256] = {0};
    if (nas_connect(&cfg, err, sizeof(err)) != 0) {
        http_response_set_json_error(res, 400, err[0] ? err : "Could not connect to the NAS");
        return;
    }
    cJSON *doc = settings_doc();
    if (err[0]) cJSON_AddStringToObject(doc, "warning", err);
    respond(res, 200, doc);
}

void handle_post_nas_disconnect(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    if (nas_disconnect() != 0) {
        cJSON *doc = settings_doc();
        cJSON_AddStringToObject(doc, "warning", "Disconnected, but the setting could not be saved");
        respond(res, 200, doc);
        return;
    }
    respond(res, 200, settings_doc());
}
