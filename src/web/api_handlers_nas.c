/**
 * Network storage (NAS) settings API (admin only).
 *
 *   GET  /api/storage/nas             settings (without password) and status
 *   POST /api/storage/nas/test        try a share without saving it
 *   POST /api/storage/nas/connect     save, mount and record new recordings there
 *   POST /api/storage/nas/disconnect  record to the local disk again
 *   POST /api/storage/nas/options     change the role (recording/backup) and
 *                                     backup options while connected
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cjson/cJSON.h>

#include "web/api_handlers_nas.h"
#include "web/request_response.h"
#include "web/httpd_utils.h"
#include "storage/nas_storage.h"
#include "storage/nas_backup.h"
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

static void add_backup(cJSON *doc, const nas_config_t *cfg) {
    cJSON *b = cJSON_AddObjectToObject(doc, "backup");
    cJSON_AddStringToObject(b, "when", cfg->backup_when[0] ? cfg->backup_when : "realtime");
    cJSON_AddNumberToObject(b, "schedule_start_hour", cfg->schedule_start_hour);
    cJSON_AddNumberToObject(b, "schedule_end_hour", cfg->schedule_end_hour);
    cJSON_AddNumberToObject(b, "bwlimit_mbps", cfg->bwlimit_mbps);
    cJSON_AddBoolToObject(b, "events_only", cfg->events_only);
    cJSON_AddBoolToObject(b, "include_existing", cfg->include_existing);
    cJSON_AddBoolToObject(b, "delete_local", cfg->delete_local);
    cJSON_AddNumberToObject(b, "reserve_gb", cfg->reserve_gb > 0 ? cfg->reserve_gb : 50);
    cJSON_AddNumberToObject(b, "keep_days", cfg->keep_days);
    cJSON_AddNumberToObject(b, "since", (double)cfg->backup_since);
    cJSON *cams = cJSON_AddArrayToObject(b, "cameras");
    for (const char *p = cfg->cameras; *p;) {
        const char *nl = strchr(p, '\n');
        size_t n = nl ? (size_t)(nl - p) : strlen(p);
        char name[512];
        snprintf(name, sizeof(name), "%.*s", (int)(n < sizeof(name) - 1 ? n : sizeof(name) - 1), p);
        cJSON_AddItemToArray(cams, cJSON_CreateString(name));
        p += n;
        if (*p == '\n') p++;
    }

    nas_backup_status_t bs;
    nas_backup_get_status(&bs);
    cJSON *st = cJSON_AddObjectToObject(b, "status");
    cJSON_AddStringToObject(st, "state", bs.state ? bs.state : "off");
    cJSON_AddNumberToObject(st, "queue_waiting", bs.queue_waiting);
    cJSON_AddNumberToObject(st, "queue_bytes", (double)bs.queue_bytes);
    cJSON_AddNumberToObject(st, "backed_up_until", (double)bs.backed_up_until);
    cJSON_AddNumberToObject(st, "copied_today", bs.copied_today);
    cJSON_AddNumberToObject(st, "copied_today_bytes", (double)bs.copied_today_bytes);
    cJSON_AddNumberToObject(st, "last_backup_at", (double)bs.last_backup_at);
    cJSON_AddNumberToObject(st, "last_speed_mbps", bs.last_speed_mbps);
    cJSON_AddNumberToObject(st, "backups_total", bs.backups_total);
    cJSON_AddNumberToObject(st, "backups_bytes", (double)bs.backups_bytes);
    cJSON_AddStringToObject(st, "current", bs.current);
    cJSON_AddStringToObject(st, "error", bs.error);
}

static cJSON *settings_doc(void) {
    /* the settings hold the backup camera list, too big for the stack */
    nas_config_t *cfg = malloc(sizeof(*cfg));
    cJSON *doc = cJSON_CreateObject();
    if (!cfg) return doc;
    nas_status_t st;
    nas_get_config(cfg);
    nas_get_status(&st);
    cJSON_AddBoolToObject(doc, "enabled", cfg->enabled);
    cJSON_AddStringToObject(doc, "type", cfg->type[0] ? cfg->type : "nfs");
    cJSON_AddStringToObject(doc, "server", cfg->server);
    cJSON_AddStringToObject(doc, "share", cfg->share);
    cJSON_AddStringToObject(doc, "username", cfg->username);
    cJSON_AddBoolToObject(doc, "has_password", cfg->password[0] != '\0');
    cJSON_AddStringToObject(doc, "version", cfg->version);
    cJSON_AddStringToObject(doc, "recordings_path", NAS_RECORDINGS_DIR);
    cJSON_AddStringToObject(doc, "role", cfg->role[0] ? cfg->role : "main");
    add_status(doc, &st);
    add_backup(doc, cfg);
    free(cfg);
    return doc;
}

/* Role and backup options from a request body (missing ones keep defaults). */
static void parse_options(const cJSON *body, nas_config_t *cfg) {
    const cJSON *v;
    if ((v = cJSON_GetObjectItem(body, "role")) && cJSON_IsString(v)) {
        snprintf(cfg->role, sizeof(cfg->role), "%s", v->valuestring);
    }
    const cJSON *b = cJSON_GetObjectItem(body, "backup");
    if (!cJSON_IsObject(b)) return;
    if ((v = cJSON_GetObjectItem(b, "when")) && cJSON_IsString(v)) {
        snprintf(cfg->backup_when, sizeof(cfg->backup_when), "%s", v->valuestring);
    }
#define NUM(key, field) if ((v = cJSON_GetObjectItem(b, key)) && cJSON_IsNumber(v)) cfg->field = v->valueint
    NUM("schedule_start_hour", schedule_start_hour);
    NUM("schedule_end_hour", schedule_end_hour);
    NUM("bwlimit_mbps", bwlimit_mbps);
    NUM("reserve_gb", reserve_gb);
    NUM("keep_days", keep_days);
#undef NUM
    cfg->events_only = cJSON_IsTrue(cJSON_GetObjectItem(b, "events_only"));
    cfg->include_existing = cJSON_IsTrue(cJSON_GetObjectItem(b, "include_existing"));
    cfg->delete_local = cJSON_IsTrue(cJSON_GetObjectItem(b, "delete_local"));
    size_t used = 0;
    const cJSON *cam;
    cJSON_ArrayForEach(cam, cJSON_GetObjectItem(b, "cameras")) {
        if (!cJSON_IsString(cam) || !cam->valuestring[0] || strchr(cam->valuestring, '\n')) continue;
        int n = snprintf(cfg->cameras + used, sizeof(cfg->cameras) - used, "%s%s", used ? "\n" : "", cam->valuestring);
        if (n < 0 || used + (size_t)n >= sizeof(cfg->cameras)) {
            cfg->cameras[used] = '\0';
            break;
        }
        used += (size_t)n;
    }
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
    parse_options(body, cfg);
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

void handle_post_nas_options(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) return;
    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid request");
        return;
    }
    nas_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    parse_options(body, &cfg);
    cJSON_Delete(body);
    char err[256] = {0};
    if (nas_update_options(&cfg, err, sizeof(err)) != 0) {
        http_response_set_json_error(res, 400, err[0] ? err : "Could not save the NAS options");
        return;
    }
    cJSON *doc = settings_doc();
    if (err[0]) cJSON_AddStringToObject(doc, "warning", err);
    respond(res, 200, doc);
}
