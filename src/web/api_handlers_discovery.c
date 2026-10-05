#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200112L

#include "web/api_handlers_discovery.h"
#include "web/httpd_utils.h"
#include "web/request_response.h"
#include "core/config.h"
#include "core/url_utils.h"
#include "video/onvif_discovery.h"
#include "video/onvif_discovery_network.h"

#define LOG_COMPONENT "DiscoveryAPI"
#include "core/logger.h"

#include <arpa/inet.h>
#include <cjson/cJSON.h>
#include <errno.h>
#include <fcntl.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <inttypes.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_UNIVERSAL_DEVICES 128
#define MAX_SCAN_HOSTS 1024
#define MAX_RTSP_BATCH_PROBES 256
#define MAX_RTSP_PORTS 3
#define MAX_RTSP_VALIDATE_PORTS 8
#define MAX_RTSP_VALIDATED_PROFILES 16
#define RTSP_DISCOVERY_CONNECT_TIMEOUT_MS 75
#define RTSP_VALIDATION_TIMEOUT_US "2500000"

typedef struct {
    char ip_address[64];
    char device_type[32];
    char manufacturer[64];
    char model[64];
    char status[64];
    char action[32];
    char onvif_service_url[MAX_URL_LENGTH];
    int rtsp_ports[MAX_RTSP_PORTS];
    int rtsp_port_count;
    bool onvif;
    bool rtsp;
} discovered_camera_t;

typedef struct {
    int width;
    int height;
    double fps;
    char codec[64];
} rtsp_stream_info_t;

typedef struct {
    const char *path;
    const char *name;
    const char *role;
    const char *family;
} rtsp_path_candidate_t;

typedef struct {
    char url[MAX_URL_LENGTH];
    char safe_url[MAX_URL_LENGTH];
    rtsp_stream_info_t info;
    const rtsp_path_candidate_t *candidate;
    int port;
} rtsp_validated_profile_t;

typedef struct {
    pthread_mutex_t mutex;
    bool running;
    bool completed;
    unsigned int scan_id;
    char network[64];
    char error[128];
    discovered_camera_t devices[MAX_UNIVERSAL_DEVICES];
    int count;
} discovery_scan_state_t;

typedef struct {
    char network[64];
    bool include_onvif;
    bool include_rtsp;
    unsigned int scan_id;
} discovery_scan_job_t;

static const int RTSP_PORTS[] = {554, 8554, 10554};
static discovery_scan_state_t g_camera_discovery = {
    .mutex = PTHREAD_MUTEX_INITIALIZER
};

static const rtsp_path_candidate_t COMMON_RTSP_PATHS[] = {
    { "/cam/realmonitor?channel=1&subtype=0", "Dahua/Amcrest Main Stream", "primary", "dahua-realmonitor" },
    { "/cam/realmonitor?channel=1&subtype=1", "Dahua/Amcrest Sub Stream", "secondary", "dahua-realmonitor" },
    { "/Streaming/Channels/101", "Hikvision Main Stream", "primary", "hikvision-channels" },
    { "/Streaming/Channels/102", "Hikvision Sub Stream", "secondary", "hikvision-channels" },
    { "/media/video1", "Uniview Main Stream", "primary", "uniview-media" },
    { "/media/video2", "Uniview Sub Stream", "secondary", "uniview-media" },
    { "/unicast/c1/s0/live", "Uniview Main Stream", "primary", "uniview-unicast" },
    { "/unicast/c1/s1/live", "Uniview Sub Stream", "secondary", "uniview-unicast" },
    { "/h264Preview_01_main", "Reolink Main Stream", "primary", "reolink-preview" },
    { "/h264Preview_01_sub", "Reolink Sub Stream", "secondary", "reolink-preview" },
    { "/axis-media/media.amp", "Axis Main Stream", "primary", "axis-media" },
    { "/axis-media/media.amp?videocodec=h264", "Axis H.264 Stream", "secondary", "axis-media" },
    { "/profile1/media.smp", "Hanwha Main Stream", "primary", "hanwha-profile" },
    { "/profile2/media.smp", "Hanwha Sub Stream", "secondary", "hanwha-profile" },
    { "/videoMain", "Foscam Main Stream", "primary", "foscam-video" },
    { "/videoSub", "Foscam Sub Stream", "secondary", "foscam-video" },
    { "/stream1", "RTSP Main Stream", "primary", "generic-stream" },
    { "/stream2", "RTSP Sub Stream", "secondary", "generic-stream" },
    { "/live", "RTSP Live Stream", "primary", "generic-live" },
    { "/live.sdp", "RTSP Live Stream", "primary", "generic-live" },
    { "/live/ch0", "RTSP Main Stream", "primary", "generic-live-channel" },
    { "/live/ch1", "RTSP Sub Stream", "secondary", "generic-live-channel" },
    { "/ch0_0.h264", "RTSP Main Stream", "primary", "legacy-ch0" },
    { "/ch0_1.h264", "RTSP Sub Stream", "secondary", "legacy-ch0" },
    { NULL, NULL, NULL, NULL }
};

static int resolve_scan_network(const char *requested_network, char *network, size_t network_size) {
    if (requested_network && requested_network[0] != '\0' && strcmp(requested_network, "auto") != 0) {
        snprintf(network, network_size, "%s", requested_network);
        return 0;
    }

    if (g_config.onvif_discovery_network[0] != '\0' &&
        strcmp(g_config.onvif_discovery_network, "auto") != 0) {
        snprintf(network, network_size, "%s", g_config.onvif_discovery_network);
        return 0;
    }

    char detected_networks[10][64];
    int count = detect_local_networks(detected_networks, 10);
    if (count <= 0) {
        return -1;
    }

    snprintf(network, network_size, "%s", detected_networks[0]);
    return 0;
}

static int find_device_by_ip(discovered_camera_t *devices, int count, const char *ip) {
    for (int i = 0; i < count; i++) {
        if (strcmp(devices[i].ip_address, ip) == 0) {
            return i;
        }
    }
    return -1;
}

static void add_rtsp_port(discovered_camera_t *device, int port) {
    for (int i = 0; i < device->rtsp_port_count; i++) {
        if (device->rtsp_ports[i] == port) {
            return;
        }
    }
    if (device->rtsp_port_count < MAX_RTSP_PORTS) {
        device->rtsp_ports[device->rtsp_port_count++] = port;
    }
}

static void set_unknown(char *dst, size_t size) {
    snprintf(dst, size, "%s", "Unknown");
}

static void append_onvif_device(discovered_camera_t *devices, int *count, const onvif_device_info_t *onvif) {
    if (!onvif || onvif->ip_address[0] == '\0') {
        return;
    }

    int index = find_device_by_ip(devices, *count, onvif->ip_address);
    if (index < 0) {
        if (*count >= MAX_UNIVERSAL_DEVICES) {
            return;
        }
        index = (*count)++;
        memset(&devices[index], 0, sizeof(devices[index]));
        snprintf(devices[index].ip_address, sizeof(devices[index].ip_address), "%s", onvif->ip_address);
    }

    discovered_camera_t *device = &devices[index];
    device->onvif = true;
    snprintf(device->device_type, sizeof(device->device_type), "%s",
             device->rtsp ? "ONVIF + RTSP Camera" : "ONVIF Camera");
    snprintf(device->manufacturer, sizeof(device->manufacturer), "%s",
             onvif->manufacturer[0] ? onvif->manufacturer : "Unknown");
    snprintf(device->model, sizeof(device->model), "%s",
             onvif->model[0] ? onvif->model : "Unknown");
    snprintf(device->status, sizeof(device->status), "%s", "Discovered");
    snprintf(device->action, sizeof(device->action), "%s", "Connect");
    snprintf(device->onvif_service_url, sizeof(device->onvif_service_url), "%s",
             onvif->device_service[0] ? onvif->device_service : onvif->endpoint);
}

static void append_rtsp_device(discovered_camera_t *devices, int *count, const char *ip, int port) {
    // This NVR's own go2rtc answers RTSP on its LAN address; don't list it as a camera
    int go2rtc_rtsp_port = g_config.go2rtc_rtsp_port > 0 ? g_config.go2rtc_rtsp_port : 8554;
    if (port == go2rtc_rtsp_port && g_config.go2rtc_external_ip[0] != '\0' &&
        strcmp(ip, g_config.go2rtc_external_ip) == 0) {
        return;
    }

    int index = find_device_by_ip(devices, *count, ip);
    if (index < 0) {
        if (*count >= MAX_UNIVERSAL_DEVICES) {
            return;
        }
        index = (*count)++;
        memset(&devices[index], 0, sizeof(devices[index]));
        snprintf(devices[index].ip_address, sizeof(devices[index].ip_address), "%s", ip);
        set_unknown(devices[index].manufacturer, sizeof(devices[index].manufacturer));
        set_unknown(devices[index].model, sizeof(devices[index].model));
    }

    discovered_camera_t *device = &devices[index];
    device->rtsp = true;
    add_rtsp_port(device, port);
    snprintf(device->device_type, sizeof(device->device_type), "%s",
             device->onvif ? "ONVIF + RTSP Camera" : "RTSP Device");
    if (!device->status[0] || strcmp(device->status, "Discovered") != 0) {
        snprintf(device->status, sizeof(device->status), "%s", "RTSP Found");
    }
    snprintf(device->action, sizeof(device->action), "%s", "Connect");
}

static void publish_discovery_device(unsigned int scan_id, const discovered_camera_t *device) {
    if (!device || device->ip_address[0] == '\0') {
        return;
    }

    pthread_mutex_lock(&g_camera_discovery.mutex);
    if (g_camera_discovery.scan_id == scan_id) {
        int index = find_device_by_ip(g_camera_discovery.devices, g_camera_discovery.count, device->ip_address);
        if (index < 0 && g_camera_discovery.count < MAX_UNIVERSAL_DEVICES) {
            index = g_camera_discovery.count++;
            memset(&g_camera_discovery.devices[index], 0, sizeof(g_camera_discovery.devices[index]));
        }
        if (index >= 0) {
            g_camera_discovery.devices[index] = *device;
        }
    }
    pthread_mutex_unlock(&g_camera_discovery.mutex);
}

static cJSON *device_to_json(const discovered_camera_t *device) {
    cJSON *item = cJSON_CreateObject();
    if (!item) {
        return NULL;
    }

    cJSON_AddStringToObject(item, "ip_address", device->ip_address);
    cJSON_AddStringToObject(item, "device_type", device->device_type[0] ? device->device_type : "RTSP Device");
    cJSON_AddStringToObject(item, "manufacturer", device->manufacturer[0] ? device->manufacturer : "Unknown");
    cJSON_AddStringToObject(item, "model", device->model[0] ? device->model : "Unknown");
    cJSON_AddStringToObject(item, "status", device->status[0] ? device->status : "RTSP Found");
    cJSON_AddStringToObject(item, "action", device->action[0] ? device->action : "Connect");
    cJSON_AddBoolToObject(item, "onvif", device->onvif);
    cJSON_AddBoolToObject(item, "rtsp", device->rtsp);
    cJSON_AddStringToObject(item, "device_service", device->onvif_service_url);
    cJSON_AddStringToObject(item, "endpoint", device->onvif_service_url);

    cJSON *ports = cJSON_AddArrayToObject(item, "rtsp_ports");
    if (ports) {
        for (int i = 0; i < device->rtsp_port_count; i++) {
            cJSON_AddItemToArray(ports, cJSON_CreateNumber(device->rtsp_ports[i]));
        }
    }

    return item;
}

typedef struct {
    int sock;
    char ip_address[64];
} rtsp_probe_t;

static int add_rtsp_probe(rtsp_probe_t *probes, int *probe_count, const char *ip, int port) {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        return -1;
    }

    long flags = fcntl(sock, F_GETFL, 0);
    if (flags >= 0) {
        fcntl(sock, F_SETFL, flags | O_NONBLOCK);
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_aton(ip, &addr.sin_addr) == 0) {
        close(sock);
        return -1;
    }

    int res = connect(sock, (struct sockaddr *)&addr, sizeof(addr));
    if (res == 0) {
        close(sock);
        return 1;
    }

    if (errno != EINPROGRESS) {
        close(sock);
        return -1;
    }

    probes[*probe_count].sock = sock;
    snprintf(probes[*probe_count].ip_address, sizeof(probes[*probe_count].ip_address), "%s", ip);
    (*probe_count)++;
    return 0;
}

static void close_rtsp_probes(rtsp_probe_t *probes, int probe_count) {
    for (int i = 0; i < probe_count; i++) {
        if (probes[i].sock >= 0) {
            close(probes[i].sock);
            probes[i].sock = -1;
        }
    }
}

static int scan_rtsp_port_batch(uint32_t network_addr, uint64_t start_offset, uint64_t host_count, int port,
                                discovered_camera_t *devices, int *count, unsigned int scan_id) {
    rtsp_probe_t probes[MAX_RTSP_BATCH_PROBES];
    int probe_count = 0;
    memset(probes, 0, sizeof(probes));
    for (int i = 0; i < MAX_RTSP_BATCH_PROBES; i++) {
        probes[i].sock = -1;
    }

    uint64_t end_offset = start_offset + MAX_RTSP_BATCH_PROBES - 1;
    if (end_offset > host_count) {
        end_offset = host_count;
    }

    for (uint64_t offset = start_offset; offset <= end_offset && probe_count < MAX_RTSP_BATCH_PROBES; offset++) {
        struct in_addr addr;
        addr.s_addr = htonl(network_addr + (uint32_t)offset);
        const char *ip = inet_ntoa(addr);
        if (!ip) {
            continue;
        }

        char ip_copy[64];
        snprintf(ip_copy, sizeof(ip_copy), "%s", ip);

        int probe_result = add_rtsp_probe(probes, &probe_count, ip_copy, port);
        if (probe_result == 1) {
            append_rtsp_device(devices, count, ip_copy, port);
            int index = find_device_by_ip(devices, *count, ip_copy);
            if (index >= 0) {
                publish_discovery_device(scan_id, &devices[index]);
            }
        }
    }

    if (probe_count <= 0) {
        return 0;
    }

    fd_set writefds;
    FD_ZERO(&writefds);
    int max_fd = -1;
    for (int i = 0; i < probe_count; i++) {
        if (probes[i].sock >= 0) {
            FD_SET(probes[i].sock, &writefds);
            if (probes[i].sock > max_fd) {
                max_fd = probes[i].sock;
            }
        }
    }

    struct timeval tv;
    tv.tv_sec = RTSP_DISCOVERY_CONNECT_TIMEOUT_MS / 1000;
    tv.tv_usec = (long)(RTSP_DISCOVERY_CONNECT_TIMEOUT_MS % 1000) * 1000;

    int ready = select(max_fd + 1, NULL, &writefds, NULL, &tv);
    if (ready > 0) {
        for (int i = 0; i < probe_count; i++) {
            if (probes[i].sock < 0 || !FD_ISSET(probes[i].sock, &writefds)) {
                continue;
            }

            int so_error = 0;
            socklen_t len = sizeof(so_error);
            getsockopt(probes[i].sock, SOL_SOCKET, SO_ERROR, &so_error, &len);
            if (so_error == 0) {
                append_rtsp_device(devices, count, probes[i].ip_address, port);
                int index = find_device_by_ip(devices, *count, probes[i].ip_address);
                if (index >= 0) {
                    publish_discovery_device(scan_id, &devices[index]);
                }
            }
        }
    }

    close_rtsp_probes(probes, probe_count);
    return 0;
}

static int scan_rtsp_devices(const char *network, discovered_camera_t *devices, int *count, unsigned int scan_id) {
    uint32_t base_addr = 0;
    uint32_t subnet_mask = 0;

    if (parse_network(network, &base_addr, &subnet_mask) != 0) {
        return -1;
    }

    uint32_t network_addr = base_addr & subnet_mask;
    uint32_t broadcast = network_addr | ~subnet_mask;
    uint64_t host_count = broadcast > network_addr ? (uint64_t)(broadcast - network_addr - 1) : 0;
    if (host_count > MAX_SCAN_HOSTS) {
        log_warn("RTSP discovery scan for %s has %" PRIu64 " hosts; limiting to %d", network, host_count, MAX_SCAN_HOSTS);
        host_count = MAX_SCAN_HOSTS;
    }

    for (size_t p = 0; p < sizeof(RTSP_PORTS) / sizeof(RTSP_PORTS[0]) && *count < MAX_UNIVERSAL_DEVICES; p++) {
        for (uint64_t offset = 1; offset <= host_count && *count < MAX_UNIVERSAL_DEVICES; offset += MAX_RTSP_BATCH_PROBES) {
            scan_rtsp_port_batch(network_addr, offset, host_count, RTSP_PORTS[p], devices, count, scan_id);
        }
    }

    return 0;
}

static int validate_rtsp_stream(const char *url, rtsp_stream_info_t *info, char *error_msg, size_t error_size) {
    AVFormatContext *format_ctx = NULL;
    AVDictionary *options = NULL;
    int video_stream_index = -1;
    int ret = -1;

    av_dict_set(&options, "rtsp_transport", "tcp", 0);
    av_dict_set(&options, "timeout", RTSP_VALIDATION_TIMEOUT_US, 0);

    ret = avformat_open_input(&format_ctx, url, NULL, &options);
    if (ret < 0) {
        av_strerror(ret, error_msg, error_size);
        goto cleanup;
    }

    ret = avformat_find_stream_info(format_ctx, NULL);
    if (ret < 0) {
        av_strerror(ret, error_msg, error_size);
        goto cleanup;
    }

    for (unsigned int i = 0; i < format_ctx->nb_streams; i++) {
        if (format_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            video_stream_index = (int)i;
            break;
        }
    }

    if (video_stream_index < 0) {
        snprintf(error_msg, error_size, "%s", "No video stream found");
        ret = -1;
        goto cleanup;
    }

    AVStream *video_stream = format_ctx->streams[video_stream_index];
    AVCodecParameters *codec_params = video_stream->codecpar;
    const AVCodec *codec = avcodec_find_decoder(codec_params->codec_id);

    info->width = codec_params->width;
    info->height = codec_params->height;
    info->fps = 0.0;
    if (video_stream->avg_frame_rate.den && video_stream->avg_frame_rate.num) {
        info->fps = (double)video_stream->avg_frame_rate.num / (double)video_stream->avg_frame_rate.den;
    }
    snprintf(info->codec, sizeof(info->codec), "%s", codec ? codec->name : "unknown");
    ret = 0;

cleanup:
    if (options) {
        av_dict_free(&options);
    }
    if (format_ctx) {
        avformat_close_input(&format_ctx);
    }
    return ret;
}

static void build_rtsp_url(char *dst, size_t size, const char *ip, int port, const char *path) {
    const char *normalized_path = path && path[0] == '/' ? path : "/";
    snprintf(dst, size, "rtsp://%s:%d%s", ip, port, normalized_path);
}

static void append_validation_port(int *ports, int *port_count, int port) {
    if (!ports || !port_count || port <= 0 || port > 65535) {
        return;
    }

    for (int i = 0; i < *port_count; i++) {
        if (ports[i] == port) {
            return;
        }
    }

    if (*port_count < MAX_RTSP_VALIDATE_PORTS) {
        ports[(*port_count)++] = port;
    }
}

static bool rtsp_candidate_is_generic(const rtsp_path_candidate_t *candidate) {
    if (!candidate || !candidate->family) {
        return false;
    }

    return strncmp(candidate->family, "generic-", 8) == 0 ||
           strncmp(candidate->family, "legacy-", 7) == 0;
}

static bool text_contains_token(const char *text, const char *token) {
    return text && token && strcasestr(text, token) != NULL;
}

static bool rtsp_candidate_matches_device_hint(const rtsp_path_candidate_t *candidate,
                                               const char *manufacturer,
                                               const char *model) {
    if (!candidate || !candidate->family) {
        return false;
    }

    if ((text_contains_token(manufacturer, "hikvision") || text_contains_token(model, "hikvision")) &&
        strcmp(candidate->family, "hikvision-channels") == 0) {
        return true;
    }
    if ((text_contains_token(manufacturer, "dahua") || text_contains_token(model, "dahua") ||
         text_contains_token(model, "networkvideotransmitter") ||
         text_contains_token(manufacturer, "amcrest") || text_contains_token(model, "amcrest")) &&
        strcmp(candidate->family, "dahua-realmonitor") == 0) {
        return true;
    }
    if ((text_contains_token(manufacturer, "uniview") || text_contains_token(model, "uniview") ||
         text_contains_token(manufacturer, "unv") || text_contains_token(model, "unv")) &&
        (strcmp(candidate->family, "uniview-media") == 0 ||
         strcmp(candidate->family, "uniview-unicast") == 0)) {
        return true;
    }
    if ((text_contains_token(manufacturer, "reolink") || text_contains_token(model, "reolink")) &&
        strcmp(candidate->family, "reolink-preview") == 0) {
        return true;
    }
    if ((text_contains_token(manufacturer, "axis") || text_contains_token(model, "axis")) &&
        strcmp(candidate->family, "axis-media") == 0) {
        return true;
    }
    if ((text_contains_token(manufacturer, "hanwha") || text_contains_token(model, "hanwha") ||
         text_contains_token(manufacturer, "samsung") || text_contains_token(model, "samsung") ||
         text_contains_token(manufacturer, "wisenet") || text_contains_token(model, "wisenet")) &&
        strcmp(candidate->family, "hanwha-profile") == 0) {
        return true;
    }
    if ((text_contains_token(manufacturer, "foscam") || text_contains_token(model, "foscam")) &&
        strcmp(candidate->family, "foscam-video") == 0) {
        return true;
    }

    return false;
}

static bool rtsp_should_try_candidate_on_pass(const rtsp_path_candidate_t *candidate,
                                              const char *manufacturer,
                                              const char *model,
                                              bool has_device_hint,
                                              int pass) {
    bool is_generic = rtsp_candidate_is_generic(candidate);
    bool matches_hint = rtsp_candidate_matches_device_hint(candidate, manufacturer, model);

    if (has_device_hint) {
        if (pass == 0) {
            return matches_hint;
        }
        if (pass == 1) {
            return is_generic;
        }
        return !matches_hint && !is_generic;
    }

    if (pass == 0) {
        return is_generic;
    }
    return !is_generic;
}

int discovery_rtsp_options_check(const char *ip, int port, int timeout_ms,
                                 char *server_header, size_t server_header_size) {
    if (server_header && server_header_size > 0) {
        server_header[0] = '\0';
    }
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    if (!ip || port <= 0 || port > 65535 || inet_pton(AF_INET, ip, &addr.sin_addr) != 1) {
        return -1;
    }

    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) {
        return -1;
    }
    struct timeval tv = { .tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    // Non-blocking connect so an unreachable host cannot stall the caller
    int flags = fcntl(sock, F_GETFL, 0);
    fcntl(sock, F_SETFL, flags | O_NONBLOCK);
    int rc = connect(sock, (struct sockaddr *)&addr, sizeof(addr));
    if (rc < 0 && errno != EINPROGRESS) {
        close(sock);
        return -1;
    }
    if (rc < 0) {
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(sock, &wfds);
        struct timeval ctv = tv;
        int so_error = 0;
        socklen_t len = sizeof(so_error);
        if (select(sock + 1, NULL, &wfds, NULL, &ctv) <= 0 ||
            getsockopt(sock, SOL_SOCKET, SO_ERROR, &so_error, &len) != 0 || so_error != 0) {
            close(sock);
            return -1;
        }
    }
    fcntl(sock, F_SETFL, flags);

    char request[256];
    int request_len = snprintf(request, sizeof(request),
                               "OPTIONS rtsp://%s:%d/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: LightNVR\r\n\r\n",
                               ip, port);
    char reply[2048];
    ssize_t received = -1;
    if (send(sock, request, (size_t)request_len, MSG_NOSIGNAL) == request_len) {
        received = recv(sock, reply, sizeof(reply) - 1, 0);
    }
    close(sock);
    if (received <= 0) {
        return 0;  // port open but no RTSP reply
    }
    reply[received] = '\0';
    if (strncmp(reply, "RTSP/1.", 7) != 0) {
        return 0;
    }

    const char *server = strcasestr(reply, "\nServer:");
    if (server && server_header && server_header_size > 0) {
        server += strlen("\nServer:");
        while (*server == ' ') server++;
        size_t n = strcspn(server, "\r\n");
        if (n >= server_header_size) n = server_header_size - 1;
        memcpy(server_header, server, n);
        server_header[n] = '\0';
    }
    return 1;
}

rtsp_probe_result_t discovery_find_rtsp_stream(const char *ip, int port,
                                               const char *username, const char *password,
                                               const char *manufacturer, const char *model,
                                               const volatile bool *cancel,
                                               rtsp_found_stream_t *out) {
    memset(out, 0, sizeof(*out));
    bool has_device_hint = (manufacturer && manufacturer[0] != '\0' && strcasecmp(manufacturer, "Unknown") != 0) ||
                           (model && model[0] != '\0' && strcasecmp(model, "Unknown") != 0);
    int pass_count = has_device_hint ? 3 : 2;
    const char *family = NULL;
    bool busy = false;
    bool unreachable = false;

    for (int pass = 0; pass < pass_count; pass++) {
        for (int i = 0; COMMON_RTSP_PATHS[i].path != NULL; i++) {
            const rtsp_path_candidate_t *candidate = &COMMON_RTSP_PATHS[i];
            if (!rtsp_should_try_candidate_on_pass(candidate, manufacturer, model, has_device_hint, pass)) {
                continue;
            }
            // Once a path works, only look for the rest of that vendor family
            if (family && strcmp(candidate->family, family) != 0) {
                continue;
            }
            if (cancel && *cancel) {
                return RTSP_PROBE_CANCELLED;
            }

            char raw_url[MAX_URL_LENGTH];
            char credentialed_url[MAX_URL_LENGTH];
            char error_msg[256] = {0};
            rtsp_stream_info_t info;
            memset(&info, 0, sizeof(info));
            build_rtsp_url(raw_url, sizeof(raw_url), ip, port, candidate->path);
            if (url_apply_credentials(raw_url, username, password, credentialed_url, sizeof(credentialed_url)) != 0) {
                snprintf(credentialed_url, sizeof(credentialed_url), "%s", raw_url);
            }

            if (validate_rtsp_stream(credentialed_url, &info, error_msg, sizeof(error_msg)) == 0) {
                if (!family) {
                    family = candidate->family;
                    out->width = info.width;
                    out->height = info.height;
                    out->fps = info.fps;
                    snprintf(out->codec, sizeof(out->codec), "%.31s", info.codec);
                }
                bool secondary = candidate->role && strcmp(candidate->role, "secondary") == 0;
                if (!secondary && out->main_url[0] == '\0') {
                    snprintf(out->main_url, sizeof(out->main_url), "%s", raw_url);
                } else if (secondary && out->sub_url[0] == '\0') {
                    snprintf(out->sub_url, sizeof(out->sub_url), "%s", raw_url);
                }
                continue;
            }

            if (!family && strstr(error_msg, "401")) {
                snprintf(out->message, sizeof(out->message), "%s", "The camera rejected the username or password");
                return RTSP_PROBE_AUTH_FAILED;
            }
            // FFmpeg reports codes like 453 Not Enough Bandwidth as a generic 4XX
            if (strstr(error_msg, "4XX") || strstr(error_msg, "453")) {
                busy = true;
            }
            if (strcasestr(error_msg, "Connection refused") || strcasestr(error_msg, "timed out") ||
                strcasestr(error_msg, "No route")) {
                unreachable = true;
            }
        }
    }

    if (out->main_url[0] == '\0' && out->sub_url[0] != '\0') {
        snprintf(out->main_url, sizeof(out->main_url), "%s", out->sub_url);
        out->sub_url[0] = '\0';
    }
    if (out->main_url[0] != '\0') {
        return RTSP_PROBE_FOUND;
    }
    if (busy) {
        snprintf(out->message, sizeof(out->message), "%s",
                 "The camera refused the connection (it may have too many viewers connected)");
        return RTSP_PROBE_BUSY;
    }
    if (unreachable) {
        snprintf(out->message, sizeof(out->message), "%s", "Could not connect to the camera");
        return RTSP_PROBE_UNREACHABLE;
    }
    snprintf(out->message, sizeof(out->message), "%s",
             "RTSP server found, but none of the known stream paths worked; add it manually with its RTSP path");
    return RTSP_PROBE_NO_PATH;
}

static char *build_discovery_status_json_locked(void) {
    cJSON *root = cJSON_CreateObject();
    cJSON *array = root ? cJSON_AddArrayToObject(root, "devices") : NULL;
    if (!root || !array) {
        cJSON_Delete(root);
        return NULL;
    }

    cJSON_AddBoolToObject(root, "running", g_camera_discovery.running);
    cJSON_AddBoolToObject(root, "completed", g_camera_discovery.completed);
    cJSON_AddNumberToObject(root, "scan_id", (double)g_camera_discovery.scan_id);
    cJSON_AddStringToObject(root, "network", g_camera_discovery.network);
    cJSON_AddStringToObject(root, "error", g_camera_discovery.error);
    cJSON_AddNumberToObject(root, "count", g_camera_discovery.count);

    for (int i = 0; i < g_camera_discovery.count; i++) {
        cJSON *item = device_to_json(&g_camera_discovery.devices[i]);
        if (item) {
            cJSON_AddItemToArray(array, item);
        }
    }

    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    return json;
}

static void *discovery_scan_worker(void *arg) {
    discovery_scan_job_t *job = (discovery_scan_job_t *)arg;
    if (!job) {
        return NULL;
    }

    discovered_camera_t devices[MAX_UNIVERSAL_DEVICES];
    memset(devices, 0, sizeof(devices));
    int count = 0;

    if (job->include_rtsp) {
        scan_rtsp_devices(job->network, devices, &count, job->scan_id);
    }

    if (job->include_onvif) {
        onvif_device_info_t onvif_devices[32];
        int onvif_count = discover_onvif_devices(job->network, onvif_devices, 32);
        if (onvif_count > 0) {
            for (int i = 0; i < onvif_count; i++) {
                append_onvif_device(devices, &count, &onvif_devices[i]);
                int index = find_device_by_ip(devices, count, onvif_devices[i].ip_address);
                if (index >= 0) {
                    publish_discovery_device(job->scan_id, &devices[index]);
                }
            }
        }
    }

    pthread_mutex_lock(&g_camera_discovery.mutex);
    if (g_camera_discovery.scan_id == job->scan_id) {
        g_camera_discovery.running = false;
        g_camera_discovery.completed = true;
    }
    pthread_mutex_unlock(&g_camera_discovery.mutex);

    free(job);
    return NULL;
}

void handle_post_discover_cameras(const http_request_t *req, http_response_t *res) {
    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    const cJSON *network_json = cJSON_GetObjectItem(body, "network");
    const cJSON *include_onvif_json = cJSON_GetObjectItem(body, "include_onvif");
    const cJSON *include_rtsp_json = cJSON_GetObjectItem(body, "include_rtsp");

    const char *requested_network = cJSON_IsString(network_json) ? network_json->valuestring : "auto";
    bool include_onvif = !cJSON_IsBool(include_onvif_json) || cJSON_IsTrue(include_onvif_json);
    // Discovery is ONVIF-only unless a caller explicitly asks for the RTSP port scan;
    // RTSP-only cameras are added manually
    bool include_rtsp = cJSON_IsTrue(include_rtsp_json);

    char scan_network[64];
    if (resolve_scan_network(requested_network, scan_network, sizeof(scan_network)) != 0) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 400, "Unable to determine discovery network");
        return;
    }

    discovery_scan_job_t *job = calloc(1, sizeof(*job));
    if (!job) {
        cJSON_Delete(body);
        http_response_set_json_error(res, 500, "Failed to start discovery");
        return;
    }

    pthread_mutex_lock(&g_camera_discovery.mutex);
    unsigned int scan_id = ++g_camera_discovery.scan_id;
    memset(g_camera_discovery.devices, 0, sizeof(g_camera_discovery.devices));
    g_camera_discovery.count = 0;
    g_camera_discovery.running = true;
    g_camera_discovery.completed = false;
    g_camera_discovery.error[0] = '\0';
    snprintf(g_camera_discovery.network, sizeof(g_camera_discovery.network), "%s", scan_network);
    pthread_mutex_unlock(&g_camera_discovery.mutex);

    snprintf(job->network, sizeof(job->network), "%s", scan_network);
    job->include_onvif = include_onvif;
    job->include_rtsp = include_rtsp;
    job->scan_id = scan_id;

    pthread_t thread;
    int thread_result = pthread_create(&thread, NULL, discovery_scan_worker, job);
    if (thread_result != 0) {
        pthread_mutex_lock(&g_camera_discovery.mutex);
        g_camera_discovery.running = false;
        g_camera_discovery.completed = true;
        snprintf(g_camera_discovery.error, sizeof(g_camera_discovery.error), "%s", "Failed to create discovery thread");
        pthread_mutex_unlock(&g_camera_discovery.mutex);
        free(job);
        cJSON_Delete(body);
        http_response_set_json_error(res, 500, "Failed to start discovery");
        return;
    }
    pthread_detach(thread);

    pthread_mutex_lock(&g_camera_discovery.mutex);
    char *json = build_discovery_status_json_locked();
    pthread_mutex_unlock(&g_camera_discovery.mutex);
    cJSON_Delete(body);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize discovery response");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}

void handle_get_discover_cameras_status(const http_request_t *req, http_response_t *res) {
    (void)req;

    pthread_mutex_lock(&g_camera_discovery.mutex);
    char *json = build_discovery_status_json_locked();
    pthread_mutex_unlock(&g_camera_discovery.mutex);

    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize discovery response");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}

void handle_post_validate_rtsp_device(const http_request_t *req, http_response_t *res) {
    cJSON *body = httpd_parse_json_body(req);
    if (!body) {
        http_response_set_json_error(res, 400, "Invalid JSON request");
        return;
    }

    const cJSON *ip_json = cJSON_GetObjectItem(body, "ip_address");
    const cJSON *port_json = cJSON_GetObjectItem(body, "port");
    const cJSON *ports_json = cJSON_GetObjectItem(body, "ports");
    const cJSON *manufacturer_json = cJSON_GetObjectItem(body, "manufacturer");
    const cJSON *model_json = cJSON_GetObjectItem(body, "model");
    const cJSON *username_json = cJSON_GetObjectItem(body, "username");
    const cJSON *password_json = cJSON_GetObjectItem(body, "password");

    if (!cJSON_IsString(ip_json) || ip_json->valuestring[0] == '\0') {
        cJSON_Delete(body);
        http_response_set_json_error(res, 400, "Missing ip_address");
        return;
    }

    const char *ip = ip_json->valuestring;
    int port = cJSON_IsNumber(port_json) ? port_json->valueint : 554;
    const char *username = cJSON_IsString(username_json) ? username_json->valuestring : NULL;
    const char *password = cJSON_IsString(password_json) ? password_json->valuestring : NULL;
    const char *manufacturer = cJSON_IsString(manufacturer_json) ? manufacturer_json->valuestring : NULL;
    const char *model = cJSON_IsString(model_json) ? model_json->valuestring : NULL;
    bool has_device_hint = (manufacturer && manufacturer[0] != '\0' && strcasecmp(manufacturer, "Unknown") != 0) ||
                           (model && model[0] != '\0' && strcasecmp(model, "Unknown") != 0);
    int path_pass_count = has_device_hint ? 3 : 2;
    int validation_ports[MAX_RTSP_VALIDATE_PORTS];
    int validation_port_count = 0;

    memset(validation_ports, 0, sizeof(validation_ports));
    append_validation_port(validation_ports, &validation_port_count, port);
    if (cJSON_IsArray(ports_json)) {
        cJSON *port_item = NULL;
        cJSON_ArrayForEach(port_item, ports_json) {
            if (cJSON_IsNumber(port_item)) {
                append_validation_port(validation_ports, &validation_port_count, port_item->valueint);
            }
        }
    }
    append_validation_port(validation_ports, &validation_port_count, 554);

    cJSON *root = cJSON_CreateObject();
    cJSON *attempts = root ? cJSON_AddArrayToObject(root, "attempts") : NULL;
    if (!root || !attempts) {
        cJSON_Delete(body);
        cJSON_Delete(root);
        http_response_set_json_error(res, 500, "Failed to create RTSP validation response");
        return;
    }

    bool success = false;
    char selected_url[MAX_URL_LENGTH] = {0};
    rtsp_stream_info_t selected_info;
    memset(&selected_info, 0, sizeof(selected_info));
    char last_error[256] = {0};
    const char *selected_family = NULL;
    int selected_port = 0;
    rtsp_validated_profile_t profiles[MAX_RTSP_VALIDATED_PROFILES];
    int profile_count = 0;

    for (int p = 0; p < validation_port_count; p++) {
        int candidate_port = validation_ports[p];

        for (int pass = 0; pass < path_pass_count; pass++) {
            for (int i = 0; COMMON_RTSP_PATHS[i].path != NULL; i++) {
                const rtsp_path_candidate_t *candidate = &COMMON_RTSP_PATHS[i];
                if (!rtsp_should_try_candidate_on_pass(candidate, manufacturer, model, has_device_hint, pass)) {
                    continue;
                }
                if (success && selected_family && strcmp(candidate->family, selected_family) != 0) {
                    break;
                }

                char raw_url[MAX_URL_LENGTH];
                char credentialed_url[MAX_URL_LENGTH];
                char safe_url[MAX_URL_LENGTH];
                char error_msg[256] = {0};
                rtsp_stream_info_t info;
                memset(&info, 0, sizeof(info));

                build_rtsp_url(raw_url, sizeof(raw_url), ip, candidate_port, candidate->path);
                if (url_apply_credentials(raw_url, username, password, credentialed_url, sizeof(credentialed_url)) != 0) {
                    snprintf(credentialed_url, sizeof(credentialed_url), "%s", raw_url);
                }
                if (url_redact_for_logging(credentialed_url, safe_url, sizeof(safe_url)) != 0) {
                    snprintf(safe_url, sizeof(safe_url), "%s", "rtsp://[invalid]");
                }

                int result = validate_rtsp_stream(credentialed_url, &info, error_msg, sizeof(error_msg));
                cJSON *attempt = cJSON_CreateObject();
                if (attempt) {
                    cJSON_AddStringToObject(attempt, "url", safe_url);
                    cJSON_AddStringToObject(attempt, "name", candidate->name);
                    cJSON_AddStringToObject(attempt, "stream_role", candidate->role);
                    cJSON_AddNumberToObject(attempt, "port", candidate_port);
                    cJSON_AddStringToObject(attempt, "family", candidate->family);
                    cJSON_AddBoolToObject(attempt, "success", result == 0);
                    if (result != 0) {
                        cJSON_AddStringToObject(attempt, "message", error_msg);
                    }
                    cJSON_AddItemToArray(attempts, attempt);
                }

                if (result == 0) {
                    if (!success) {
                        success = true;
                        selected_family = candidate->family;
                        selected_port = candidate_port;
                        snprintf(selected_url, sizeof(selected_url), "%s", credentialed_url);
                        selected_info = info;
                    }
                    if (profile_count < (int)(sizeof(profiles) / sizeof(profiles[0]))) {
                        snprintf(profiles[profile_count].url, sizeof(profiles[profile_count].url), "%s", credentialed_url);
                        snprintf(profiles[profile_count].safe_url, sizeof(profiles[profile_count].safe_url), "%s", safe_url);
                        profiles[profile_count].info = info;
                        profiles[profile_count].candidate = candidate;
                        profiles[profile_count].port = candidate_port;
                        profile_count++;
                    }
                } else {
                    snprintf(last_error, sizeof(last_error), "%s", error_msg);
                }
            }

            if (success && selected_port == candidate_port) {
                break;
            }
        }

        if (success && selected_port == candidate_port) {
            break;
        }
    }

    cJSON_AddBoolToObject(root, "success", success);
    if (success) {
        char safe_selected_url[MAX_URL_LENGTH];
        if (url_redact_for_logging(selected_url, safe_selected_url, sizeof(safe_selected_url)) != 0) {
            snprintf(safe_selected_url, sizeof(safe_selected_url), "%s", "rtsp://[invalid]");
        }

        cJSON_AddStringToObject(root, "url", selected_url);
        cJSON_AddStringToObject(root, "safe_url", safe_selected_url);
        cJSON_AddStringToObject(root, "status", "Valid RTSP Stream");
        cJSON_AddNumberToObject(root, "port", selected_port);

        cJSON *profiles_json = cJSON_AddArrayToObject(root, "profiles");
        if (profiles_json) {
            for (int i = 0; i < profile_count; i++) {
                cJSON *profile_json = cJSON_CreateObject();
                if (!profile_json || !profiles[i].candidate) {
                    cJSON_Delete(profile_json);
                    continue;
                }

                char token[128];
                snprintf(token, sizeof(token), "rtsp-%s-%d-%s", ip, profiles[i].port, profiles[i].candidate->role);
                cJSON_AddStringToObject(profile_json, "token", token);
                cJSON_AddStringToObject(profile_json, "name", profiles[i].candidate->name);
                cJSON_AddStringToObject(profile_json, "stream_role", profiles[i].candidate->role);
                cJSON_AddNumberToObject(profile_json, "port", profiles[i].port);
                cJSON_AddStringToObject(profile_json, "family", profiles[i].candidate->family);
                cJSON_AddStringToObject(profile_json, "stream_uri", profiles[i].url);
                cJSON_AddStringToObject(profile_json, "safe_url", profiles[i].safe_url);
                cJSON_AddNumberToObject(profile_json, "width", profiles[i].info.width);
                cJSON_AddNumberToObject(profile_json, "height", profiles[i].info.height);
                cJSON_AddNumberToObject(profile_json, "fps", (int)profiles[i].info.fps);
                cJSON_AddStringToObject(profile_json, "encoding", profiles[i].info.codec);
                cJSON_AddBoolToObject(profile_json, "isRtsp", true);
                cJSON_AddItemToArray(profiles_json, profile_json);
            }
        }

        cJSON *info = cJSON_AddObjectToObject(root, "info");
        if (info) {
            cJSON_AddNumberToObject(info, "width", selected_info.width);
            cJSON_AddNumberToObject(info, "height", selected_info.height);
            cJSON_AddNumberToObject(info, "fps", (int)selected_info.fps);
            cJSON_AddStringToObject(info, "codec", selected_info.codec);
        }
    } else {
        cJSON_AddStringToObject(root, "status", "Validation Failed");
        cJSON_AddStringToObject(root, "message", last_error[0] ? last_error : "No common RTSP path opened successfully");
    }

    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(body);
    cJSON_Delete(root);
    if (!json) {
        http_response_set_json_error(res, 500, "Failed to serialize RTSP validation response");
        return;
    }

    http_response_set_json(res, 200, json);
    free(json);
}
