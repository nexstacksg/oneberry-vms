#ifndef API_HANDLERS_DISCOVERY_H
#define API_HANDLERS_DISCOVERY_H

#include "web/request_response.h"

/**
 * @brief Discover ONVIF and RTSP-capable cameras on a local network.
 *
 * POST /api/discovery/cameras
 */
void handle_post_discover_cameras(const http_request_t *req, http_response_t *res);

/**
 * @brief Get the current universal camera discovery progress.
 *
 * GET /api/discovery/cameras/status
 */
void handle_get_discover_cameras_status(const http_request_t *req, http_response_t *res);

/**
 * @brief Validate common RTSP stream paths for one discovered host.
 *
 * POST /api/discovery/rtsp/validate
 */
void handle_post_validate_rtsp_device(const http_request_t *req, http_response_t *res);

/* ---- RTSP helpers shared with the subnet scan ---- */

#include <stdbool.h>
#include "core/config.h"

typedef enum {
    RTSP_PROBE_FOUND = 0,      /* a known stream path played with these credentials */
    RTSP_PROBE_AUTH_FAILED,    /* the camera answered 401 Unauthorized */
    RTSP_PROBE_NO_PATH,        /* RTSP server, but none of the known stream paths worked */
    RTSP_PROBE_BUSY,           /* the camera refused (e.g. 453: too many connections) */
    RTSP_PROBE_UNREACHABLE,    /* could not connect */
    RTSP_PROBE_CANCELLED
} rtsp_probe_result_t;

typedef struct {
    char main_url[MAX_URL_LENGTH];   /* without credentials */
    char sub_url[MAX_URL_LENGTH];    /* without credentials, "" if none */
    int width;
    int height;
    double fps;
    char codec[32];
    char message[160];               /* user-facing detail, never contains credentials */
} rtsp_found_stream_t;

/**
 * Send an RTSP OPTIONS request and check the reply really is RTSP.
 * @param server_header receives the "Server:" header if present (may be NULL)
 * @return 1 if an RTSP server answered, 0 if something else answered, -1 if unreachable
 */
int discovery_rtsp_options_check(const char *ip, int port, int timeout_ms,
                                 char *server_header, size_t server_header_size);

/**
 * Find a working stream on an RTSP camera using the known vendor path list
 * (paths matching the manufacturer/model hint are tried first). Stops at the
 * first 401 so wrong credentials fail fast. Checks *cancel between attempts.
 */
rtsp_probe_result_t discovery_find_rtsp_stream(const char *ip, int port,
                                               const char *username, const char *password,
                                               const char *manufacturer, const char *model,
                                               const volatile bool *cancel,
                                               rtsp_found_stream_t *out);

#endif /* API_HANDLERS_DISCOVERY_H */
