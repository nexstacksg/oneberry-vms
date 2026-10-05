#include "utils/ip_range.h"

#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void set_error(char *error, size_t error_size, const char *message) {
    if (error && error_size > 0) {
        snprintf(error, error_size, "%s", message);
    }
}

static int parse_ipv4(const char *text, uint32_t *out) {
    struct in_addr addr;
    if (!text || inet_pton(AF_INET, text, &addr) != 1) {
        return -1;
    }
    *out = ntohl(addr.s_addr);
    return 0;
}

bool ip_is_private_lan(uint32_t ip) {
    return (ip & 0xFF000000u) == 0x0A000000u ||   // 10.0.0.0/8
           (ip & 0xFFF00000u) == 0xAC100000u ||   // 172.16.0.0/12
           (ip & 0xFFFF0000u) == 0xC0A80000u ||   // 192.168.0.0/16
           (ip & 0xFFFF0000u) == 0xA9FE0000u;     // 169.254.0.0/16
}

static int check_range(uint32_t first, uint32_t last, char *error, size_t error_size) {
    if (first > last) {
        set_error(error, error_size, "Start IP must not be greater than End IP");
        return -1;
    }
    if ((uint64_t)last - first + 1 > IP_RANGE_MAX_HOSTS) {
        char message[96];
        snprintf(message, sizeof(message), "The range is too large (at most %d addresses)", IP_RANGE_MAX_HOSTS);
        set_error(error, error_size, message);
        return -1;
    }
    if (!ip_is_private_lan(first) || !ip_is_private_lan(last)) {
        set_error(error, error_size,
                  "Only private LAN addresses can be scanned (10.x, 172.16-31.x, 192.168.x, 169.254.x)");
        return -1;
    }
    return 0;
}

int ip_range_parse(const char *start_ip, const char *end_ip,
                   uint32_t *first, uint32_t *last,
                   char *error, size_t error_size) {
    uint32_t start, end;
    if (parse_ipv4(start_ip, &start) != 0) {
        set_error(error, error_size, "Start IP is not a valid IPv4 address");
        return -1;
    }
    if (parse_ipv4(end_ip, &end) != 0) {
        set_error(error, error_size, "End IP is not a valid IPv4 address");
        return -1;
    }
    if (check_range(start, end, error, error_size) != 0) {
        return -1;
    }
    *first = start;
    *last = end;
    return 0;
}

int ip_range_parse_cidr(const char *cidr, uint32_t *first, uint32_t *last,
                        char *error, size_t error_size) {
    char address[32];
    const char *slash = cidr ? strchr(cidr, '/') : NULL;
    if (!slash || (size_t)(slash - cidr) >= sizeof(address)) {
        set_error(error, error_size, "CIDR must look like 172.16.3.0/24");
        return -1;
    }
    memcpy(address, cidr, (size_t)(slash - cidr));
    address[slash - cidr] = '\0';

    char *end_ptr = NULL;
    long prefix = strtol(slash + 1, &end_ptr, 10);
    uint32_t base;
    if (*(slash + 1) == '\0' || *end_ptr != '\0' || prefix < 0 || prefix > 32 ||
        parse_ipv4(address, &base) != 0) {
        set_error(error, error_size, "CIDR must look like 172.16.3.0/24");
        return -1;
    }

    uint32_t mask = prefix == 0 ? 0 : 0xFFFFFFFFu << (32 - prefix);
    uint32_t network = base & mask;
    uint32_t broadcast = network | ~mask;
    uint32_t start = network, end = broadcast;
    if (prefix <= 30) {
        start = network + 1;   // skip network and broadcast addresses
        end = broadcast - 1;
    }
    if (check_range(start, end, error, error_size) != 0) {
        return -1;
    }
    *first = start;
    *last = end;
    return 0;
}

void ip_to_string(uint32_t ip, char *buffer, size_t size) {
    snprintf(buffer, size, "%u.%u.%u.%u",
             (ip >> 24) & 0xFF, (ip >> 16) & 0xFF, (ip >> 8) & 0xFF, ip & 0xFF);
}
