/**
 * NAS backup: copies finished local recordings to the NAS (Nx Witness style).
 *
 * See include/storage/nas_backup.h. One worker thread picks the oldest
 * recording waiting for backup and copies it in a child process, so a NAS
 * that stops answering cannot block the server (the child is killed after a
 * timeout). The child uses only system calls (it is forked from a
 * multi-threaded process): no malloc, stdio or logging.
 *
 * nas_backups.status: 0 = waiting (retry at next_attempt), 1 = backed up,
 * 2 = skipped (local file gone before it could be copied), 3 = copying now,
 * 4 = backup removed by backup retention (not copied again).
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE  /* pthread_timedjoin_np */
#endif
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
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "storage/nas_backup.h"
#include "storage/nas_storage.h"
#include "storage/storage_manager_streams_cache.h"
#include "database/db_core.h"
#include "database/db_recordings.h"
#include "web/api_handlers_recordings_thumbnail.h"
#include "core/logger.h"

enum { BACKUP_WAITING = 0, BACKUP_DONE = 1, BACKUP_SKIPPED = 2, BACKUP_RUNNING = 3, BACKUP_EXPIRED = 4 };

#define IDLE_WAIT_SEC 30
#define MAINTENANCE_INTERVAL_SEC 300
/* recordings are copied once they have been finished this long */
#define SETTLE_SEC 20
/* minimum time allowed for one copy; slower than ~200 KB/s counts as stuck */
#define COPY_MIN_TIMEOUT_SEC 600
#define COPY_MIN_BYTES_PER_SEC (200 * 1024)
#define VERIFY_SAMPLES 16
#define VERIFY_SAMPLE_SIZE (64 * 1024)
#define RETENTION_BATCH 100

static pthread_t worker;
static bool worker_started = false;
static bool running = false;
static pthread_mutex_t wake_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake_cond = PTHREAD_COND_INITIALIZER;
static volatile sig_atomic_t stopping = 0;

static pthread_mutex_t status_mutex = PTHREAD_MUTEX_INITIALIZER;
static const char *backup_state = "off";
static char backup_error[256];
static char backup_current[128];
static time_t last_backup_at;
static double last_speed_mbps;

/* Buffers for the copy child (allocated before fork; the child must not malloc) */
static unsigned char copy_buf[1024 * 1024];
static unsigned char verify_a[VERIFY_SAMPLE_SIZE];
static unsigned char verify_b[VERIFY_SAMPLE_SIZE];

/* Run backup retention now: a copy failed because the NAS is full, or the
   settings changed */
static volatile bool maintenance_due = false;

/* Unfinished ".partial" files of copies that were stopped (NAS gone, shutdown);
   deleted at the next maintenance unless a retry of the copy replaced them */
static char stale_partials[16][PATH_MAX];

static void remember_partial(const char *tmp) {
    for (size_t i = 0; i < sizeof(stale_partials) / sizeof(stale_partials[0]); i++) {
        if (stale_partials[i][0] == '\0' || strcmp(stale_partials[i], tmp) == 0) {
            snprintf(stale_partials[i], sizeof(stale_partials[i]), "%s", tmp);
            return;
        }
    }
}

static void delete_stale_partials(void) {
    for (size_t i = 0; i < sizeof(stale_partials) / sizeof(stale_partials[0]); i++) {
        if (stale_partials[i][0] && nas_backup_is_backup_path(stale_partials[i])) {
            if (unlink(stale_partials[i]) == 0) log_debug("NAS backup: removed unfinished copy %s", stale_partials[i]);
        }
        stale_partials[i][0] = '\0';
    }
}

/* Copies that did not finish in time; reaped later */
static pid_t stuck_children[8];

static void copy_str(char *dst, size_t len, const char *src) {
    snprintf(dst, len, "%s", src ? src : "");
}

static void set_state(const char *state, const char *error, const char *current) {
    pthread_mutex_lock(&status_mutex);
    backup_state = state;
    if (error) copy_str(backup_error, sizeof(backup_error), error);
    copy_str(backup_current, sizeof(backup_current), current);
    pthread_mutex_unlock(&status_mutex);
}

bool nas_backup_is_backup_path(const char *path) {
    size_t len = strlen(NAS_BACKUP_DIR);
    return path && strncmp(path, NAS_BACKUP_DIR, len) == 0 && path[len] == '/';
}

void nas_backup_wake(void) {
    maintenance_due = true;
    pthread_mutex_lock(&wake_mutex);
    pthread_cond_broadcast(&wake_cond);
    pthread_mutex_unlock(&wake_mutex);
}

static void wait_for(int seconds) {
    pthread_mutex_lock(&wake_mutex);
    if (running) {
        struct timespec until;
        clock_gettime(CLOCK_REALTIME, &until);
        until.tv_sec += seconds;
        pthread_cond_timedwait(&wake_cond, &wake_mutex, &until);
    }
    pthread_mutex_unlock(&wake_mutex);
}

static bool in_schedule(const nas_config_t *cfg) {
    if (strcmp(cfg->backup_when, "schedule") != 0) return true;
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    int h = tm_now.tm_hour, start = cfg->schedule_start_hour, end = cfg->schedule_end_hour;
    return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

/* ---- queue (database) --------------------------------------------------- */

typedef struct {
    long long id;
    char stream[256];
    char file_path[PATH_MAX];
    time_t start_time;
} backup_item_t;

/* Local recordings that should be backed up and are not yet (or are due for a retry).
   ?1 = since, ?2 = events only, ?3 = now (retry time), ?4 = "\n"-wrapped camera
   list or '' for all, ?5 = finished before, ?6 = start at or after (scan cursor). */
static const char *CANDIDATE_WHERE =
    " FROM recordings r LEFT JOIN nas_backups b ON b.recording_id = r.id"
    " WHERE r.is_complete = 1 AND r.end_time IS NOT NULL AND r.end_time > 0 AND r.end_time <= ?5"
    " AND r.file_path NOT GLOB '" NAS_MOUNT_POINT "/*'"
    " AND r.start_time >= ?1 AND r.start_time >= ?6"
    " AND (?2 = 0 OR r.trigger_type IN ('detection', 'motion'))"
    " AND (?4 = '' OR instr(?4, char(10) || r.stream_name || char(10)) > 0)"
    " AND (b.recording_id IS NULL OR (b.status = 0 AND b.next_attempt <= ?3))";

static void camera_filter(const nas_config_t *cfg, char *out, size_t len) {
    if (cfg->cameras[0]) {
        snprintf(out, len, "\n%s\n", cfg->cameras);
    } else {
        out[0] = '\0';
    }
}

static void bind_candidate(sqlite3_stmt *stmt, const nas_config_t *cfg, const char *cams,
                           time_t retry_before, time_t cursor) {
    sqlite3_bind_int64(stmt, 1, cfg->include_existing ? 0 : (sqlite3_int64)cfg->backup_since);
    sqlite3_bind_int(stmt, 2, cfg->events_only ? 1 : 0);
    sqlite3_bind_int64(stmt, 3, (sqlite3_int64)retry_before);
    sqlite3_bind_text(stmt, 4, cams, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 5, (sqlite3_int64)(time(NULL) - SETTLE_SEC));
    sqlite3_bind_int64(stmt, 6, (sqlite3_int64)cursor);
}

/* Take the oldest waiting recording at or after @p cursor and mark it as copying. */
static bool claim_next(const nas_config_t *cfg, time_t cursor, backup_item_t *item) {
    sqlite3 *db = get_db_handle();
    if (!db) return false;
    char cams[NAS_BACKUP_CAMERAS_LEN + 4];
    camera_filter(cfg, cams, sizeof(cams));
    bool found = false;
    char sql[1536];
    snprintf(sql, sizeof(sql),
             "SELECT r.id, r.stream_name, r.file_path, r.start_time%s ORDER BY r.start_time ASC LIMIT 1;",
             CANDIDATE_WHERE);
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        bind_candidate(stmt, cfg, cams, time(NULL), cursor);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            item->id = sqlite3_column_int64(stmt, 0);
            copy_str(item->stream, sizeof(item->stream), (const char *)sqlite3_column_text(stmt, 1));
            copy_str(item->file_path, sizeof(item->file_path), (const char *)sqlite3_column_text(stmt, 2));
            item->start_time = (time_t)sqlite3_column_int64(stmt, 3);
            found = true;
        }
        sqlite3_finalize(stmt);
    } else {
        log_error("NAS backup: query failed: %s", sqlite3_errmsg(db));
    }
    if (found && sqlite3_prepare_v2(db,
            "INSERT INTO nas_backups (recording_id, status) VALUES (?1, 3)"
            " ON CONFLICT(recording_id) DO UPDATE SET status = 3;", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, item->id);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
    return found;
}

static void mark_failed(long long id, int status, const char *error) {
    sqlite3 *db = get_db_handle();
    if (!db) return;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db,
            "UPDATE nas_backups SET status = ?2, attempts = attempts + 1, last_error = ?3,"
            " next_attempt = ?4 + MIN(1800, 60 * (1 << MIN(attempts, 5))) WHERE recording_id = ?1;",
            -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, id);
        sqlite3_bind_int(stmt, 2, status);
        sqlite3_bind_text(stmt, 3, error ? error : "", -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 4, (sqlite3_int64)time(NULL));
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
}

/*
 * The copy is in place: record it. Returns 1 when the recording still exists
 * at @p local_path, 0 when it was deleted meanwhile (the copy is not needed),
 * -1 on a database error.
 */
static int mark_done(const backup_item_t *item, const char *backup_path, long long bytes) {
    sqlite3 *db = get_db_handle();
    if (!db) return -1;
    int result = -1;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, "SELECT file_path FROM recordings WHERE id = ?1;", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, item->id);
        result = sqlite3_step(stmt) == SQLITE_ROW ? 1 : 0;
        sqlite3_finalize(stmt);
    }
    if (result == 1 && sqlite3_prepare_v2(db,
            "UPDATE nas_backups SET status = 1, attempts = attempts + 1, backup_path = ?2, bytes = ?3,"
            " backed_up_at = ?4, last_error = NULL WHERE recording_id = ?1;", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, item->id);
        sqlite3_bind_text(stmt, 2, backup_path, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 3, bytes);
        sqlite3_bind_int64(stmt, 4, (sqlite3_int64)time(NULL));
        if (sqlite3_step(stmt) != SQLITE_DONE) result = -1;
        sqlite3_finalize(stmt);
    } else if (result == 0 && sqlite3_prepare_v2(db, "DELETE FROM nas_backups WHERE recording_id = ?1;",
                                                 -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, item->id);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
    return result;
}

/* Point recording @p id at @p backup_path if it is still at @p local_path.
   True when it points at the backup now. Caller holds the database mutex. */
static bool repoint_locked(sqlite3 *db, long long id, const char *local_path, const char *backup_path) {
    sqlite3_stmt *stmt = NULL;
    bool ok = false;
    if (sqlite3_prepare_v2(db, "UPDATE recordings SET file_path = ?2 WHERE id = ?1 AND file_path = ?3;",
                           -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, id);
        sqlite3_bind_text(stmt, 2, backup_path, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 3, local_path, -1, SQLITE_TRANSIENT);
        ok = sqlite3_step(stmt) == SQLITE_DONE && sqlite3_changes(db) == 1;
        sqlite3_finalize(stmt);
    }
    if (!ok && sqlite3_prepare_v2(db, "SELECT file_path FROM recordings WHERE id = ?1;", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            const char *now_at = (const char *)sqlite3_column_text(stmt, 0);
            ok = now_at && strcmp(now_at, backup_path) == 0;
        }
        sqlite3_finalize(stmt);
    }
    return ok;
}

bool nas_backup_take_over(uint64_t id, const char *local_path) {
    if (!local_path || !local_path[0] || nas_backup_is_backup_path(local_path)) return false;
    nas_config_t *cfg = malloc(sizeof(*cfg));
    if (!cfg) return false;
    nas_get_config(cfg);
    bool configured = cfg->enabled;
    free(cfg);
    if (!configured) return false;  /* NAS removed: its copies are not used */

    sqlite3 *db = get_db_handle();
    if (!db) return false;
    bool taken = false;
    char backup_path[PATH_MAX] = {0};
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, "SELECT backup_path FROM nas_backups WHERE recording_id = ?1 AND status = 1;",
                           -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, (sqlite3_int64)id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            copy_str(backup_path, sizeof(backup_path), (const char *)sqlite3_column_text(stmt, 0));
        }
        sqlite3_finalize(stmt);
    }
    if (nas_backup_is_backup_path(backup_path)) {
        taken = repoint_locked(db, (long long)id, local_path, backup_path);
    }
    pthread_mutex_unlock(get_db_mutex());
    if (taken) log_debug("NAS backup: recording %llu now plays from %s", (unsigned long long)id, backup_path);
    return taken;
}

/* ---- copy --------------------------------------------------------------- */

typedef struct {
    int code;          /* 0 = ok, see copy_error_text() */
    int err;           /* errno */
    long long bytes;
    long long elapsed_ms;
} copy_result_t;

enum { COPY_OK = 0, COPY_NO_SOURCE, COPY_MKDIR, COPY_CREATE, COPY_READ, COPY_WRITE, COPY_SYNC,
       COPY_VERIFY_SIZE, COPY_VERIFY_DATA, COPY_RENAME, COPY_TIMEOUT, COPY_FORK };

static void copy_error_text(const copy_result_t *r, char *out, size_t len) {
    const char *what;
    switch (r->code) {
        case COPY_NO_SOURCE: what = "Local recording file is missing"; break;
        case COPY_MKDIR: what = "Cannot create the backup folder on the NAS"; break;
        case COPY_CREATE: what = "Cannot create the backup file on the NAS"; break;
        case COPY_READ: what = "Cannot read the local recording"; break;
        case COPY_WRITE: what = r->err == ENOSPC ? "The NAS is full" : "Writing to the NAS failed"; break;
        case COPY_SYNC: what = "The NAS did not confirm the write"; break;
        case COPY_VERIFY_SIZE: what = "Check failed: the copy on the NAS has the wrong size"; break;
        case COPY_VERIFY_DATA: what = "Check failed: the copy on the NAS differs from the recording"; break;
        case COPY_RENAME: what = "Cannot finish the backup file on the NAS"; break;
        case COPY_TIMEOUT: what = "The NAS stopped answering during the copy"; break;
        case COPY_FORK: what = "Cannot start the copy"; break;
        default: what = "Copy failed"; break;
    }
    if (r->err && r->code != COPY_VERIFY_SIZE && r->code != COPY_VERIFY_DATA && r->code != COPY_TIMEOUT) {
        snprintf(out, len, "%s (%s)", what, strerror(r->err));
    } else {
        snprintf(out, len, "%s", what);
    }
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* mkdir -p using system calls only (runs in the copy child). */
static int child_mkdir_p(const char *path) {
    char tmp[PATH_MAX];
    size_t n = strlen(path);
    if (n >= sizeof(tmp)) return -1;
    memcpy(tmp, path, n + 1);
    for (size_t i = 1; i < n; i++) {
        if (tmp[i] == '/') {
            tmp[i] = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
            tmp[i] = '/';
        }
    }
    return (mkdir(tmp, 0755) != 0 && errno != EEXIST) ? -1 : 0;
}

static bool write_all(int fd, const unsigned char *buf, size_t len) {
    while (len > 0) {
        ssize_t w = write(fd, buf, len);
        if (w < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        buf += w;
        len -= (size_t)w;
    }
    return true;
}

static bool pread_full(int fd, unsigned char *buf, size_t len, off_t off) {
    while (len > 0) {
        ssize_t r = pread(fd, buf, len, off);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return false;
        buf += r;
        len -= (size_t)r;
        off += r;
    }
    return true;
}

/* Body of the copy child: copy @p src to @p tmp at up to @p bytes_per_sec,
   sync, compare samples with the source, rename to @p dst. */
static copy_result_t child_copy(const char *src, const char *dir, const char *tmp, const char *dst,
                                long long bytes_per_sec) {
    copy_result_t r = {0};
    long long start = now_ms();
    int in = open(src, O_RDONLY | O_CLOEXEC);
    struct stat st;
    if (in < 0 || fstat(in, &st) != 0) {
        r.code = COPY_NO_SOURCE;
        r.err = errno;
        return r;
    }
    if (child_mkdir_p(dir) != 0) {
        r.code = COPY_MKDIR;
        r.err = errno;
        close(in);
        return r;
    }
    int out = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (out < 0) {
        r.code = COPY_CREATE;
        r.err = errno;
        close(in);
        return r;
    }
    /* chunks of ~1/8 s at the speed limit, so the limit is smooth */
    size_t chunk = sizeof(copy_buf);
    if (bytes_per_sec > 0 && (long long)chunk > bytes_per_sec / 8) {
        chunk = (size_t)(bytes_per_sec / 8 > 16384 ? bytes_per_sec / 8 : 16384);
    }
    long long sent = 0;
    for (;;) {
        ssize_t n = read(in, copy_buf, chunk);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) {
            r.code = COPY_READ;
            r.err = errno;
            break;
        }
        if (n == 0) break;
        if (!write_all(out, copy_buf, (size_t)n)) {
            r.code = COPY_WRITE;
            r.err = errno;
            break;
        }
        sent += n;
        if (bytes_per_sec > 0) {
            long long due_ms = sent * 1000 / bytes_per_sec;
            long long ahead_ms = due_ms - (now_ms() - start);
            if (ahead_ms > 0) {
                struct timespec ts = { (time_t)(ahead_ms / 1000), (long)(ahead_ms % 1000) * 1000000L };
                while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
            }
        }
    }
    if (r.code == COPY_OK && fsync(out) != 0) {
        r.code = COPY_SYNC;
        r.err = errno;
    }
    if (close(out) != 0 && r.code == COPY_OK) {
        r.code = COPY_SYNC;
        r.err = errno;
    }
    if (r.code == COPY_OK) {
        struct stat copied;
        if (stat(tmp, &copied) != 0 || copied.st_size != st.st_size || sent != (long long)st.st_size) {
            r.code = COPY_VERIFY_SIZE;
        }
    }
    if (r.code == COPY_OK && st.st_size > 0) {
        /* compare samples spread over the file, and its end, with the source */
        int check = open(tmp, O_RDONLY | O_CLOEXEC);
        if (check < 0) {
            r.code = COPY_VERIFY_DATA;
            r.err = errno;
        }
        for (int i = 0; r.code == COPY_OK && i <= VERIFY_SAMPLES; i++) {
            off_t size = st.st_size;
            size_t len = size < VERIFY_SAMPLE_SIZE ? (size_t)size : VERIFY_SAMPLE_SIZE;
            off_t off = i == VERIFY_SAMPLES ? size - (off_t)len : (off_t)((size - (off_t)len) * i / VERIFY_SAMPLES);
            if (!pread_full(in, verify_a, len, off) || !pread_full(check, verify_b, len, off) ||
                memcmp(verify_a, verify_b, len) != 0) {
                r.code = COPY_VERIFY_DATA;
            }
        }
        if (check >= 0) close(check);
    }
    close(in);
    if (r.code == COPY_OK && rename(tmp, dst) != 0) {
        r.code = COPY_RENAME;
        r.err = errno;
    }
    if (r.code != COPY_OK) unlink(tmp);
    r.bytes = sent;
    r.elapsed_ms = now_ms() - start;
    return r;
}

static void reap_stuck(void) {
    for (size_t i = 0; i < sizeof(stuck_children) / sizeof(stuck_children[0]); i++) {
        if (stuck_children[i] > 0 && waitpid(stuck_children[i], NULL, WNOHANG) != 0) stuck_children[i] = 0;
    }
}

/* Run child_copy() in a child process; give up after @p timeout_sec or at shutdown. */
static copy_result_t run_copy(const char *src, const char *dir, const char *tmp, const char *dst,
                              long long bytes_per_sec, int timeout_sec) {
    copy_result_t r = {0};
    reap_stuck();
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        r.code = COPY_FORK;
        r.err = errno;
        return r;
    }
    pid_t pid = fork();
    if (pid < 0) {
        r.code = COPY_FORK;
        r.err = errno;
        close(pipefd[0]);
        close(pipefd[1]);
        return r;
    }
    if (pid == 0) {
        close(pipefd[0]);
        setpriority(PRIO_PROCESS, 0, 10);  /* recording comes first */
        copy_result_t res = child_copy(src, dir, tmp, dst, bytes_per_sec);
        ssize_t ignored = write(pipefd[1], &res, sizeof(res));
        (void)ignored;
        _exit(0);
    }
    close(pipefd[1]);
    int status = 0;
    time_t deadline = time(NULL) + timeout_sec;
    pid_t done;
    int checks = 0;
    while ((done = waitpid(pid, &status, WNOHANG)) == 0) {
        if (stopping || time(NULL) >= deadline) break;
        /* the NAS monitor found it gone (or backup was turned off): stop now */
        if (++checks % 10 == 0 && !nas_backup_ready()) break;
        usleep(100000);
    }
    if (done == 0) {
        kill(pid, SIGKILL);
        if (waitpid(pid, &status, WNOHANG) == 0) {
            for (size_t i = 0; i < sizeof(stuck_children) / sizeof(stuck_children[0]); i++) {
                if (stuck_children[i] == 0) { stuck_children[i] = pid; break; }
            }
        }
        close(pipefd[0]);
        r.code = COPY_TIMEOUT;
        return r;
    }
    if (read(pipefd[0], &r, sizeof(r)) != (ssize_t)sizeof(r)) {
        memset(&r, 0, sizeof(r));
        r.code = COPY_FORK;
    }
    close(pipefd[0]);
    return r;
}

static void safe_component(const char *in, char *out, size_t len) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 1 < len; i++) {
        unsigned char c = (unsigned char)in[i];
        out[j++] = (isalnum(c) || c == '.' || c == '_' || c == '-') ? (char)c : '_';
    }
    out[j] = '\0';
}

static void backup_one(const nas_config_t *cfg, const backup_item_t *item) {
    struct stat st;
    if (stat(item->file_path, &st) != 0) {
        mark_failed(item->id, BACKUP_SKIPPED, "Local recording file no longer exists");
        return;
    }
    /* NAS_BACKUP_DIR/<camera>/<YYYY-MM-DD>/<file name>_r<recording id>.<ext>
       (file names alone can repeat: the counter in them restarts with the
       recorder, and quality folders share names) */
    char stream[128], day[16], dir[PATH_MAX], dst[PATH_MAX], tmp[PATH_MAX + 16];
    safe_component(item->stream, stream, sizeof(stream));
    struct tm tm_start;
    localtime_r(&item->start_time, &tm_start);
    strftime(day, sizeof(day), "%Y-%m-%d", &tm_start);
    const char *name = strrchr(item->file_path, '/');
    name = name ? name + 1 : item->file_path;
    const char *ext = strrchr(name, '.');
    if (!ext || ext == name) ext = name + strlen(name);
    snprintf(dir, sizeof(dir), "%s/%s/%s", NAS_BACKUP_DIR, stream[0] ? stream : "camera", day);
    int n = snprintf(dst, sizeof(dst), "%s/%.*s_r%lld%s", dir, (int)(ext - name), name, item->id, ext);
    /* recordings.file_path holds up to 255 characters */
    if (n < 0 || n >= 256) {
        mark_failed(item->id, BACKUP_SKIPPED, "Backup path too long");
        return;
    }
    snprintf(tmp, sizeof(tmp), "%s.partial", dst);

    set_state("copying", NULL, item->stream);
    long long bytes_per_sec = cfg->bwlimit_mbps > 0 ? (long long)cfg->bwlimit_mbps * 125000LL : 0;
    long long expected_sec = (long long)st.st_size / COPY_MIN_BYTES_PER_SEC;
    if (bytes_per_sec > 0) expected_sec += (long long)st.st_size / bytes_per_sec;
    int timeout = (int)(COPY_MIN_TIMEOUT_SEC + expected_sec);
    copy_result_t r = run_copy(item->file_path, dir, tmp, dst, bytes_per_sec, timeout);
    if (r.code == COPY_TIMEOUT) remember_partial(tmp);

    if (r.code != COPY_OK) {
        char err[256];
        copy_error_text(&r, err, sizeof(err));
        if (r.err == ENOSPC) maintenance_due = true;
        if (r.code == COPY_NO_SOURCE) {
            mark_failed(item->id, BACKUP_SKIPPED, err);
            return;
        }
        mark_failed(item->id, BACKUP_WAITING, err);
        pthread_mutex_lock(&status_mutex);
        bool changed = strcmp(backup_error, err) != 0;
        pthread_mutex_unlock(&status_mutex);
        set_state("error", err, "");
        if (changed) log_error("NAS backup of %s failed: %s; it is retried later", item->file_path, err);
        return;
    }

    int done = mark_done(item, dst, r.bytes);
    if (done == 0) {
        /* recording deleted while it was copied: the copy is not needed */
        unlink(dst);
        set_state("copying", "", "");
        return;
    }
    if (done < 0) {
        mark_failed(item->id, BACKUP_WAITING, "Could not record the backup in the database");
        return;
    }
    pthread_mutex_lock(&status_mutex);
    last_backup_at = time(NULL);
    last_speed_mbps = r.elapsed_ms > 0 ? (double)r.bytes * 8.0 / 1000.0 / (double)r.elapsed_ms : 0;
    backup_error[0] = '\0';
    pthread_mutex_unlock(&status_mutex);
    log_debug("NAS backup: %s -> %s (%lld bytes in %lld ms)", item->file_path, dst, r.bytes, r.elapsed_ms);

    if (cfg->delete_local) {
        /* Move: the recording plays from the NAS copy, the local file goes */
        sqlite3 *db = get_db_handle();
        bool moved = false;
        if (db) {
            pthread_mutex_lock(get_db_mutex());
            moved = repoint_locked(db, item->id, item->file_path, dst);
            pthread_mutex_unlock(get_db_mutex());
        }
        if (moved) {
            if (unlink(item->file_path) != 0 && errno != ENOENT) {
                log_warn("NAS backup: copied, but could not delete local file %s: %s",
                         item->file_path, strerror(errno));
            }
            update_stream_storage_cache_remove_recording(item->stream, (uint64_t)st.st_size);
        }
    }
}

/* ---- backup retention ------------------------------------------------------ */

typedef struct {
    long long id;
    char backup_path[PATH_MAX];
    char file_path[PATH_MAX];  /* where the recording is now; empty = recording gone */
    long long bytes;
    bool protected_rec;
} backup_row_t;

/* Oldest backups (by recording time) matching @p where; ?1 bound to @p param. */
static int fetch_backups(const char *where, long long param, backup_row_t *rows, int max) {
    sqlite3 *db = get_db_handle();
    if (!db) return 0;
    char sql[768];
    snprintf(sql, sizeof(sql),
             "SELECT b.recording_id, b.backup_path, r.file_path, b.bytes, COALESCE(r.protected, 0)"
             " FROM nas_backups b LEFT JOIN recordings r ON r.id = b.recording_id"
             " WHERE b.status = 1 AND %s"
             /* a protected recording that only exists on the NAS is kept */
             " AND NOT (COALESCE(r.protected, 0) = 1 AND r.file_path = b.backup_path)"
             " ORDER BY COALESCE(r.start_time, 0) ASC LIMIT ?2;", where);
    int count = 0;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, param);
        sqlite3_bind_int(stmt, 2, max);
        while (count < max && sqlite3_step(stmt) == SQLITE_ROW) {
            backup_row_t *row = &rows[count++];
            row->id = sqlite3_column_int64(stmt, 0);
            copy_str(row->backup_path, sizeof(row->backup_path), (const char *)sqlite3_column_text(stmt, 1));
            copy_str(row->file_path, sizeof(row->file_path), (const char *)sqlite3_column_text(stmt, 2));
            row->bytes = sqlite3_column_int64(stmt, 3);
            row->protected_rec = sqlite3_column_int(stmt, 4) != 0;
        }
        sqlite3_finalize(stmt);
    } else {
        log_error("NAS backup: retention query failed: %s", sqlite3_errmsg(db));
    }
    pthread_mutex_unlock(get_db_mutex());
    return count;
}

static void exec_id(const char *sql, long long id) {
    sqlite3 *db = get_db_handle();
    if (!db) return;
    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, id);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
}

/* Delete one backup copy. When the recording plays from it (no local file),
   the recording goes too. Returns bytes freed on the NAS (0 = kept). */
static long long delete_backup(const backup_row_t *row) {
    bool only_copy = row->file_path[0] && strcmp(row->file_path, row->backup_path) == 0;
    if (only_copy && row->protected_rec) return 0;  /* protected recordings stay */
    if (nas_backup_is_backup_path(row->backup_path) && unlink(row->backup_path) != 0 && errno != ENOENT) {
        log_warn("NAS backup: cannot delete %s: %s", row->backup_path, strerror(errno));
        return 0;
    }
    if (only_copy) {
        delete_recording_thumbnails((uint64_t)row->id);
        delete_recording_metadata((uint64_t)row->id);
        exec_id("DELETE FROM nas_backups WHERE recording_id = ?1;", row->id);
    } else if (row->file_path[0]) {
        /* local copy still there: keep the recording, do not copy it again */
        exec_id("UPDATE nas_backups SET status = 4, backup_path = NULL WHERE recording_id = ?1;", row->id);
    } else {
        exec_id("DELETE FROM nas_backups WHERE recording_id = ?1;", row->id);
    }
    return row->bytes;
}

static void backup_retention(const nas_config_t *cfg) {
    backup_row_t *rows = calloc(RETENTION_BATCH, sizeof(backup_row_t));
    if (!rows) return;
    int deleted = 0;
    long long freed = 0;

    /* copies of recordings deleted elsewhere (e.g. by hand) */
    int count = fetch_backups("r.id IS NULL AND ?1 = ?1", 0, rows, RETENTION_BATCH);
    for (int i = 0; i < count && !stopping; i++) freed += delete_backup(&rows[i]);

    /* older than "keep backups for" */
    if (cfg->keep_days > 0) {
        long long cutoff = (long long)time(NULL) - (long long)cfg->keep_days * 86400;
        for (int round = 0; round < 50 && !stopping; round++) {
            count = fetch_backups("r.start_time < ?1", cutoff, rows, RETENTION_BATCH);
            int removed = 0;
            for (int i = 0; i < count && !stopping; i++) {
                long long b = delete_backup(&rows[i]);
                if (b > 0) removed++;
                freed += b;
            }
            deleted += removed;
            if (count < RETENTION_BATCH || removed == 0) break;
        }
    }

    /* keep the reserved space free: oldest backups first */
    nas_status_t st;
    nas_get_status(&st);
    long long reserve = (long long)cfg->reserve_gb * 1024LL * 1024LL * 1024LL;
    long long free_now = (long long)st.free_bytes;
    if (st.total_bytes > 0 && free_now < reserve) {
        log_info("NAS backup: %lld GB free, below the %d GB to keep free; deleting the oldest backups",
                 free_now / (1024LL * 1024 * 1024), cfg->reserve_gb);
        for (int round = 0; round < 200 && free_now < reserve && !stopping; round++) {
            count = fetch_backups("1 = 1 AND ?1 = ?1", 0, rows, RETENTION_BATCH);
            int removed = 0;
            for (int i = 0; i < count && free_now < reserve && !stopping; i++) {
                long long b = delete_backup(&rows[i]);
                if (b > 0) {
                    removed++;
                    free_now += b;
                    freed += b;
                }
            }
            deleted += removed;
            if (removed == 0 || count < RETENTION_BATCH) break;
        }
    }
    free(rows);
    if (deleted > 0) {
        log_info("NAS backup retention: deleted %d old backups (%lld MB)", deleted, freed / (1024 * 1024));
    }
}

/* ---- status --------------------------------------------------------------- */

void nas_backup_get_status(nas_backup_status_t *out) {
    memset(out, 0, sizeof(*out));
    pthread_mutex_lock(&status_mutex);
    out->state = backup_state;
    copy_str(out->error, sizeof(out->error), backup_error);
    copy_str(out->current, sizeof(out->current), backup_current);
    out->last_backup_at = last_backup_at;
    out->last_speed_mbps = last_speed_mbps;
    pthread_mutex_unlock(&status_mutex);

    nas_config_t *cfg = malloc(sizeof(*cfg));
    if (!cfg) return;
    nas_get_config(cfg);
    sqlite3 *db = get_db_handle();
    if (!db || !cfg->enabled || strcmp(cfg->role, "backup") != 0) {
        free(cfg);
        return;
    }
    char cams[NAS_BACKUP_CAMERAS_LEN + 4];
    camera_filter(cfg, cams, sizeof(cams));
    char sql[1536];
    snprintf(sql, sizeof(sql), "SELECT COUNT(*), COALESCE(SUM(r.size_bytes), 0), MIN(r.start_time)%s;", CANDIDATE_WHERE);

    struct tm tm_now;
    time_t now = time(NULL);
    localtime_r(&now, &tm_now);
    tm_now.tm_hour = tm_now.tm_min = tm_now.tm_sec = 0;
    time_t midnight = mktime(&tm_now);

    pthread_mutex_lock(get_db_mutex());
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        /* everything waiting, including retries that are not due yet */
        bind_candidate(stmt, cfg, cams, INT64_MAX / 2, 0);
        sqlite3_bind_int64(stmt, 5, (sqlite3_int64)now);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            out->queue_waiting = sqlite3_column_int(stmt, 0);
            out->queue_bytes = (uint64_t)sqlite3_column_int64(stmt, 1);
            out->backed_up_until = (time_t)sqlite3_column_int64(stmt, 2);
        }
        sqlite3_finalize(stmt);
    }
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM nas_backups"
                               " WHERE status = 1 AND backed_up_at >= ?1;", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(stmt, 1, (sqlite3_int64)midnight);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            out->copied_today = sqlite3_column_int(stmt, 0);
            out->copied_today_bytes = (uint64_t)sqlite3_column_int64(stmt, 1);
        }
        sqlite3_finalize(stmt);
    }
    if (sqlite3_prepare_v2(db, "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM nas_backups WHERE status = 1;",
                           -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            out->backups_total = sqlite3_column_int(stmt, 0);
            out->backups_bytes = (uint64_t)sqlite3_column_int64(stmt, 1);
        }
        sqlite3_finalize(stmt);
    }
    pthread_mutex_unlock(get_db_mutex());
    free(cfg);
}

/* ---- worker --------------------------------------------------------------- */

static void *worker_func(void *arg) {
    (void)arg;
    nas_config_t *cfg = malloc(sizeof(*cfg));
    if (!cfg) return NULL;
    time_t last_maintenance = 0;
    time_t cursor = 0;          /* scan from here; reset now and then for retries */
    time_t cursor_reset_at = 0;
    bool was_active = false;

    while (true) {
        pthread_mutex_lock(&wake_mutex);
        bool keep_running = running;
        pthread_mutex_unlock(&wake_mutex);
        if (!keep_running) break;

        nas_get_config(cfg);
        if (!cfg->enabled || strcmp(cfg->role, "backup") != 0) {
            set_state("off", "", "");
            was_active = false;
            wait_for(IDLE_WAIT_SEC);
            continue;
        }
        if (!was_active) {
            log_info("NAS backup on: %s, %s%s, speed limit %d Mbit/s (0 = none), %s",
                     strcmp(cfg->backup_when, "schedule") == 0 ? "scheduled" : "real time",
                     cfg->events_only ? "motion/detection recordings" : "all recordings",
                     cfg->cameras[0] ? " of selected cameras" : "", cfg->bwlimit_mbps,
                     cfg->delete_local ? "local copies deleted after backup" : "local copies kept");
            was_active = true;
            cursor = 0;
        }
        if (!nas_backup_ready()) {
            set_state("nas_unavailable", NULL, "");
            wait_for(15);
            continue;
        }
        time_t now = time(NULL);
        if (now - last_maintenance >= MAINTENANCE_INTERVAL_SEC || maintenance_due) {
            maintenance_due = false;
            last_maintenance = now;
            delete_stale_partials();
            backup_retention(cfg);
            exec_id("DELETE FROM nas_backups WHERE status <> 1 AND recording_id NOT IN (SELECT id FROM recordings)"
                    " AND ?1 = ?1;", 0);
        }
        if (!in_schedule(cfg)) {
            set_state("waiting_schedule", NULL, "");
            wait_for(60);
            continue;
        }
        if (now - cursor_reset_at >= MAINTENANCE_INTERVAL_SEC) {
            cursor = 0;  /* pick up retries that are due */
            cursor_reset_at = now;
        }
        backup_item_t item;
        if (claim_next(cfg, cursor, &item)) {
            cursor = item.start_time;
            backup_one(cfg, &item);
            continue;
        }
        if (cursor != 0) {
            cursor = 0;
            continue;
        }
        pthread_mutex_lock(&status_mutex);
        bool had_error = backup_error[0] != '\0';
        pthread_mutex_unlock(&status_mutex);
        set_state(had_error ? "error" : "up_to_date", NULL, "");
        wait_for(IDLE_WAIT_SEC);
    }
    free(cfg);
    return NULL;
}

int nas_backup_init(void) {
    sqlite3 *db = get_db_handle();
    if (db) {
        /* copies cut short by the last shutdown are done again */
        pthread_mutex_lock(get_db_mutex());
        sqlite3_exec(db, "UPDATE nas_backups SET status = 0, next_attempt = 0 WHERE status = 3;", NULL, NULL, NULL);
        pthread_mutex_unlock(get_db_mutex());
    }
    stopping = 0;
    running = true;
    if (pthread_create(&worker, NULL, worker_func, NULL) != 0) {
        running = false;
        log_error("Could not start the NAS backup thread");
        return -1;
    }
    worker_started = true;
    return 0;
}

void nas_backup_shutdown(void) {
    if (!worker_started) return;
    stopping = 1;
    pthread_mutex_lock(&wake_mutex);
    running = false;
    pthread_cond_broadcast(&wake_cond);
    pthread_mutex_unlock(&wake_mutex);
    /* a NAS that stopped answering can hold the thread in a file call */
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_sec += 10;
    if (pthread_timedjoin_np(worker, NULL, &until) != 0) {
        log_warn("NAS backup thread did not stop in time; leaving it");
        pthread_detach(worker);
    }
    worker_started = false;
}
