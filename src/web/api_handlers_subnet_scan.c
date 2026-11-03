#define _GNU_SOURCE

/**
 * Subnet Scan: discover ONVIF and RTSP cameras in an IPv4 range and try the
 * user's common credentials on each one.
 *
 *   IP range ──► probe ──┬─ ONVIF: unicast WS-Discovery (onvif_discovery)
 *                        └─ RTSP:  TCP connect + OPTIONS check
 *            ──► authenticate (worker pool)
 *                        ├─ ONVIF: GetProfiles with the credentials
 *                        └─ RTSP:  known vendor stream paths (discovery_find_rtsp_stream)
 *            ──► results: Ready / Credentials failed / Needs RTSP path / Busy / Error
 *
 * Adding cameras is not done here: the UI creates them through the normal
 * POST /api/streams, like every other add flow. Credentials are only held in
 * memory while a scan or retry runs and are never logged or returned.
 */

#include <arpa/inet.h>
#include <cjson/cJSON.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "web/api_handlers_subnet_scan.h"
#include "web/api_handlers_discovery.h"
#include "web/httpd_utils.h"
#include "web/request_response.h"
#include "core/config.h"
#include "core/logger.h"
#include "database/db_streams.h"
#include "utils/ip_range.h"
#include "video/onvif_device_management.h"
#include "video/onvif_discovery.h"
#include "video/onvif_soap.h"
#include "utils/poll_wait.h"

#undef LOG_COMPONENT
#define LOG_COMPONENT "SubnetScan"

#define SUBNET_SCAN_MAX_DEVICES 256
#define SUBNET_SCAN_DEFAULT_RTSP_PORT 554
#define SUBNET_SCAN_DEFAULT_CONCURRENCY 16
#define SUBNET_SCAN_MIN_CONCURRENCY 4
#define SUBNET_SCAN_MAX_CONCURRENCY 32
#define SUBNET_SCAN_MAX_AUTH_WORKERS 8
#define SUBNET_SCAN_CONNECT_TIMEOUT_MS 800
#define SUBNET_SCAN_OPTIONS_TIMEOUT_MS 1500

typedef enum {
    AUTH_PENDING = 0,
    AUTH_OK,
    AUTH_CREDENTIALS_FAILED,
    AUTH_NEEDS_RTSP_PATH,
    AUTH_BUSY,
    AUTH_ERROR
} auth_status_t;

typedef struct {
    char ip[16];
    bool onvif;                         /* false = RTSP-only */
    char brand[64];
    char model[64];
    char onvif_url[MAX_URL_LENGTH];     /* device_service URL */
    int onvif_port;
    int rtsp_port;
    char profile_token[64];             /* ONVIF main profile */
    char stream_url[MAX_URL_LENGTH];    /* without credentials */
    char sub_stream_url[MAX_URL_LENGTH];
    int width;
    int height;
    char codec[32];
    auth_status_t auth;
    bool onvif_login_ok;                /* ONVIF device whose ONVIF login worked */
    char message[160];
} subnet_device_t;

typedef struct {
    pthread_mutex_t lock;
    unsigned int scan_id;
    bool running;
    bool completed;
    volatile bool cancel_requested;
    bool cancelled;
    char error[160];
    const char *phase;                  /* "probing", "authenticating", "done" */
    uint32_t first;
    uint32_t last;
    int rtsp_port;
    int concurrency;
    int total_hosts;
    int scanned_hosts;
    int processed;                      /* devices authenticated so far */
    int device_count;
    int next_device;                    /* auth worker queue position */
    subnet_device_t devices[SUBNET_SCAN_MAX_DEVICES];
    char username[64];                  /* held only while the scan runs */
    char password[128];
} subnet_scan_state_t;

static subnet_scan_state_t g_scan = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .phase = "idle",
};

static const char *auth_status_name(auth_status_t status) {
    switch (status) {
        case AUTH_OK: return "ready";
        case AUTH_CREDENTIALS_FAILED: return "credentials_failed";
        case AUTH_NEEDS_RTSP_PATH: return "needs_rtsp_path";
        case AUTH_BUSY: return "busy";
        case AUTH_ERROR: return "error";
        default: return "pending";
    }
}

static void wipe(void *buffer, size_t size) {
    volatile unsigned char *p = buffer;
    while (size--) *p++ = 0;
}

/* ---------------------------------------------------------------------------
 * Probing
 * ------------------------------------------------------------------------ */

typedef struct {
    uint32_t first;
    uint32_t last;
    onvif_device_info_t devices[SUBNET_SCAN_MAX_DEVICES];
    int count;
} onvif_probe_job_t;

static void *onvif_probe_thread(void *arg) {
    onvif_probe_job_t *job = arg;
    job->count = discover_onvif_devices_in_range(job->first, job->last, job->devices, SUBNET_SCAN_MAX_DEVICES);
    return NULL;
}

/* Connect to `port` on hosts [start, end] at once (non-blocking) and record
 * which accept within the timeout. `open` is indexed from `start`. */
static void probe_tcp_batch(uint32_t start, uint32_t end, int port, bool *open) {
    int count = (int)(end - start + 1);
    int socks[SUBNET_SCAN_MAX_CONCURRENCY];
    for (int i = 0; i < count; i++) {
        socks[i] = -1;
        open[i] = false;
        int sock = socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) continue;
        fcntl(sock, F_SETFL, fcntl(sock, F_GETFL, 0) | O_NONBLOCK);
        struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port),
                                    .sin_addr.s_addr = htonl(start + (uint32_t)i) };
        if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            open[i] = true;
            close(sock);
        } else if (errno == EINPROGRESS) {
            socks[i] = sock;
        } else {
            close(sock);
        }
    }

    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    long deadline_ms = deadline.tv_sec * 1000L + deadline.tv_nsec / 1000000L + SUBNET_SCAN_CONNECT_TIMEOUT_MS;
    for (;;) {
        // poll(), not select(): socket numbers can be above FD_SETSIZE with many cameras
        struct pollfd pfds[SUBNET_SCAN_MAX_CONCURRENCY];
        int waiting = 0;
        for (int i = 0; i < count; i++) {
            pfds[i].fd = socks[i];  // negative fds are ignored by poll()
            pfds[i].events = POLLOUT;
            pfds[i].revents = 0;
            if (socks[i] >= 0) waiting++;
        }
        if (waiting == 0) break;

        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long remaining = deadline_ms - (now.tv_sec * 1000L + now.tv_nsec / 1000000L);
        if (remaining <= 0) break;
        int ready;
        do {
            ready = poll(pfds, (nfds_t)count, (int)remaining);
        } while (ready < 0 && errno == EINTR);
        if (ready <= 0) break;

        for (int i = 0; i < count; i++) {
            if (socks[i] >= 0 && (pfds[i].revents & (POLLOUT | POLLERR | POLLHUP))) {
                int so_error = 0;
                socklen_t len = sizeof(so_error);
                getsockopt(socks[i], SOL_SOCKET, SO_ERROR, &so_error, &len);
                open[i] = so_error == 0;
                close(socks[i]);
                socks[i] = -1;
            }
        }
    }
    for (int i = 0; i < count; i++) {
        if (socks[i] >= 0) close(socks[i]);
    }
}

static int onvif_port_from_url(const char *url) {
    const char *host = strstr(url, "://");
    if (!host) return 80;
    host += 3;
    const char *slash = strchr(host, '/');
    const char *colon = strchr(host, ':');
    if (colon && (!slash || colon < slash)) {
        int port = atoi(colon + 1);
        if (port > 0 && port <= 65535) return port;
    }
    return strncmp(url, "https", 5) == 0 ? 443 : 80;
}

static bool is_known(const char *value) {
    return value && value[0] && strcasecmp(value, "Unknown") != 0 &&
           strcmp(value, "NetworkVideoTransmitter") != 0;
}

/* ---------------------------------------------------------------------------
 * Authentication (shared by the scan workers and the retry endpoint)
 * ------------------------------------------------------------------------ */

static void authenticate_rtsp(subnet_device_t *device, const char *username, const char *password,
                              const volatile bool *cancel);

static void authenticate_onvif(subnet_device_t *device, const char *username, const char *password,
                               const volatile bool *cancel) {
    onvif_profile_t profiles[16];
    onvif_clear_last_fault();
    int count = get_onvif_device_profiles(device->onvif_url, username, password, profiles, 16);
    if (count > 0) {
        int main_index = -1, sub_index = -1;
        for (int i = 0; i < count; i++) {
            if (profiles[i].stream_uri[0] == '\0') continue;
            long pixels = (long)profiles[i].width * profiles[i].height;
            if (main_index < 0 || pixels > (long)profiles[main_index].width * profiles[main_index].height) {
                main_index = i;
            }
        }
        for (int i = 0; i < count; i++) {
            if (i == main_index || profiles[i].stream_uri[0] == '\0') continue;
            if (strcmp(profiles[i].stream_uri, profiles[main_index].stream_uri) == 0) continue;
            long pixels = (long)profiles[i].width * profiles[i].height;
            if (sub_index < 0 || pixels < (long)profiles[sub_index].width * profiles[sub_index].height) {
                sub_index = i;
            }
        }
        if (main_index >= 0) {
            onvif_profile_t *p = &profiles[main_index];
            snprintf(device->stream_url, sizeof(device->stream_url), "%s", p->stream_uri);
            snprintf(device->profile_token, sizeof(device->profile_token), "%s", p->token);
            snprintf(device->codec, sizeof(device->codec), "%s", p->encoding);
            device->width = p->width;
            device->height = p->height;
            if (sub_index >= 0) {
                snprintf(device->sub_stream_url, sizeof(device->sub_stream_url), "%s",
                         profiles[sub_index].stream_uri);
            }
            device->auth = AUTH_OK;
            device->onvif_login_ok = true;
            device->message[0] = '\0';
            return;
        }
    }

    const char *fault = onvif_get_last_fault();
    if (strcasestr(fault, "NotAuthorized") || strcasestr(fault, "not authorized")) {
        // Many cameras keep a separate ONVIF user list; the same login may still
        // work for video, so try the RTSP stream search before giving up
        authenticate_rtsp(device, username, password, cancel);
        if (device->auth == AUTH_OK) {
            snprintf(device->message, sizeof(device->message), "%s",
                     "ONVIF login was rejected, so the camera connects over RTSP (no ONVIF features such as PTZ)");
        } else if (device->auth != AUTH_PENDING) {
            device->auth = AUTH_CREDENTIALS_FAILED;
            snprintf(device->message, sizeof(device->message), "%s",
                     "The camera rejected the username or password (for ONVIF, some cameras keep a separate ONVIF user list)");
        }
    } else if (fault[0]) {
        device->auth = AUTH_ERROR;
        snprintf(device->message, sizeof(device->message), "ONVIF error: %.140s", fault);
    } else {
        device->auth = AUTH_ERROR;
        snprintf(device->message, sizeof(device->message), "%s", "The camera did not return any video streams over ONVIF");
    }
}

static void authenticate_rtsp(subnet_device_t *device, const char *username, const char *password,
                              const volatile bool *cancel) {
    rtsp_found_stream_t found;
    rtsp_probe_result_t result = discovery_find_rtsp_stream(device->ip, device->rtsp_port, username, password,
                                                            device->brand, device->model, cancel, &found);
    snprintf(device->message, sizeof(device->message), "%s", found.message);
    switch (result) {
        case RTSP_PROBE_FOUND:
            snprintf(device->stream_url, sizeof(device->stream_url), "%s", found.main_url);
            snprintf(device->sub_stream_url, sizeof(device->sub_stream_url), "%s", found.sub_url);
            snprintf(device->codec, sizeof(device->codec), "%s", found.codec);
            device->width = found.width;
            device->height = found.height;
            device->auth = AUTH_OK;
            break;
        case RTSP_PROBE_AUTH_FAILED: device->auth = AUTH_CREDENTIALS_FAILED; break;
        case RTSP_PROBE_NO_PATH: device->auth = AUTH_NEEDS_RTSP_PATH; break;
        case RTSP_PROBE_BUSY: device->auth = AUTH_BUSY; break;
        case RTSP_PROBE_CANCELLED: device->auth = AUTH_PENDING; snprintf(device->message, sizeof(device->message), "Scan cancelled"); break;
        default: device->auth = AUTH_ERROR; break;
    }
}

static void authenticate_device(subnet_device_t *device, const char *username, const char *password,
                                const volatile bool *cancel) {
    device->stream_url[0] = '\0';
    device->sub_stream_url[0] = '\0';
    device->profile_token[0] = '\0';
    device->onvif_login_ok = false;
    if (device->onvif) {
        authenticate_onvif(device, username, password, cancel);
    } else {
        authenticate_rtsp(device, username, password, cancel);
    }
}

static void *auth_worker(void *arg) {
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&g_scan.lock);
        if (g_scan.cancel_requested || g_scan.next_device >= g_scan.device_count) {
            pthread_mutex_unlock(&g_scan.lock);
            return NULL;
        }
        int index = g_scan.next_device++;
        subnet_device_t device = g_scan.devices[index];
        char username[sizeof(g_scan.username)];
        char password[sizeof(g_scan.password)];
        memcpy(username, g_scan.username, sizeof(username));
        memcpy(password, g_scan.password, sizeof(password));
        pthread_mutex_unlock(&g_scan.lock);

        authenticate_device(&device, username, password, &g_scan.cancel_requested);
        wipe(password, sizeof(password));

        pthread_mutex_lock(&g_scan.lock);
        g_scan.devices[index] = device;
        g_scan.processed++;
        pthread_mutex_unlock(&g_scan.lock);
    }
}

/* ---------------------------------------------------------------------------
 * Scan job
 * ------------------------------------------------------------------------ */

static void add_device_locked(const subnet_device_t *device) {
    for (int i = 0; i < g_scan.device_count; i++) {
        if (strcmp(g_scan.devices[i].ip, device->ip) == 0) return;
    }
    if (g_scan.device_count < SUBNET_SCAN_MAX_DEVICES) {
        g_scan.devices[g_scan.device_count++] = *device;
    }
}

static void *subnet_scan_thread(void *arg) {
    (void)arg;
    pthread_mutex_lock(&g_scan.lock);
    uint32_t first = g_scan.first, last = g_scan.last;
    int rtsp_port = g_scan.rtsp_port, concurrency = g_scan.concurrency;
    pthread_mutex_unlock(&g_scan.lock);

    // ONVIF probing runs alongside the RTSP port check
    onvif_probe_job_t *onvif_job = calloc(1, sizeof(*onvif_job));
    pthread_t onvif_tid;
    bool onvif_started = false;
    if (onvif_job) {
        onvif_job->first = first;
        onvif_job->last = last;
        onvif_started = pthread_create(&onvif_tid, NULL, onvif_probe_thread, onvif_job) == 0;
    }

    bool open[SUBNET_SCAN_MAX_CONCURRENCY];
    for (uint64_t start = first; start <= last; start += (uint64_t)concurrency) {
        if (g_scan.cancel_requested) break;
        uint32_t end = (uint32_t)((start + (uint64_t)concurrency - 1 > last) ? last : start + (uint64_t)concurrency - 1);
        probe_tcp_batch((uint32_t)start, end, rtsp_port, open);

        pthread_mutex_lock(&g_scan.lock);
        for (uint32_t i = 0; i <= end - (uint32_t)start; i++) {
            if (!open[i]) continue;
            subnet_device_t device = { .onvif = false, .rtsp_port = rtsp_port, .auth = AUTH_PENDING };
            ip_to_string((uint32_t)start + i, device.ip, sizeof(device.ip));
            snprintf(device.brand, sizeof(device.brand), "Unknown");
            snprintf(device.model, sizeof(device.model), "Unknown");
            add_device_locked(&device);
        }
        g_scan.scanned_hosts = (int)(end - first + 1);
        pthread_mutex_unlock(&g_scan.lock);
    }

    if (onvif_started) {
        pthread_join(onvif_tid, NULL);
    }

    // Merge: an ONVIF answer makes the device ONVIF; plain open RTSP ports must
    // also answer an RTSP OPTIONS request to count as a camera
    pthread_mutex_lock(&g_scan.lock);
    if (onvif_job) {
        for (int i = 0; i < onvif_job->count; i++) {
            const onvif_device_info_t *info = &onvif_job->devices[i];
            subnet_device_t *existing = NULL;
            for (int d = 0; d < g_scan.device_count; d++) {
                if (strcmp(g_scan.devices[d].ip, info->ip_address) == 0) existing = &g_scan.devices[d];
            }
            subnet_device_t device = { .rtsp_port = rtsp_port, .auth = AUTH_PENDING };
            subnet_device_t *target = existing ? existing : &device;
            target->onvif = true;
            snprintf(target->ip, sizeof(target->ip), "%s", info->ip_address);
            snprintf(target->brand, sizeof(target->brand), "%s", is_known(info->manufacturer) ? info->manufacturer : "Unknown");
            snprintf(target->model, sizeof(target->model), "%s", is_known(info->model) ? info->model : "Unknown");
            snprintf(target->onvif_url, sizeof(target->onvif_url), "%s",
                     info->device_service[0] ? info->device_service : info->endpoint);
            target->onvif_port = onvif_port_from_url(target->onvif_url);
            if (!existing) add_device_locked(&device);
        }
    }
    if (!g_scan.cancel_requested) {
        g_scan.scanned_hosts = g_scan.total_hosts;  // ONVIF probing covered the rest
    }
    pthread_mutex_unlock(&g_scan.lock);
    free(onvif_job);

    // Drop open ports that are not RTSP servers (anything can listen on 554)
    for (int i = 0; ; i++) {
        pthread_mutex_lock(&g_scan.lock);
        if (i >= g_scan.device_count || g_scan.cancel_requested) {
            pthread_mutex_unlock(&g_scan.lock);
            break;
        }
        subnet_device_t device = g_scan.devices[i];
        pthread_mutex_unlock(&g_scan.lock);
        if (device.onvif) continue;

        char server[64] = {0};
        int rtsp = discovery_rtsp_options_check(device.ip, device.rtsp_port, SUBNET_SCAN_OPTIONS_TIMEOUT_MS,
                                                server, sizeof(server));
        pthread_mutex_lock(&g_scan.lock);
        if (rtsp != 1) {
            memmove(&g_scan.devices[i], &g_scan.devices[i + 1],
                    (size_t)(g_scan.device_count - i - 1) * sizeof(subnet_device_t));
            g_scan.device_count--;
            i--;
        } else if (server[0]) {
            // The RTSP Server header sometimes names the vendor; use it as a path hint
            snprintf(g_scan.devices[i].model, sizeof(g_scan.devices[i].model), "%s", "Unknown");
            snprintf(g_scan.devices[i].message, sizeof(g_scan.devices[i].message), "RTSP server: %.100s", server);
            if (strcasestr(server, "hikvision")) snprintf(g_scan.devices[i].brand, sizeof(g_scan.devices[i].brand), "Hikvision");
            else if (strcasestr(server, "dahua")) snprintf(g_scan.devices[i].brand, sizeof(g_scan.devices[i].brand), "Dahua");
            else if (strcasestr(server, "axis")) snprintf(g_scan.devices[i].brand, sizeof(g_scan.devices[i].brand), "Axis");
        }
        pthread_mutex_unlock(&g_scan.lock);
    }

    // Authenticate every candidate with a bounded worker pool
    pthread_mutex_lock(&g_scan.lock);
    g_scan.phase = "authenticating";
    g_scan.next_device = 0;
    g_scan.processed = 0;
    int workers = g_scan.device_count < SUBNET_SCAN_MAX_AUTH_WORKERS ? g_scan.device_count : SUBNET_SCAN_MAX_AUTH_WORKERS;
    if (workers > concurrency) workers = concurrency;
    pthread_mutex_unlock(&g_scan.lock);

    pthread_t tids[SUBNET_SCAN_MAX_AUTH_WORKERS];
    int started = 0;
    for (int i = 0; i < workers; i++) {
        if (pthread_create(&tids[started], NULL, auth_worker, NULL) == 0) started++;
    }
    if (started == 0 && workers > 0) {
        auth_worker(NULL);  // could not start threads: do the work here
    }
    for (int i = 0; i < started; i++) {
        pthread_join(tids[i], NULL);
    }

    pthread_mutex_lock(&g_scan.lock);
    g_scan.cancelled = g_scan.cancel_requested;
    g_scan.running = false;
    g_scan.completed = true;
    g_scan.phase = "done";
    wipe(g_scan.username, sizeof(g_scan.username));
    wipe(g_scan.password, sizeof(g_scan.password));
    int found = g_scan.device_count;
    bool cancelled = g_scan.cancelled;
    pthread_mutex_unlock(&g_scan.lock);

    log_info("Subnet scan %s: %d device(s) found", cancelled ? "cancelled" : "finished", found);
    return NULL;
}

/* ---------------------------------------------------------------------------
 * JSON
 * ------------------------------------------------------------------------ */

/* Host part of a stream URL ("rtsp://user:pass@HOST:554/path") */
static bool url_has_host(const char *url, const char *ip) {
    const char *host = url ? strstr(url, "://") : NULL;
    if (!host) return false;
    host += 3;
    const char *path = strchr(host, '/');
    const char *at = memrchr(host, '@', path ? (size_t)(path - host) : strlen(host));
    if (at) host = at + 1;
    size_t ip_len = strlen(ip);
    return strncmp(host, ip, ip_len) == 0 &&
           (host[ip_len] == '\0' || host[ip_len] == ':' || host[ip_len] == '/');
}

static cJSON *device_to_json(const subnet_device_t *device, const stream_config_t *streams, int stream_count) {
    cJSON *item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "id", device->ip);
    cJSON_AddStringToObject(item, "ip", device->ip);
    cJSON_AddStringToObject(item, "protocol", device->onvif ? "onvif" : "rtsp");
    cJSON_AddStringToObject(item, "brand", device->brand);
    cJSON_AddStringToObject(item, "model", device->model);
    cJSON_AddNumberToObject(item, "rtspPort", device->rtsp_port);
    if (device->onvif) {
        cJSON_AddNumberToObject(item, "onvifPort", device->onvif_port);
        cJSON_AddStringToObject(item, "onvifUrl", device->onvif_url);
        cJSON_AddStringToObject(item, "profileToken", device->profile_token);
        cJSON_AddBoolToObject(item, "onvifLogin", device->onvif_login_ok);
    }
    cJSON_AddStringToObject(item, "authStatus", auth_status_name(device->auth));
    cJSON_AddStringToObject(item, "message", device->message);
    cJSON_AddStringToObject(item, "streamUrl", device->stream_url);
    cJSON_AddStringToObject(item, "subStreamUrl", device->sub_stream_url);
    cJSON_AddNumberToObject(item, "width", device->width);
    cJSON_AddNumberToObject(item, "height", device->height);
    cJSON_AddStringToObject(item, "codec", device->codec);

    const char *added_as = NULL;
    for (int i = 0; i < stream_count && !added_as; i++) {
        if (url_has_host(streams[i].url, device->ip) || url_has_host(streams[i].secondary_url, device->ip)) {
            added_as = streams[i].name;
        }
    }
    cJSON_AddBoolToObject(item, "alreadyAdded", added_as != NULL);
    if (added_as) cJSON_AddStringToObject(item, "alreadyAddedAs", added_as);
    return item;
}

static cJSON *scan_status_json_locked(void) {
    cJSON *root = cJSON_CreateObject();
    char start[16] = "", end[16] = "";
    if (g_scan.scan_id) {
        ip_to_string(g_scan.first, start, sizeof(start));
        ip_to_string(g_scan.last, end, sizeof(end));
    }
    cJSON_AddNumberToObject(root, "scanId", g_scan.scan_id);
    cJSON_AddBoolToObject(root, "running", g_scan.running);
    cJSON_AddBoolToObject(root, "completed", g_scan.completed);
    cJSON_AddBoolToObject(root, "cancelled", g_scan.cancelled);
    cJSON_AddStringToObject(root, "phase", g_scan.phase);
    cJSON_AddStringToObject(root, "error", g_scan.error);
    cJSON_AddStringToObject(root, "startIp", start);
    cJSON_AddStringToObject(root, "endIp", end);
    cJSON_AddNumberToObject(root, "rtspPort", g_scan.rtsp_port);
    cJSON_AddNumberToObject(root, "totalHosts", g_scan.total_hosts);
    cJSON_AddNumberToObject(root, "scannedHosts", g_scan.scanned_hosts);
    cJSON_AddNumberToObject(root, "candidates", g_scan.device_count);
    cJSON_AddNumberToObject(root, "processed", g_scan.processed);

    stream_config_t *streams = calloc((size_t)g_config.max_streams, sizeof(stream_config_t));
    int stream_count = streams ? get_all_stream_configs(streams, g_config.max_streams) : 0;
    if (stream_count < 0) stream_count = 0;

    cJSON *devices = cJSON_AddArrayToObject(root, "devices");
    int new_count = 0;
    for (int i = 0; i < g_scan.device_count; i++) {
        cJSON *item = device_to_json(&g_scan.devices[i], streams, stream_count);
        if (!cJSON_IsTrue(cJSON_GetObjectItem(item, "alreadyAdded"))) new_count++;
        cJSON_AddItemToArray(devices, item);
    }
    free(streams);
    cJSON_AddNumberToObject(root, "foundCount", g_scan.device_count);
    cJSON_AddNumberToObject(root, "newCount", new_count);
    return root;
}

static void send_json(http_response_t *res, int status, cJSON *json) {
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!text) {
        http_response_set_json_error(res, 500, "Failed to build response");
        return;
    }
    http_response_set_json(res, status, text);
    free(text);
}

/* ---------------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------------ */

void handle_post_subnet_scan(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) {
        return;
    }
    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    const cJSON *start_json = cJSON_GetObjectItem(body, "startIp");
    const cJSON *end_json = cJSON_GetObjectItem(body, "endIp");
    const cJSON *cidr_json = cJSON_GetObjectItem(body, "cidr");
    const cJSON *username_json = cJSON_GetObjectItem(body, "username");
    const cJSON *password_json = cJSON_GetObjectItem(body, "password");
    const cJSON *port_json = cJSON_GetObjectItem(body, "rtspPort");
    const cJSON *concurrency_json = cJSON_GetObjectItem(body, "concurrency");

    uint32_t first = 0, last = 0;
    char error[160] = {0};
    int parsed = cJSON_IsString(cidr_json) && cidr_json->valuestring[0]
        ? ip_range_parse_cidr(cidr_json->valuestring, &first, &last, error, sizeof(error))
        : ip_range_parse(cJSON_IsString(start_json) ? start_json->valuestring : NULL,
                         cJSON_IsString(end_json) ? end_json->valuestring : NULL,
                         &first, &last, error, sizeof(error));
    if (parsed != 0) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 400, error);
        return;
    }

    int rtsp_port = SUBNET_SCAN_DEFAULT_RTSP_PORT;
    if (port_json && !cJSON_IsNull(port_json)) {
        if (!cJSON_IsNumber(port_json) || port_json->valueint < 1 || port_json->valueint > 65535) {
            cJSON_Delete(body);
            http_response_set_json_error(res, 400, "RTSP port must be between 1 and 65535");
            return;
        }
        rtsp_port = port_json->valueint;
    }
    int concurrency = cJSON_IsNumber(concurrency_json) ? concurrency_json->valueint : SUBNET_SCAN_DEFAULT_CONCURRENCY;
    if (concurrency < SUBNET_SCAN_MIN_CONCURRENCY) concurrency = SUBNET_SCAN_MIN_CONCURRENCY;
    if (concurrency > SUBNET_SCAN_MAX_CONCURRENCY) concurrency = SUBNET_SCAN_MAX_CONCURRENCY;

    const char *username = cJSON_IsString(username_json) ? username_json->valuestring : "";
    const char *password = cJSON_IsString(password_json) ? password_json->valuestring : "";
    if (strlen(username) >= sizeof(g_scan.username) || strlen(password) >= sizeof(g_scan.password)) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 400, "Username or password is too long");
        return;
    }

    pthread_mutex_lock(&g_scan.lock);
    if (g_scan.running) {
        pthread_mutex_unlock(&g_scan.lock);
        cJSON_Delete(body);
        http_response_set_json_error(res, 409, "A subnet scan is already running");
        return;
    }
    g_scan.scan_id++;
    g_scan.running = true;
    g_scan.completed = false;
    g_scan.cancel_requested = false;
    g_scan.cancelled = false;
    g_scan.error[0] = '\0';
    g_scan.phase = "probing";
    g_scan.first = first;
    g_scan.last = last;
    g_scan.rtsp_port = rtsp_port;
    g_scan.concurrency = concurrency;
    g_scan.total_hosts = (int)(last - first + 1);
    g_scan.scanned_hosts = 0;
    g_scan.processed = 0;
    g_scan.device_count = 0;
    g_scan.next_device = 0;
    snprintf(g_scan.username, sizeof(g_scan.username), "%s", username);
    snprintf(g_scan.password, sizeof(g_scan.password), "%s", password);
    pthread_mutex_unlock(&g_scan.lock);

    // The request body held the password too; scrub it before freeing
    if (cJSON_IsString(password_json)) wipe(password_json->valuestring, strlen(password_json->valuestring));
    cJSON_Delete(body);

    char start_text[16], end_text[16];
    ip_to_string(first, start_text, sizeof(start_text));
    ip_to_string(last, end_text, sizeof(end_text));
    log_info("Subnet scan started: %s - %s (%d hosts), RTSP port %d, concurrency %d",
             start_text, end_text, (int)(last - first + 1), rtsp_port, concurrency);

    pthread_t tid;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    int rc = pthread_create(&tid, &attr, subnet_scan_thread, NULL);
    pthread_attr_destroy(&attr);

    pthread_mutex_lock(&g_scan.lock);
    if (rc != 0) {
        g_scan.running = false;
        g_scan.completed = true;
        g_scan.phase = "done";
        snprintf(g_scan.error, sizeof(g_scan.error), "Could not start the scan");
        wipe(g_scan.password, sizeof(g_scan.password));
    }
    cJSON *status = scan_status_json_locked();
    pthread_mutex_unlock(&g_scan.lock);
    send_json(res, rc == 0 ? 202 : 500, status);
}

void handle_get_subnet_scan(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) {
        return;
    }
    pthread_mutex_lock(&g_scan.lock);
    cJSON *status = scan_status_json_locked();
    pthread_mutex_unlock(&g_scan.lock);
    send_json(res, 200, status);
}

void handle_delete_subnet_scan(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) {
        return;
    }
    pthread_mutex_lock(&g_scan.lock);
    if (g_scan.running) {
        g_scan.cancel_requested = true;
        log_info("Subnet scan cancellation requested");
    }
    cJSON *status = scan_status_json_locked();
    pthread_mutex_unlock(&g_scan.lock);
    send_json(res, 200, status);
}

void handle_post_subnet_scan_authenticate(const http_request_t *req, http_response_t *res) {
    if (!httpd_check_admin_privileges(req, res)) {
        return;
    }
    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }
    const cJSON *ip_json = cJSON_GetObjectItem(body, "ip");
    const cJSON *username_json = cJSON_GetObjectItem(body, "username");
    const cJSON *password_json = cJSON_GetObjectItem(body, "password");
    char username[64] = {0}, password[128] = {0};
    bool valid = cJSON_IsString(ip_json) && cJSON_IsString(username_json) && cJSON_IsString(password_json) &&
                 strlen(username_json->valuestring) < sizeof(username) &&
                 strlen(password_json->valuestring) < sizeof(password);
    if (valid) {
        snprintf(username, sizeof(username), "%s", username_json->valuestring);
        snprintf(password, sizeof(password), "%s", password_json->valuestring);
        wipe(password_json->valuestring, strlen(password_json->valuestring));
    }

    subnet_device_t device;
    int index = -1;
    if (valid) {
        pthread_mutex_lock(&g_scan.lock);
        for (int i = 0; i < g_scan.device_count; i++) {
            if (strcmp(g_scan.devices[i].ip, ip_json->valuestring) == 0) {
                index = i;
                device = g_scan.devices[i];
                break;
            }
        }
        pthread_mutex_unlock(&g_scan.lock);
    }
    cJSON_Delete(body);
    if (!valid) {
        wipe(password, sizeof(password));
        http_response_set_json_error(res, 400, "ip, username and password are required");
        return;
    }
    if (index < 0) {
        wipe(password, sizeof(password));
        http_response_set_json_error(res, 404, "This device is not in the current scan results");
        return;
    }

    // Only ever a retry of a device the scan found, so no new targets can be probed here
    static const volatile bool never_cancel = false;
    authenticate_device(&device, username, password, &never_cancel);
    wipe(password, sizeof(password));
    log_info("Subnet scan credential retry for %s: %s", device.ip, auth_status_name(device.auth));

    pthread_mutex_lock(&g_scan.lock);
    if (index < g_scan.device_count && strcmp(g_scan.devices[index].ip, device.ip) == 0) {
        g_scan.devices[index] = device;
    }
    stream_config_t *streams = calloc((size_t)g_config.max_streams, sizeof(stream_config_t));
    int stream_count = streams ? get_all_stream_configs(streams, g_config.max_streams) : 0;
    cJSON *item = device_to_json(&device, streams, stream_count < 0 ? 0 : stream_count);
    free(streams);
    pthread_mutex_unlock(&g_scan.lock);
    send_json(res, 200, item);
}
