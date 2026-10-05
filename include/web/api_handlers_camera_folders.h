#ifndef API_HANDLERS_CAMERA_FOLDERS_H
#define API_HANDLERS_CAMERA_FOLDERS_H

#include "web/web_server.h"

/**
 * Handle GET /api/camera-folders: the sidebar camera folders
 */
void handle_get_camera_folders(const http_request_t *request, http_response_t *response);

/**
 * Handle PUT /api/camera-folders: replace the camera folders (admin/user only;
 * a folder can only be removed while it has no cameras)
 */
void handle_put_camera_folders(const http_request_t *request, http_response_t *response);

#endif /* API_HANDLERS_CAMERA_FOLDERS_H */
