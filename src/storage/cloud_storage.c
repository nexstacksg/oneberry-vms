/**
 * Cloud storage for recordings: settings, connection test, upload queue.
 *
 * See include/storage/cloud_storage.h. Uploads use rclone (in the image),
 * started with fork/exec (no shell). The bucket settings, including the
 * secret, are passed to rclone in its environment (RCLONE_CONFIG_CLOUD_*),
 * never on a command line, and saved in cloud.json readable by root only.
 *
 * Queue: table cloud_uploads (migration 0044), one row per recording.
 * status 0 = waiting (retry at next_attempt), 1 = uploaded, 2 = skipped
 * (file gone before it could be uploaded), 3 = uploading now.
 */

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <cjson/cJSON.h>

#include "storage/cloud_storage.h"
#include "database/db_core.h"
#include "core/logger.h"

#define CLOUD_CONFIG_FILE "cloud.json"
#define CLOUD_WORKERS 3
#define CLOUD_IDLE_WAIT_SEC 10
#define CLOUD_UPLOAD_TIMEOUT_SEC (30 * 60)
#define CLOUD_TEST_TIMEOUT_SEC 45
#define RCLONE_BIN "/usr/bin/rclone"

enum { UPLOAD_WAITING = 0, UPLOAD_DONE = 1, UPLOAD_SKIPPED = 2, UPLOAD_RUNNING = 3 };

static pthread_mutex_t cloud_mutex = PTHREAD_MUTEX_INITIALIZER;
static cloud_config_t cloud_cfg;
static cloud_state_t cloud_state = CLOUD_STATE_DISABLED;
static char cloud_error[256];
static time_t cloud_last_upload;
static char cloud_config_path[PATH_MAX];

static pthread_t workers[CLOUD_WORKERS];
static int worker_count = 0;
static bool workers_running = false;
static pthread_mutex_t wake_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake_cond = PTHREAD_COND_INITIALIZER;
/* Set at shutdown: running uploads are stopped (they stay queued) */
static volatile sig_atomic_t cloud_stopping = 0;

const char *cloud_state_name(cloud_state_t state) {
    switch (state) {
        case CLOUD_STATE_ACTIVE: return "active";
        case CLOUD_STATE_ERROR: return "error";
        default: return "disabled";
    }
}

static void copy_str(char *dst, size_t len, const char *src) {
    snprintf(dst, len, "%s", src ? src : "");
}

/* ---- settings ---------------------------------------------------------- */

static bool chars_in(const char *s, const char *extra) {
    for (; s && *s; s++) {
        if (!isalnum((unsigned char)*s) && !strchr(extra, *s)) return false;
    }
    return true;
}

static int validate_cloud_config(cloud_config_t *cfg, char *err, size_t err_len) {
    if (strcmp(cfg->provider, "s3") != 0 && strcmp(cfg->provider, "azureblob") != 0) {
        snprintf(err, err_len, "Choose a cloud provider");
        return -1;
    }
    bool s3 = strcmp(cfg->provider, "s3") == 0;
    if (s3) {
        static const char *providers[] = {"AWS", "Wasabi", "Cloudflare", "Minio", "Other", NULL};
        bool known = false;
        for (int i = 0; providers[i]; i++) known = known || strcmp(providers[i], cfg->s3_provider) == 0;
        if (!known) copy_str(cfg->s3_provider, sizeof(cfg->s3_provider), "Other");
        if (cfg->endpoint[0]) {
            if ((strncmp(cfg->endpoint, "https://", 8) != 0 && strncmp(cfg->endpoint, "http://", 7) != 0) ||
                !chars_in(cfg->endpoint, ":/._-")) {
                snprintf(err, err_len, "Endpoint must be a URL like https://s3.example.com");
                return -1;
            }
        } else if (strcmp(cfg->s3_provider, "AWS") != 0) {
            snprintf(err, err_len, "Enter the endpoint URL of your storage provider");
            return -1;
        }
        if (!chars_in(cfg->region, "-_")) {
            snprintf(err, err_len, "Region may only contain letters, numbers and dashes");
            return -1;
        }
    }
    if (!cfg->bucket[0] || !chars_in(cfg->bucket, ".-_")) {
        snprintf(err, err_len, s3 ? "Enter the bucket name" : "Enter the container name");
        return -1;
    }
    if (!cfg->access_key[0] || strpbrk(cfg->access_key, "\r\n") || strpbrk(cfg->secret_key, "\r\n")) {
        snprintf(err, err_len, s3 ? "Enter the access key and secret key" : "Enter the storage account name and key");
        return -1;
    }
    if (!cfg->secret_key[0]) {
        snprintf(err, err_len, s3 ? "Enter the secret key" : "Enter the account key");
        return -1;
    }
    /* folder in the bucket: trim slashes, no "..", safe characters only */
    char *p = cfg->prefix;
    while (*p == '/') p++;
    memmove(cfg->prefix, p, strlen(p) + 1);
    size_t n = strlen(cfg->prefix);
    while (n > 0 && cfg->prefix[n - 1] == '/') cfg->prefix[--n] = '\0';
    if (!chars_in(cfg->prefix, "._-/") || strstr(cfg->prefix, "..")) {
        snprintf(err, err_len, "Folder may only contain letters, numbers, . _ - and /");
        return -1;
    }
    if (cfg->bwlimit_mbps < 0) cfg->bwlimit_mbps = 0;
    return 0;
}

static void load_config_file(void) {
    FILE *fp = fopen(cloud_config_path, "r");
    if (!fp) return;
    char buf[8192];
    size_t len = fread(buf, 1, sizeof(buf) - 1, fp);
    fclose(fp);
    buf[len] = '\0';
    cJSON *doc = cJSON_Parse(buf);
    if (!doc) {
        log_warn("Cloud settings file %s is not valid JSON; ignoring it", cloud_config_path);
        return;
    }
    const cJSON *v;
#define STR(field) \
    if ((v = cJSON_GetObjectItem(doc, #field)) && cJSON_IsString(v)) copy_str(cloud_cfg.field, sizeof(cloud_cfg.field), v->valuestring)
    STR(provider); STR(s3_provider); STR(endpoint); STR(region); STR(bucket);
    STR(access_key); STR(secret_key); STR(prefix);
#undef STR
    cloud_cfg.enabled = cJSON_IsTrue(cJSON_GetObjectItem(doc, "enabled"));
    cloud_cfg.events_only = cJSON_IsTrue(cJSON_GetObjectItem(doc, "events_only"));
    if ((v = cJSON_GetObjectItem(doc, "bwlimit_mbps")) && cJSON_IsNumber(v)) cloud_cfg.bwlimit_mbps = v->valueint;
    if ((v = cJSON_GetObjectItem(doc, "enabled_since")) && cJSON_IsNumber(v)) cloud_cfg.enabled_since = (time_t)v->valuedouble;
    cJSON_Delete(doc);
}

static int save_config_file(const cloud_config_t *cfg) {
    cJSON *doc = cJSON_CreateObject();
    cJSON_AddBoolToObject(doc, "enabled", cfg->enabled);
    cJSON_AddStringToObject(doc, "provider", cfg->provider);
    cJSON_AddStringToObject(doc, "s3_provider", cfg->s3_provider);
    cJSON_AddStringToObject(doc, "endpoint", cfg->endpoint);
    cJSON_AddStringToObject(doc, "region", cfg->region);
    cJSON_AddStringToObject(doc, "bucket", cfg->bucket);
    cJSON_AddStringToObject(doc, "access_key", cfg->access_key);
    cJSON_AddStringToObject(doc, "secret_key", cfg->secret_key);
    cJSON_AddStringToObject(doc, "prefix", cfg->prefix);
    cJSON_AddBoolToObject(doc, "events_only", cfg->events_only);
    cJSON_AddNumberToObject(doc, "bwlimit_mbps", cfg->bwlimit_mbps);
    cJSON_AddNumberToObject(doc, "enabled_since", (double)cfg->enabled_since);
    char *json = cJSON_Print(doc);
    cJSON_Delete(doc);
    if (!json) return -1;

    char tmp_path[PATH_MAX];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", cloud_config_path);
    int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        log_error("Cannot save cloud settings to %s: %s", tmp_path, strerror(errno));
        free(json);
        return -1;
    }
    fchmod(fd, 0600);
    size_t len = strlen(json);
    bool ok = write(fd, json, len) == (ssize_t)len && fsync(fd) == 0;
    close(fd);
    free(json);
    if (!ok || rename(tmp_path, cloud_config_path) != 0) {
        log_error("Cannot save cloud settings to %s: %s", cloud_config_path, strerror(errno));
        unlink(tmp_path);
        return -1;
    }
    return 0;
}

/* ---- rclone ------------------------------------------------------------ */

/* Friendly message from rclone's output. */
static void describe_rclone_error(const char *output, char *err, size_t err_len) {
    if (strstr(output, "InvalidAccessKeyId") || strstr(output, "AuthenticationFailed") ||
        strstr(output, "SignatureDoesNotMatch") || strstr(output, "InvalidAuthenticationInfo")) {
        snprintf(err, err_len, "The cloud refused the keys (check access key and secret key)");
    } else if (strstr(output, "NoSuchBucket") || strstr(output, "ContainerNotFound") ||
               strstr(output, "bucket does not exist") || strstr(output, "directory not found")) {
        snprintf(err, err_len, "Bucket (or container) not found: create it in the cloud console first");
    } else if (strstr(output, "AccessDenied") || strstr(output, "403")) {
        snprintf(err, err_len, "Access denied: the keys are not allowed to write to this bucket");
    } else if (strstr(output, "no such host")) {
        snprintf(err, err_len, "Cannot find the cloud server (check the endpoint and internet access)");
    } else if (strstr(output, "connection refused") || strstr(output, "i/o timeout") ||
               strstr(output, "network is unreachable") || strstr(output, "dial tcp") ||
               strstr(output, "context deadline exceeded")) {
        snprintf(err, err_len, "Cannot reach the cloud (check internet access from this server)");
    } else if (strstr(output, "x509") || strstr(output, "certificate")) {
        snprintf(err, err_len, "The cloud server's security certificate was not accepted");
    } else {
        /* last ERROR line of rclone's output, without the timestamp */
        const char *line = output, *found = NULL;
        while ((line = strstr(line, "ERROR")) != NULL) found = line++;
        const char *start = found ? found : output;
        while (*start == ' ' || *start == ':' || *start == '\n') start++;
        char msg[200];
        snprintf(msg, sizeof(msg), "%s", start);
        char *nl = strchr(msg, '\n');
        if (nl) *nl = '\0';
        snprintf(err, err_len, "Upload failed: %s", msg[0] ? msg : "rclone error");
    }
}

/* Environment for rclone: the "cloud" remote is defined by RCLONE_CONFIG_CLOUD_* */
static int build_env(const cloud_config_t *cfg, char env[][600], int max) {
    int n = 0;
#define ENV(...) do { if (n < max) snprintf(env[n++], sizeof(env[0]), __VA_ARGS__); } while (0)
    ENV("PATH=/usr/local/bin:/usr/bin:/bin");
    ENV("HOME=/tmp");
    ENV("RCLONE_CONFIG=/dev/null");
    if (strcmp(cfg->provider, "azureblob") == 0) {
        ENV("RCLONE_CONFIG_CLOUD_TYPE=azureblob");
        ENV("RCLONE_CONFIG_CLOUD_ACCOUNT=%s", cfg->access_key);
        ENV("RCLONE_CONFIG_CLOUD_KEY=%s", cfg->secret_key);
    } else {
        ENV("RCLONE_CONFIG_CLOUD_TYPE=s3");
        ENV("RCLONE_CONFIG_CLOUD_PROVIDER=%s", cfg->s3_provider);
        ENV("RCLONE_CONFIG_CLOUD_ENV_AUTH=false");
        ENV("RCLONE_CONFIG_CLOUD_ACCESS_KEY_ID=%s", cfg->access_key);
        ENV("RCLONE_CONFIG_CLOUD_SECRET_ACCESS_KEY=%s", cfg->secret_key);
        if (cfg->region[0]) ENV("RCLONE_CONFIG_CLOUD_REGION=%s", cfg->region);
        if (cfg->endpoint[0]) ENV("RCLONE_CONFIG_CLOUD_ENDPOINT=%s", cfg->endpoint);
        /* do not try to create the bucket (keys may only be allowed to write) */
        ENV("RCLONE_CONFIG_CLOUD_NO_CHECK_BUCKET=true");
        if (strcmp(cfg->s3_provider, "Minio") == 0 || strcmp(cfg->s3_provider, "Other") == 0) {
            ENV("RCLONE_CONFIG_CLOUD_FORCE_PATH_STYLE=true");
        }
    }
#undef ENV
    return n;
}

/* Run rclone with @p args (after "rclone"); capture a friendly error. */
static int run_rclone(const cloud_config_t *cfg, const char *const args[], int timeout_sec,
                      char *err, size_t err_len) {
    char env_store[16][600];
    int env_count = build_env(cfg, env_store, 16);
    char *envp[18];
    for (int i = 0; i < env_count; i++) envp[i] = env_store[i];
    envp[env_count] = NULL;

    char bw[32] = {0};
    char *argv[32];
    int argc = 0;
    argv[argc++] = "rclone";
    for (int i = 0; args[i] && argc < 20; i++) argv[argc++] = (char *)args[i];
    argv[argc++] = "--retries";
    argv[argc++] = "1";
    argv[argc++] = "--low-level-retries";
    argv[argc++] = "3";
    argv[argc++] = "--contimeout";
    argv[argc++] = "15s";
    argv[argc++] = "--timeout";
    argv[argc++] = "60s";
    if (cfg->bwlimit_mbps > 0) {
        /* the limit is for all uploads together; each worker gets a share */
        int kbytes = cfg->bwlimit_mbps * 1000 / 8 / CLOUD_WORKERS;
        snprintf(bw, sizeof(bw), "%dk", kbytes > 16 ? kbytes : 16);
        argv[argc++] = "--bwlimit";
        argv[argc++] = bw;
    }
    argv[argc] = NULL;

    int pipefd[2];
    if (pipe(pipefd) != 0) {
        snprintf(err, err_len, "Cannot start rclone: %s", strerror(errno));
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        snprintf(err, err_len, "Cannot start rclone: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);
        execve(RCLONE_BIN, argv, envp);
        dprintf(STDERR_FILENO, "rclone not found (%s)", strerror(errno));
        _exit(127);
    }
    for (int i = 0; i < env_count; i++) memset(env_store[i], 0, sizeof(env_store[i]));
    close(pipefd[1]);
    fcntl(pipefd[0], F_SETFL, O_NONBLOCK);

    char output[4096] = {0};
    size_t out_len = 0;
    int status = 0;
    time_t deadline = time(NULL) + timeout_sec;
    for (;;) {
        ssize_t r = read(pipefd[0], output + out_len, sizeof(output) - 1 - out_len);
        if (r > 0) out_len += (size_t)r;
        if (out_len >= sizeof(output) - 1) out_len = 0;  /* keep the latest output */
        if (waitpid(pid, &status, WNOHANG) == pid) break;
        if (cloud_stopping) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            close(pipefd[0]);
            snprintf(err, err_len, "Stopped for shutdown");
            return -1;
        }
        if (time(NULL) >= deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            close(pipefd[0]);
            snprintf(err, err_len, "The cloud did not finish within %d seconds", timeout_sec);
            return -1;
        }
        usleep(100000);
    }
    ssize_t r = read(pipefd[0], output + out_len, sizeof(output) - 1 - out_len);
    if (r > 0) out_len += (size_t)r;
    close(pipefd[0]);
    output[out_len] = '\0';
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;
    describe_rclone_error(output, err, err_len);
    return -1;
}

static void remote_base(const cloud_config_t *cfg, char *out, size_t len) {
    snprintf(out, len, "cloud:%s%s%s", cfg->bucket, cfg->prefix[0] ? "/" : "", cfg->prefix);
}

/* ---- public: test / connect / disconnect -------------------------------- */

int cloud_test(const cloud_config_t *cfg_in, char *err, size_t err_len) {
    cloud_config_t cfg = *cfg_in;
    if (validate_cloud_config(&cfg, err, err_len) != 0) return -1;
    if (access(RCLONE_BIN, X_OK) != 0) {
        snprintf(err, err_len, "rclone is not installed in this image");
        return -1;
    }

    char bucket[300];
    snprintf(bucket, sizeof(bucket), "cloud:%s", cfg.bucket);
    const char *list_args[] = {"lsf", bucket, "--max-depth", "1", NULL};
    if (run_rclone(&cfg, list_args, CLOUD_TEST_TIMEOUT_SEC, err, err_len) != 0) return -1;

    char local[] = "/tmp/lightnvr-cloud-test-XXXXXX";
    int fd = mkstemp(local);
    if (fd < 0) {
        snprintf(err, err_len, "Cannot create a test file: %s", strerror(errno));
        return -1;
    }
    dprintf(fd, "LightNVR cloud storage test\n");
    close(fd);
    char base[600], remote[700];
    remote_base(&cfg, base, sizeof(base));
    snprintf(remote, sizeof(remote), "%s/.lightnvr-test-%d", base, (int)getpid());
    const char *put_args[] = {"copyto", local, remote, NULL};
    int rc = run_rclone(&cfg, put_args, CLOUD_TEST_TIMEOUT_SEC, err, err_len);
    unlink(local);
    if (rc != 0) return -1;
    const char *del_args[] = {"deletefile", remote, NULL};
    char del_err[256];
    if (run_rclone(&cfg, del_args, CLOUD_TEST_TIMEOUT_SEC, del_err, sizeof(del_err)) != 0) {
        log_warn("Cloud test file could not be deleted (%s); writing works", del_err);
    }
    return 0;
}

static void wake_workers(void) {
    pthread_mutex_lock(&wake_mutex);
    pthread_cond_broadcast(&wake_cond);
    pthread_mutex_unlock(&wake_mutex);
}

int cloud_connect(const cloud_config_t *cfg_in, char *err, size_t err_len) {
    cloud_config_t cfg = *cfg_in;
    if (cloud_test(&cfg, err, err_len) != 0) return -1;
    validate_cloud_config(&cfg, err, err_len);
    err[0] = '\0';

    pthread_mutex_lock(&cloud_mutex);
    bool same_target = strcmp(cloud_cfg.provider, cfg.provider) == 0 &&
                       strcmp(cloud_cfg.bucket, cfg.bucket) == 0 &&
                       strcmp(cloud_cfg.prefix, cfg.prefix) == 0 && cloud_cfg.enabled_since > 0;
    /* Reconnecting to the same place keeps the backlog; otherwise start now */
    cfg.enabled_since = same_target ? cloud_cfg.enabled_since : time(NULL);
    cfg.enabled = true;
    cloud_cfg = cfg;
    cloud_state = CLOUD_STATE_ACTIVE;
    cloud_error[0] = '\0';
    pthread_mutex_unlock(&cloud_mutex);

    if (save_config_file(&cfg) != 0) {
        snprintf(err, err_len, "Connected, but the cloud settings could not be saved (they will be lost on restart)");
    }
    log_info("Cloud storage connected (%s %s/%s); recordings from now on are uploaded",
             cfg.provider, cfg.bucket, cfg.prefix);
    wake_workers();
    return 0;
}

int cloud_disconnect(void) {
    cloud_config_t cfg;
    pthread_mutex_lock(&cloud_mutex);
    cloud_cfg.enabled = false;
    cfg = cloud_cfg;
    cloud_state = CLOUD_STATE_DISABLED;
    cloud_error[0] = '\0';
    pthread_mutex_unlock(&cloud_mutex);
    log_info("Cloud storage disconnected; recordings are no longer uploaded");
    return save_config_file(&cfg);
}

void cloud_get_config(cloud_config_t *out) {
    pthread_mutex_lock(&cloud_mutex);
    *out = cloud_cfg;
    pthread_mutex_unlock(&cloud_mutex);
}

/* ---- queue (database) --------------------------------------------------- */

typedef struct {
    long long id;
    char stream[256];
    char file_path[PATH_MAX];
    time_t start_time;
} upload_item_t;

static const char *CANDIDATE_WHERE =
    " FROM recordings r LEFT JOIN cloud_uploads c ON c.recording_id = r.id"
    " WHERE r.is_complete = 1 AND r.end_time IS NOT NULL AND r.end_time > 0"
    " AND r.start_time >= ?1"
    " AND (?2 = 0 OR r.trigger_type IN ('detection', 'motion'))"
    " AND (c.recording_id IS NULL OR (c.status = 0 AND c.next_attempt <= ?3))";

/* Take the oldest waiting recording and mark it as uploading. */
static bool claim_next(const cloud_config_t *cfg, upload_item_t *item) {
    sqlite3 *db = get_db_handle();
    if (!db) return false;
    bool found = false;
    pthread_mutex_lock(get_db_mutex());
    char sql[1024];
    snprintf(sql, sizeof(sql), "SELECT r.id, r.stream_name, r.file_path, r.start_time%s ORDER BY r.start_time ASC LIMIT 1;",
             CANDIDATE_WHERE);
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, (sqlite3_int64)cfg->enabled_since);
        sqlite3_bind_int(stmt, 2, cfg->events_only ? 1 : 0);
        sqlite3_bind_int64(stmt, 3, (sqlite3_int64)time(NULL));
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            item->id = sqlite3_column_int64(stmt, 0);
            copy_str(item->stream, sizeof(item->stream), (const char *)sqlite3_column_text(stmt, 1));
            copy_str(item->file_path, sizeof(item->file_path), (const char *)sqlite3_column_text(stmt, 2));
            item->start_time = (time_t)sqlite3_column_int64(stmt, 3);
            found = true;
        }
        sqlite3_finalize(stmt);
    }
    if (found) {
        const char *upsert =
            "INSERT INTO cloud_uploads (recording_id, status) VALUES (?1, 3)"
            " ON CONFLICT(recording_id) DO UPDATE SET status = 3;";
        if (sqlite3_prepare_v2(db, upsert, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_int64(stmt, 1, item->id);
            sqlite3_step(stmt);
            sqlite3_finalize(stmt);
        }
    }
    pthread_mutex_unlock(get_db_mutex());
    return found;
}

static void finish_item(long long id, int status, const char *remote, long long bytes, const char *error) {
    sqlite3 *db = get_db_handle();
    if (!db) return;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    const char *sql = status == UPLOAD_DONE
        ? "UPDATE cloud_uploads SET status = 1, attempts = attempts + 1, remote_path = ?2, bytes = ?3,"
          " uploaded_at = ?4, last_error = NULL WHERE recording_id = ?1;"
        : "UPDATE cloud_uploads SET status = ?5, attempts = attempts + 1, last_error = ?6,"
          " next_attempt = ?4 + MIN(3600, 60 * (1 << MIN(attempts, 6))) WHERE recording_id = ?1;";
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, id);
        if (status == UPLOAD_DONE) {
            sqlite3_bind_text(stmt, 2, remote, -1, SQLITE_TRANSIENT);
            sqlite3_bind_int64(stmt, 3, bytes);
        }
        sqlite3_bind_int64(stmt, 4, (sqlite3_int64)time(NULL));
        if (status != UPLOAD_DONE) {
            sqlite3_bind_int(stmt, 5, status);
            sqlite3_bind_text(stmt, 6, error ? error : "", -1, SQLITE_TRANSIENT);
        }
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
}

static int query_int(const char *sql, const cloud_config_t *cfg, long long *second) {
    sqlite3 *db = get_db_handle();
    if (!db) return 0;
    int value = 0;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        if (cfg) {
            sqlite3_bind_int64(stmt, 1, (sqlite3_int64)cfg->enabled_since);
            sqlite3_bind_int(stmt, 2, cfg->events_only ? 1 : 0);
            sqlite3_bind_int64(stmt, 3, (sqlite3_int64)INT64_MAX / 2);
        } else {
            struct tm tm_now;
            time_t now = time(NULL);
            localtime_r(&now, &tm_now);
            tm_now.tm_hour = tm_now.tm_min = tm_now.tm_sec = 0;
            sqlite3_bind_int64(stmt, 1, (sqlite3_int64)mktime(&tm_now));
        }
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            value = sqlite3_column_int(stmt, 0);
            if (second) *second = sqlite3_column_int64(stmt, 1);
        }
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
    return value;
}

void cloud_get_status(cloud_status_t *out) {
    memset(out, 0, sizeof(*out));
    cloud_config_t cfg;
    pthread_mutex_lock(&cloud_mutex);
    cfg = cloud_cfg;
    out->state = cloud_state;
    out->last_upload_at = cloud_last_upload;
    copy_str(out->error, sizeof(out->error), cloud_error);
    pthread_mutex_unlock(&cloud_mutex);
    if (!cfg.enabled) return;

    char sql[1024];
    snprintf(sql, sizeof(sql), "SELECT COUNT(*)%s;", CANDIDATE_WHERE);
    out->queue_waiting = query_int(sql, &cfg, NULL);
    long long bytes = 0;
    out->uploaded_today = query_int(
        "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM cloud_uploads WHERE status = 1 AND uploaded_at >= ?1;",
        NULL, &bytes);
    out->uploaded_today_bytes = (uint64_t)bytes;
}

/* ---- workers ------------------------------------------------------------ */

static void safe_component(const char *in, char *out, size_t len) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 1 < len; i++) {
        unsigned char c = (unsigned char)in[i];
        out[j++] = (isalnum(c) || c == '.' || c == '_' || c == '-') ? (char)c : '_';
    }
    out[j] = '\0';
}

static void upload_one(const cloud_config_t *cfg, const upload_item_t *item) {
    struct stat st;
    if (stat(item->file_path, &st) != 0) {
        finish_item(item->id, UPLOAD_SKIPPED, NULL, 0, "Recording file no longer exists");
        return;
    }
    char stream[256], base[600], remote[PATH_MAX + 700], day[16];
    safe_component(item->stream, stream, sizeof(stream));
    struct tm tm_start;
    localtime_r(&item->start_time, &tm_start);
    strftime(day, sizeof(day), "%Y/%m/%d", &tm_start);
    const char *name = strrchr(item->file_path, '/');
    name = name ? name + 1 : item->file_path;
    remote_base(cfg, base, sizeof(base));
    snprintf(remote, sizeof(remote), "%s/%s/%s/%s", base, stream, day, name);

    char err[256] = {0};
    const char *args[] = {"copyto", item->file_path, remote, NULL};
    if (run_rclone(cfg, args, CLOUD_UPLOAD_TIMEOUT_SEC, err, sizeof(err)) == 0) {
        finish_item(item->id, UPLOAD_DONE, remote + strlen("cloud:"), (long long)st.st_size, NULL);
        pthread_mutex_lock(&cloud_mutex);
        if (cloud_cfg.enabled) cloud_state = CLOUD_STATE_ACTIVE;
        cloud_error[0] = '\0';
        cloud_last_upload = time(NULL);
        pthread_mutex_unlock(&cloud_mutex);
        log_debug("Uploaded %s to %s", item->file_path, remote);
    } else {
        finish_item(item->id, UPLOAD_WAITING, NULL, 0, err);
        pthread_mutex_lock(&cloud_mutex);
        bool changed = cloud_state != CLOUD_STATE_ERROR;
        if (cloud_cfg.enabled) cloud_state = CLOUD_STATE_ERROR;
        copy_str(cloud_error, sizeof(cloud_error), err);
        pthread_mutex_unlock(&cloud_mutex);
        if (changed) log_error("Cloud upload failed (%s); recordings wait in the queue and are retried", err);
    }
}

static void *worker_func(void *arg) {
    int index = (int)(intptr_t)arg;
    while (true) {
        pthread_mutex_lock(&wake_mutex);
        bool running = workers_running;
        pthread_mutex_unlock(&wake_mutex);
        if (!running) break;

        cloud_config_t cfg;
        cloud_get_config(&cfg);
        upload_item_t item;
        if (cfg.enabled && claim_next(&cfg, &item)) {
            upload_one(&cfg, &item);
            continue;
        }
        if (index == 0) {
            /* tidy rows of recordings deleted since (by retention) */
            static time_t last_tidy = 0;
            time_t now = time(NULL);
            if (now - last_tidy > 3600) {
                last_tidy = now;
                sqlite3 *db = get_db_handle();
                if (db) {
                    pthread_mutex_lock(get_db_mutex());
                    sqlite3_exec(db, "DELETE FROM cloud_uploads WHERE recording_id NOT IN (SELECT id FROM recordings);",
                                 NULL, NULL, NULL);
                    pthread_mutex_unlock(get_db_mutex());
                }
            }
        }
        pthread_mutex_lock(&wake_mutex);
        if (workers_running) {
            struct timespec until;
            clock_gettime(CLOCK_REALTIME, &until);
            until.tv_sec += CLOUD_IDLE_WAIT_SEC;
            pthread_cond_timedwait(&wake_cond, &wake_mutex, &until);
        }
        pthread_mutex_unlock(&wake_mutex);
    }
    return NULL;
}

int cloud_storage_init(const char *config_dir) {
    snprintf(cloud_config_path, sizeof(cloud_config_path), "%s/%s",
             config_dir && config_dir[0] ? config_dir : "/etc/lightnvr", CLOUD_CONFIG_FILE);
    memset(&cloud_cfg, 0, sizeof(cloud_cfg));
    load_config_file();
    cloud_state = cloud_cfg.enabled ? CLOUD_STATE_ACTIVE : CLOUD_STATE_DISABLED;

    /* uploads cut short by the last shutdown are retried */
    sqlite3 *db = get_db_handle();
    if (db) {
        pthread_mutex_lock(get_db_mutex());
        sqlite3_exec(db, "UPDATE cloud_uploads SET status = 0 WHERE status = 3;", NULL, NULL, NULL);
        pthread_mutex_unlock(get_db_mutex());
    }
    if (cloud_cfg.enabled) {
        log_info("Cloud storage enabled (%s %s/%s); uploading recordings in the background",
                 cloud_cfg.provider, cloud_cfg.bucket, cloud_cfg.prefix);
    }

    workers_running = true;
    for (int i = 0; i < CLOUD_WORKERS; i++) {
        if (pthread_create(&workers[i], NULL, worker_func, (void *)(intptr_t)i) == 0) worker_count++;
    }
    return worker_count > 0 ? 0 : -1;
}

void cloud_storage_shutdown(void) {
    cloud_stopping = 1;
    pthread_mutex_lock(&wake_mutex);
    workers_running = false;
    pthread_cond_broadcast(&wake_cond);
    pthread_mutex_unlock(&wake_mutex);
    for (int i = 0; i < worker_count; i++) pthread_join(workers[i], NULL);
    worker_count = 0;
}
