#ifndef API_HANDLERS_CLOUD_H
#define API_HANDLERS_CLOUD_H

#include "web/request_response.h"

void handle_get_cloud_settings(const http_request_t *req, http_response_t *res);
void handle_post_cloud_test(const http_request_t *req, http_response_t *res);
void handle_post_cloud_connect(const http_request_t *req, http_response_t *res);
void handle_post_cloud_disconnect(const http_request_t *req, http_response_t *res);

#endif /* API_HANDLERS_CLOUD_H */
