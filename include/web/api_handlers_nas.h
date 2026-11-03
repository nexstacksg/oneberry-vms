#ifndef API_HANDLERS_NAS_H
#define API_HANDLERS_NAS_H

#include "web/request_response.h"

void handle_get_nas_settings(const http_request_t *req, http_response_t *res);
void handle_post_nas_test(const http_request_t *req, http_response_t *res);
void handle_post_nas_connect(const http_request_t *req, http_response_t *res);
void handle_post_nas_disconnect(const http_request_t *req, http_response_t *res);

#endif /* API_HANDLERS_NAS_H */
