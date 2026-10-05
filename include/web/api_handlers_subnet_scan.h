#ifndef API_HANDLERS_SUBNET_SCAN_H
#define API_HANDLERS_SUBNET_SCAN_H

#include "web/request_response.h"

/**
 * Subnet Scan: find ONVIF and RTSP cameras in a start/end IPv4 range and try
 * common credentials on each (admin only). One scan runs at a time.
 *
 * POST   /api/discovery/subnet-scan               start a scan
 * GET    /api/discovery/subnet-scan               progress and results
 * DELETE /api/discovery/subnet-scan               cancel the running scan
 * POST   /api/discovery/subnet-scan/authenticate  retry one device with its own credentials
 */
void handle_post_subnet_scan(const http_request_t *req, http_response_t *res);
void handle_get_subnet_scan(const http_request_t *req, http_response_t *res);
void handle_delete_subnet_scan(const http_request_t *req, http_response_t *res);
void handle_post_subnet_scan_authenticate(const http_request_t *req, http_response_t *res);

#endif /* API_HANDLERS_SUBNET_SCAN_H */
