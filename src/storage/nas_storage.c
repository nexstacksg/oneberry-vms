/**
 * Network storage (NAS) for recordings: settings, mount, health monitor.
 *
 * See include/storage/nas_storage.h. NFS is mounted with mount.nfs
 * (nfs-common in the image) via fork/exec, so no shell is involved. SMB is
 * mounted with mount(2) directly (mount.cifs needs extra capabilities in a
 * container); the password is never on a command line or in the logs.
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <cjson/cJSON.h>

#include "storage/nas_storage.h"
#include "core/config.h"
#include "core/logger.h"

#define NAS_CONFIG_FILE "nas.json"
#define NAS_MOUNT_TIMEOUT_SEC 25
#define NAS_MONITOR_INTERVAL_SEC 15
/* A check that takes longer means the NAS is gone (writes would hang) */
#define NAS_PROBE_TIMEOUT_SEC 8

static pthread_mutex_t nas_mutex = PTHREAD_MUTEX_INITIALIZER;
static nas_config_t nas_cfg;
static nas_status_t nas_status;
static char nas_config_path[PATH_MAX];
static pthread_t monitor_thread;
static bool monitor_running = false;
static pthread_mutex_t monitor_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t monitor_cond = PTHREAD_COND_INITIALIZER;

const char *nas_state_name(nas_state_t state) {
    switch (state) {
        case NAS_STATE_CONNECTED: return "connected";
        case NAS_STATE_UNAVAILABLE: return "unavailable";
        default: return "disabled";
    }
}

/* ---- settings ---------------------------------------------------------- */

static void copy_str(char *dst, size_t len, const char *src) {
    snprintf(dst, len, "%s", src ? src : "");
}

/* Characters that would change the meaning of mount options or arguments. */
static bool has_unsafe_chars(const char *s) {
    for (; s && *s; s++) {
        if (*s == ',' || *s == '\n' || *s == '\r' || *s == '"' || (unsigned char)*s < 0x20) return true;
    }
    return false;
}

static bool valid_server(const char *s) {
    if (!s || !*s || strlen(s) > 253) return false;
    for (; *s; s++) {
        if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') ||
              *s == '.' || *s == '-' || *s == ':' || *s == '_')) {
            return false;
        }
    }
    return true;
}

static bool valid_version(const char *type, const char *v) {
    static const char *nfs[] = {"4.2", "4.1", "4", "3", NULL};
    static const char *smb[] = {"3.1.1", "3.0", "2.1", "2.0", "1.0", NULL};
    const char **list = strcmp(type, "nfs") == 0 ? nfs : smb;
    for (int i = 0; list[i]; i++) {
        if (strcmp(list[i], v) == 0) return true;
    }
    return false;
}

static int validate_nas_config(nas_config_t *cfg, char *err, size_t err_len) {
    if (strcmp(cfg->type, "nfs") != 0 && strcmp(cfg->type, "smb") != 0) {
        snprintf(err, err_len, "Type must be NFS or SMB");
        return -1;
    }
    if (!valid_server(cfg->server)) {
        snprintf(err, err_len, "Enter the NAS IP address or host name");
        return -1;
    }
    /* trim slashes the user may add around an SMB share; NFS paths start with / */
    char *share = cfg->share;
    while (*share == ' ') share++;
    if (strcmp(cfg->type, "smb") == 0) {
        while (*share == '/' || *share == '\\') share++;
    }
    memmove(cfg->share, share, strlen(share) + 1);
    size_t n = strlen(cfg->share);
    while (n > 1 && (cfg->share[n - 1] == '/' || cfg->share[n - 1] == ' ')) cfg->share[--n] = '\0';
    if (strcmp(cfg->type, "nfs") == 0 && cfg->share[0] != '/') {
        char tmp[sizeof(cfg->share)];
        snprintf(tmp, sizeof(tmp), "/%s", cfg->share);
        copy_str(cfg->share, sizeof(cfg->share), tmp);
    }
    if (cfg->share[0] == '\0' || strcmp(cfg->share, "/") == 0 || has_unsafe_chars(cfg->share)) {
        snprintf(err, err_len, "Enter the shared folder (for NFS the export path, e.g. /volume1/nvr)");
        return -1;
    }
    if (has_unsafe_chars(cfg->username) || strchr(cfg->password, '\n') || strchr(cfg->password, '\r')) {
        snprintf(err, err_len, "User name or password contains characters that are not allowed");
        return -1;
    }
    if (cfg->version[0] == '\0') {
        copy_str(cfg->version, sizeof(cfg->version), strcmp(cfg->type, "nfs") == 0 ? "4.1" : "3.0");
    }
    if (!valid_version(cfg->type, cfg->version)) {
        snprintf(err, err_len, "Unsupported %s version %s", strcmp(cfg->type, "nfs") == 0 ? "NFS" : "SMB", cfg->version);
        return -1;
    }
    return 0;
}

static void load_config_file(void) {
    FILE *fp = fopen(nas_config_path, "r");
    if (!fp) return;
    char buf[4096];
    size_t len = fread(buf, 1, sizeof(buf) - 1, fp);
    fclose(fp);
    buf[len] = '\0';
    cJSON *doc = cJSON_Parse(buf);
    if (!doc) {
        log_warn("NAS settings file %s is not valid JSON; ignoring it", nas_config_path);
        return;
    }
    const cJSON *v;
    nas_cfg.enabled = cJSON_IsTrue(cJSON_GetObjectItem(doc, "enabled"));
    if ((v = cJSON_GetObjectItem(doc, "type")) && cJSON_IsString(v)) copy_str(nas_cfg.type, sizeof(nas_cfg.type), v->valuestring);
    if ((v = cJSON_GetObjectItem(doc, "server")) && cJSON_IsString(v)) copy_str(nas_cfg.server, sizeof(nas_cfg.server), v->valuestring);
    if ((v = cJSON_GetObjectItem(doc, "share")) && cJSON_IsString(v)) copy_str(nas_cfg.share, sizeof(nas_cfg.share), v->valuestring);
    if ((v = cJSON_GetObjectItem(doc, "username")) && cJSON_IsString(v)) copy_str(nas_cfg.username, sizeof(nas_cfg.username), v->valuestring);
    if ((v = cJSON_GetObjectItem(doc, "password")) && cJSON_IsString(v)) copy_str(nas_cfg.password, sizeof(nas_cfg.password), v->valuestring);
    if ((v = cJSON_GetObjectItem(doc, "version")) && cJSON_IsString(v)) copy_str(nas_cfg.version, sizeof(nas_cfg.version), v->valuestring);
    cJSON_Delete(doc);
}

/* Write the settings readable by root only (it holds the SMB password). */
static int save_config_file(const nas_config_t *cfg) {
    cJSON *doc = cJSON_CreateObject();
    cJSON_AddBoolToObject(doc, "enabled", cfg->enabled);
    cJSON_AddStringToObject(doc, "type", cfg->type);
    cJSON_AddStringToObject(doc, "server", cfg->server);
    cJSON_AddStringToObject(doc, "share", cfg->share);
    cJSON_AddStringToObject(doc, "username", cfg->username);
    cJSON_AddStringToObject(doc, "password", cfg->password);
    cJSON_AddStringToObject(doc, "version", cfg->version);
    char *json = cJSON_Print(doc);
    cJSON_Delete(doc);
    if (!json) return -1;

    char tmp_path[PATH_MAX];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", nas_config_path);
    int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        log_error("Cannot save NAS settings to %s: %s", tmp_path, strerror(errno));
        free(json);
        return -1;
    }
    fchmod(fd, 0600);
    size_t len = strlen(json);
    bool ok = write(fd, json, len) == (ssize_t)len && fsync(fd) == 0;
    close(fd);
    free(json);
    if (!ok || rename(tmp_path, nas_config_path) != 0) {
        log_error("Cannot save NAS settings to %s: %s", nas_config_path, strerror(errno));
        unlink(tmp_path);
        return -1;
    }
    return 0;
}

/* ---- mount ------------------------------------------------------------- */

/* True when @p path is a mount point (different device than its parent). */
static bool is_mount_point(const char *path) {
    struct stat st, parent_st;
    char parent[PATH_MAX];
    snprintf(parent, sizeof(parent), "%s/..", path);
    if (stat(path, &st) != 0 || stat(parent, &parent_st) != 0) return false;
    return st.st_dev != parent_st.st_dev;
}

/* Run mount(8) with @p argv; capture its message in @p err. */
static int run_mount(char *const argv[], char *err, size_t err_len) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        snprintf(err, err_len, "Cannot run mount: %s", strerror(errno));
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        snprintf(err, err_len, "Cannot run mount: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);
        execvp(argv[0], argv);
        fprintf(stderr, "mount helper not found (%s)", strerror(errno));
        _exit(127);
    }
    close(pipefd[1]);
    fcntl(pipefd[0], F_SETFL, O_NONBLOCK);

    char output[512] = {0};
    size_t out_len = 0;
    int status = 0;
    time_t deadline = time(NULL) + NAS_MOUNT_TIMEOUT_SEC;
    for (;;) {
        ssize_t r = read(pipefd[0], output + out_len, sizeof(output) - 1 - out_len);
        if (r > 0) out_len += (size_t)r;
        pid_t done = waitpid(pid, &status, WNOHANG);
        if (done == pid) break;
        if (time(NULL) >= deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            close(pipefd[0]);
            snprintf(err, err_len, "The NAS did not answer within %d seconds (check the address and network)",
                     NAS_MOUNT_TIMEOUT_SEC);
            return -1;
        }
        usleep(100000);
    }
    ssize_t r = read(pipefd[0], output + out_len, sizeof(output) - 1 - out_len);
    if (r > 0) out_len += (size_t)r;
    close(pipefd[0]);
    output[out_len] = '\0';

    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;

    /* First line of the helper's message, without the "mount error(13):" noise */
    char *line = output;
    while (*line == ' ' || *line == '\n') line++;
    char *nl = strchr(line, '\n');
    if (nl) *nl = '\0';
    if (strstr(line, "Permission denied") || strstr(line, "error(13)")) {
        snprintf(err, err_len, "The NAS refused access (check user name, password and share permissions)");
    } else if (strstr(line, "No such file") || strstr(line, "error(2)") || strstr(line, "access denied by server")) {
        snprintf(err, err_len, "Shared folder not found or not allowed for this server: %s", line);
    } else if (strstr(line, "Operation not permitted") || strstr(line, "must be superuser") || strstr(line, "Permission denied")) {
        snprintf(err, err_len, "This server is not allowed to mount network storage (container needs the SYS_ADMIN capability)");
    } else {
        snprintf(err, err_len, "Could not connect: %s", line[0] ? line : "mount failed");
    }
    return -1;
}

static int resolve_server(const char *server, char *ip, size_t ip_len, char *err, size_t err_len) {
    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_socktype = SOCK_STREAM;
    int rc = getaddrinfo(server, NULL, &hints, &res);
    if (rc != 0 || !res) {
        snprintf(err, err_len, "Cannot find the NAS %s (%s)", server, gai_strerror(rc));
        return -1;
    }
    void *addr = res->ai_family == AF_INET6
        ? (void *)&((struct sockaddr_in6 *)res->ai_addr)->sin6_addr
        : (void *)&((struct sockaddr_in *)res->ai_addr)->sin_addr;
    inet_ntop(res->ai_family, addr, ip, (socklen_t)ip_len);
    freeaddrinfo(res);
    return 0;
}

static void describe_mount_errno(int e, char *err, size_t err_len) {
    switch (e) {
        case EACCES:
            snprintf(err, err_len, "The NAS refused access (check user name, password and share permissions)");
            break;
        case ENOENT: case ENXIO: case ENODEV:
            snprintf(err, err_len, "Shared folder not found on the NAS (check the share name)");
            break;
        case EHOSTUNREACH: case ENETUNREACH: case ETIMEDOUT: case ECONNREFUSED: case EHOSTDOWN:
            snprintf(err, err_len, "Cannot reach the NAS (check the address and network): %s", strerror(e));
            break;
        case EPERM:
            snprintf(err, err_len, "This server is not allowed to mount network storage (container needs the SYS_ADMIN capability)");
            break;
        case EOPNOTSUPP: case EPROTONOSUPPORT:
            snprintf(err, err_len, "The NAS does not support this version; try another version");
            break;
        default:
            snprintf(err, err_len, "Could not connect: %s", strerror(e));
    }
}

/* mount(2) in a child process, so a NAS that does not answer cannot block
   longer than NAS_MOUNT_TIMEOUT_SEC (the mount is shared with this process). */
static int run_mount_syscall(const char *source, const char *target, const char *fstype,
                             const char *options, char *err, size_t err_len) {
    pid_t pid = fork();
    if (pid < 0) {
        snprintf(err, err_len, "Cannot start mount: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        int rc = mount(source, target, fstype, MS_NOATIME, options);
        _exit(rc == 0 ? 0 : (errno & 0xff));
    }
    int status = 0;
    time_t deadline = time(NULL) + NAS_MOUNT_TIMEOUT_SEC;
    while (waitpid(pid, &status, WNOHANG) == 0) {
        if (time(NULL) >= deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            snprintf(err, err_len, "The NAS did not answer within %d seconds (check the address and network)",
                     NAS_MOUNT_TIMEOUT_SEC);
            return -1;
        }
        usleep(100000);
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;
    describe_mount_errno(WIFEXITED(status) ? WEXITSTATUS(status) : EIO, err, err_len);
    return -1;
}

static int mount_share(const nas_config_t *cfg, const char *target, char *err, size_t err_len) {
    char source[1024];
    char options[1024];

    if (strcmp(cfg->type, "nfs") == 0) {
        snprintf(source, sizeof(source), "%s:%s", cfg->server, cfg->share);
        /* soft: a lost NAS makes writes fail after ~45 s instead of hanging
           recordings forever; recordings then switch to the local disk */
        snprintf(options, sizeof(options), "vers=%s,proto=tcp,soft,timeo=150,retrans=3,noatime%s",
                 cfg->version, strcmp(cfg->version, "3") == 0 ? ",nolock" : "");
        char *argv[] = {"mount", "-t", "nfs", "-o", options, source, (char *)target, NULL};
        return run_mount(argv, err, err_len);
    }

    /* SMB: mount(2) directly. The mount.cifs helper drops privileges with
       libcap-ng and fails in a container without CAP_DAC_READ_SEARCH; the
       kernel needs only the server address resolved. The password is passed
       in the mount data (not on a command line; hidden in /proc/mounts). */
    char ip[INET6_ADDRSTRLEN];
    if (resolve_server(cfg->server, ip, sizeof(ip), err, err_len) != 0) return -1;
    snprintf(source, sizeof(source), "//%s/%s", cfg->server, cfg->share);
    char user_opt[300] = "guest";
    if (cfg->username[0]) {
        char pass_escaped[sizeof(cfg->password) * 2];
        size_t j = 0;
        for (size_t i = 0; cfg->password[i] && j + 2 < sizeof(pass_escaped); i++) {
            if (cfg->password[i] == ',') pass_escaped[j++] = ',';  /* ",," = literal comma */
            pass_escaped[j++] = cfg->password[i];
        }
        pass_escaped[j] = '\0';
        snprintf(options, sizeof(options),
                 "ip=%s,username=%s,password=%s,vers=%s,uid=0,gid=0,file_mode=0644,dir_mode=0755,soft,nobrl,noserverino",
                 ip, cfg->username, pass_escaped, cfg->version);
        memset(pass_escaped, 0, sizeof(pass_escaped));
    } else {
        snprintf(options, sizeof(options),
                 "ip=%s,%s,vers=%s,uid=0,gid=0,file_mode=0644,dir_mode=0755,soft,nobrl,noserverino",
                 ip, user_opt, cfg->version);
    }
    int rc = run_mount_syscall(source, target, "cifs", options, err, err_len);
    memset(options, 0, sizeof(options));
    return rc;
}

static void unmount_lazy(const char *target) {
    if (is_mount_point(target) && umount2(target, MNT_DETACH) != 0) {
        log_warn("NAS: could not unmount %s: %s", target, strerror(errno));
    }
}

/* Mounted share can be written: create @p dir and a probe file in it. */
static int check_writable(const char *dir, char *err, size_t err_len) {
    if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
        snprintf(err, err_len, "Connected, but cannot create a folder on the NAS: %s", strerror(errno));
        return -1;
    }
    char probe[PATH_MAX];
    snprintf(probe, sizeof(probe), "%s/.lightnvr-write-test", dir);
    FILE *fp = fopen(probe, "w");
    if (!fp || fputs("ok\n", fp) == EOF || fclose(fp) != 0) {
        snprintf(err, err_len, "Connected, but cannot write to the NAS: %s", strerror(errno));
        return -1;
    }
    char buf[8] = {0};
    fp = fopen(probe, "r");
    bool read_ok = fp && fgets(buf, sizeof(buf), fp) && strcmp(buf, "ok\n") == 0;
    if (fp) fclose(fp);
    unlink(probe);
    if (!read_ok) {
        snprintf(err, err_len, "Connected, but a test file could not be read back");
        return -1;
    }
    return 0;
}

static void fill_space(const char *path, nas_status_t *st) {
    struct statvfs vfs;
    if (statvfs(path, &vfs) == 0) {
        st->total_bytes = (uint64_t)vfs.f_blocks * vfs.f_frsize;
        st->free_bytes = (uint64_t)vfs.f_bavail * vfs.f_frsize;
    }
}

/* ---- public ------------------------------------------------------------ */

int nas_test(const nas_config_t *cfg_in, nas_status_t *result, char *err, size_t err_len) {
    nas_config_t cfg = *cfg_in;
    if (validate_nas_config(&cfg, err, err_len) != 0) return -1;

    char target[] = "/run/lightnvr-nas-test-XXXXXX";
    if (!mkdtemp(target)) {
        snprintf(err, err_len, "Cannot create a test folder: %s", strerror(errno));
        return -1;
    }
    int rc = mount_share(&cfg, target, err, err_len);
    if (rc == 0) {
        char dir[PATH_MAX];
        snprintf(dir, sizeof(dir), "%s/recordings", target);
        rc = check_writable(dir, err, err_len);
        if (rc == 0 && result) {
            memset(result, 0, sizeof(*result));
            fill_space(target, result);
        }
        if (umount2(target, 0) != 0) umount2(target, MNT_DETACH);
    }
    rmdir(target);
    return rc;
}

int nas_connect(const nas_config_t *cfg_in, char *err, size_t err_len) {
    nas_config_t cfg = *cfg_in;
    if (validate_nas_config(&cfg, err, err_len) != 0) return -1;

    nas_status_t tested;
    if (nas_test(&cfg, &tested, err, err_len) != 0) return -1;

    pthread_mutex_lock(&nas_mutex);
    /* New recordings stay local while the share is switched */
    nas_status.state = NAS_STATE_DISABLED;
    pthread_mutex_unlock(&nas_mutex);

    unmount_lazy(NAS_MOUNT_POINT);
    mkdir(NAS_MOUNT_POINT, 0755);
    if (mount_share(&cfg, NAS_MOUNT_POINT, err, err_len) != 0) return -1;
    char mp4_dir[PATH_MAX];
    snprintf(mp4_dir, sizeof(mp4_dir), "%s/mp4", NAS_RECORDINGS_DIR);
    if (check_writable(NAS_RECORDINGS_DIR, err, err_len) != 0 ||
        (mkdir(mp4_dir, 0755) != 0 && errno != EEXIST)) {
        if (!err[0]) snprintf(err, err_len, "Cannot create the recordings folder on the NAS");
        unmount_lazy(NAS_MOUNT_POINT);
        return -1;
    }

    cfg.enabled = true;
    pthread_mutex_lock(&nas_mutex);
    nas_cfg = cfg;
    memset(&nas_status, 0, sizeof(nas_status));
    nas_status.state = NAS_STATE_CONNECTED;
    nas_status.last_check = time(NULL);
    nas_status.connected_since = nas_status.last_check;
    fill_space(NAS_MOUNT_POINT, &nas_status);
    pthread_mutex_unlock(&nas_mutex);

    if (save_config_file(&cfg) != 0) {
        snprintf(err, err_len, "Connected, but the NAS settings could not be saved (they will be lost on restart)");
    }
    log_info("NAS connected: %s //%s%s%s; new recordings go to %s",
             cfg.type, cfg.server, cfg.share[0] == '/' ? "" : "/", cfg.share, NAS_RECORDINGS_DIR);
    return 0;
}

int nas_disconnect(void) {
    nas_config_t cfg;
    pthread_mutex_lock(&nas_mutex);
    nas_cfg.enabled = false;
    cfg = nas_cfg;
    memset(&nas_status, 0, sizeof(nas_status));
    nas_status.state = NAS_STATE_DISABLED;
    pthread_mutex_unlock(&nas_mutex);

    /* Lazy: recordings still being written to the NAS finish, then it goes */
    unmount_lazy(NAS_MOUNT_POINT);
    log_info("NAS disconnected; new recordings go to the local disk");
    return save_config_file(&cfg);
}

void nas_get_config(nas_config_t *out) {
    pthread_mutex_lock(&nas_mutex);
    *out = nas_cfg;
    pthread_mutex_unlock(&nas_mutex);
}

void nas_get_status(nas_status_t *out) {
    pthread_mutex_lock(&nas_mutex);
    *out = nas_status;
    pthread_mutex_unlock(&nas_mutex);
}

bool nas_unavailable(void) {
    pthread_mutex_lock(&nas_mutex);
    bool unavailable = nas_cfg.enabled && nas_status.state != NAS_STATE_CONNECTED;
    pthread_mutex_unlock(&nas_mutex);
    return unavailable;
}

bool nas_path_out_of_reach(const char *path) {
    size_t len = strlen(NAS_MOUNT_POINT);
    if (!path || strncmp(path, NAS_MOUNT_POINT, len) != 0 || path[len] != '/') return false;
    pthread_mutex_lock(&nas_mutex);
    bool connected = nas_status.state == NAS_STATE_CONNECTED;
    pthread_mutex_unlock(&nas_mutex);
    return !connected;
}

void nas_recording_root(const char *local_root, char *out, size_t out_len) {
    pthread_mutex_lock(&nas_mutex);
    bool use_nas = nas_status.state == NAS_STATE_CONNECTED;
    pthread_mutex_unlock(&nas_mutex);
    snprintf(out, out_len, "%s", use_nas ? NAS_RECORDINGS_DIR : (local_root ? local_root : ""));
}

void nas_mp4_recording_dir(char *out, size_t out_len) {
    pthread_mutex_lock(&nas_mutex);
    bool use_nas = nas_status.state == NAS_STATE_CONNECTED;
    pthread_mutex_unlock(&nas_mutex);
    if (use_nas) {
        snprintf(out, out_len, "%s/mp4", NAS_RECORDINGS_DIR);
    } else if (g_config.record_mp4_directly && g_config.mp4_storage_path[0] != '\0') {
        snprintf(out, out_len, "%s", g_config.mp4_storage_path);
    } else {
        snprintf(out, out_len, "%s/mp4", g_config.storage_path);
    }
}

static int mkdir_p(const char *path) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) return -1;
            *p = '/';
        }
    }
    return (mkdir(tmp, 0755) != 0 && errno != EEXIST) ? -1 : 0;
}

static void local_mp4_root(char *out, size_t out_len) {
    if (g_config.record_mp4_directly && g_config.mp4_storage_path[0] != '\0') {
        snprintf(out, out_len, "%s", g_config.mp4_storage_path);
    } else {
        snprintf(out, out_len, "%s/mp4", g_config.storage_path);
    }
}

bool nas_retarget_recording_dir(char *dir, size_t dir_len) {
    if (!dir || !dir[0]) return false;
    char nas_root[PATH_MAX], local_root[PATH_MAX], wanted_root[PATH_MAX];
    snprintf(nas_root, sizeof(nas_root), "%s/mp4", NAS_RECORDINGS_DIR);
    local_mp4_root(local_root, sizeof(local_root));
    nas_mp4_recording_dir(wanted_root, sizeof(wanted_root));

    const char *from_root = NULL;
    size_t nas_len = strlen(nas_root), local_len = strlen(local_root);
    if (strncmp(dir, nas_root, nas_len) == 0 && dir[nas_len] == '/') {
        from_root = nas_root;
    } else if (strncmp(dir, local_root, local_len) == 0 && dir[local_len] == '/') {
        from_root = local_root;
    }
    if (!from_root || strcmp(from_root, wanted_root) == 0) return false;

    char moved[PATH_MAX];
    int n = snprintf(moved, sizeof(moved), "%s%s", wanted_root, dir + strlen(from_root));
    if (n < 0 || (size_t)n >= dir_len || mkdir_p(moved) != 0) {
        log_warn("NAS: cannot switch recording folder %s to %s", dir, wanted_root);
        return false;
    }
    log_info("Recording folder switched: %s -> %s", dir, moved);
    snprintf(dir, dir_len, "%s", moved);
    return true;
}

/* ---- monitor ----------------------------------------------------------- */

/* Probes that did not finish in time; reaped later (a process stuck on a
   dead share cannot be waited for without blocking the monitor). */
static pid_t stuck_probes[16];

static void reap_stuck_probes(void) {
    for (size_t i = 0; i < sizeof(stuck_probes) / sizeof(stuck_probes[0]); i++) {
        if (stuck_probes[i] > 0 && waitpid(stuck_probes[i], NULL, WNOHANG) != 0) stuck_probes[i] = 0;
    }
}

/* Write and read back a file on the NAS in a child process, so a NAS that
   stopped answering is noticed within NAS_PROBE_TIMEOUT_SEC instead of the
   share's own (much longer) timeout. Fills @p space on success. */
static bool probe_nas(nas_status_t *space, char *err, size_t err_len) {
    reap_stuck_probes();
    pid_t pid = fork();
    if (pid < 0) {
        return check_writable(NAS_RECORDINGS_DIR, err, err_len) == 0;
    }
    if (pid == 0) {
        char child_err[8];
        _exit(check_writable(NAS_RECORDINGS_DIR, child_err, sizeof(child_err)) == 0 ? 0 : 1);
    }
    int status = 0;
    time_t deadline = time(NULL) + NAS_PROBE_TIMEOUT_SEC;
    pid_t done;
    while ((done = waitpid(pid, &status, WNOHANG)) == 0 && time(NULL) < deadline) {
        usleep(100000);
    }
    if (done == 0) {
        kill(pid, SIGKILL);
        for (size_t i = 0; i < sizeof(stuck_probes) / sizeof(stuck_probes[0]); i++) {
            if (stuck_probes[i] == 0) { stuck_probes[i] = pid; break; }
        }
        snprintf(err, err_len, "The NAS stopped answering (no reply within %d seconds)", NAS_PROBE_TIMEOUT_SEC);
        return false;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        snprintf(err, err_len, "Cannot write to the NAS");
        return false;
    }
    fill_space(NAS_MOUNT_POINT, space);
    return true;
}

/* One check: (re)connect when needed, confirm the share answers. */
static void nas_check(void) {
    nas_config_t cfg;
    nas_state_t before;
    pthread_mutex_lock(&nas_mutex);
    cfg = nas_cfg;
    before = nas_status.state;
    pthread_mutex_unlock(&nas_mutex);
    if (!cfg.enabled) return;

    char err[256] = {0};
    bool ok = false;
    nas_status_t space = {0};
    if (!is_mount_point(NAS_MOUNT_POINT)) {
        mkdir(NAS_MOUNT_POINT, 0755);
        if (mount_share(&cfg, NAS_MOUNT_POINT, err, sizeof(err)) == 0) {
            mkdir(NAS_RECORDINGS_DIR, 0755);
            char mp4_dir[PATH_MAX];
            snprintf(mp4_dir, sizeof(mp4_dir), "%s/mp4", NAS_RECORDINGS_DIR);
            mkdir(mp4_dir, 0755);
        }
    }
    if (is_mount_point(NAS_MOUNT_POINT)) {
        ok = probe_nas(&space, err, sizeof(err));
    } else if (!err[0]) {
        snprintf(err, sizeof(err), "Not mounted");
    }

    pthread_mutex_lock(&nas_mutex);
    if (nas_cfg.enabled) {  /* not disconnected meanwhile */
        nas_status.last_check = time(NULL);
        if (ok) {
            if (nas_status.state != NAS_STATE_CONNECTED) nas_status.connected_since = nas_status.last_check;
            nas_status.state = NAS_STATE_CONNECTED;
            nas_status.total_bytes = space.total_bytes;
            nas_status.free_bytes = space.free_bytes;
            nas_status.error[0] = '\0';
        } else {
            nas_status.state = NAS_STATE_UNAVAILABLE;
            copy_str(nas_status.error, sizeof(nas_status.error), err);
        }
    }
    nas_state_t after = nas_status.state;
    pthread_mutex_unlock(&nas_mutex);

    if (before != after) {
        if (after == NAS_STATE_CONNECTED) {
            log_info("NAS available: new recordings go to %s", NAS_RECORDINGS_DIR);
        } else {
            log_error("NAS not available (%s): new recordings go to the local disk until it is back", err);
        }
    }
}

static void *monitor_func(void *arg) {
    (void)arg;
    pthread_mutex_lock(&monitor_mutex);
    while (monitor_running) {
        struct timespec until;
        clock_gettime(CLOCK_REALTIME, &until);
        until.tv_sec += NAS_MONITOR_INTERVAL_SEC;
        pthread_cond_timedwait(&monitor_cond, &monitor_mutex, &until);
        if (!monitor_running) break;
        pthread_mutex_unlock(&monitor_mutex);
        nas_check();
        pthread_mutex_lock(&monitor_mutex);
    }
    pthread_mutex_unlock(&monitor_mutex);
    return NULL;
}

int nas_storage_init(const char *config_dir) {
    snprintf(nas_config_path, sizeof(nas_config_path), "%s/%s",
             config_dir && config_dir[0] ? config_dir : "/etc/lightnvr", NAS_CONFIG_FILE);
    memset(&nas_cfg, 0, sizeof(nas_cfg));
    memset(&nas_status, 0, sizeof(nas_status));
    load_config_file();

    if (nas_cfg.enabled) {
        log_info("NAS storage is enabled (%s //%s); connecting before recordings start",
                 nas_cfg.type, nas_cfg.server);
        nas_check();  /* recordings start on the NAS if it answers now */
    }

    pthread_mutex_lock(&monitor_mutex);
    monitor_running = true;
    pthread_mutex_unlock(&monitor_mutex);
    if (pthread_create(&monitor_thread, NULL, monitor_func, NULL) != 0) {
        log_error("Could not start the NAS monitor thread");
        monitor_running = false;
        return -1;
    }
    return 0;
}

void nas_storage_shutdown(void) {
    pthread_mutex_lock(&monitor_mutex);
    bool was_running = monitor_running;
    monitor_running = false;
    pthread_cond_signal(&monitor_cond);
    pthread_mutex_unlock(&monitor_mutex);
    if (was_running) pthread_join(monitor_thread, NULL);
}
