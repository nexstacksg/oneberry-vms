#ifndef API_HANDLERS_CAMERA_DISPLAY_H
#define API_HANDLERS_CAMERA_DISPLAY_H

#include "web/web_server.h"

/**
 * Handle GET /api/camera-display: per-camera display settings (forced aspect ratio)
 */
void handle_get_camera_display(const http_request_t *request, http_response_t *response);

/**
 * Handle PUT /api/camera-display/<camera>: set one camera's display settings
 * (admin/user only). Body: {"aspectRatio": "auto"|"4:3"|"16:9"|"1:1"|"3:4"|"9:16"}
 */
void handle_put_camera_display(const http_request_t *request, http_response_t *response);

/**
 * Move a camera's display settings to its new name (camera rename)
 */
void camera_display_rename_camera(const char *old_name, const char *new_name);

#endif /* API_HANDLERS_CAMERA_DISPLAY_H */
