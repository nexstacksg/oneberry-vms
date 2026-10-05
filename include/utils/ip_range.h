#ifndef IP_RANGE_H
#define IP_RANGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Largest number of addresses a single scan may cover (a /22) */
#define IP_RANGE_MAX_HOSTS 1024

/**
 * Whether an IPv4 address (host byte order) is in a private LAN range:
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or link-local 169.254.0.0/16.
 * Scans are limited to these so the server cannot be used to probe the
 * internet.
 */
bool ip_is_private_lan(uint32_t ip);

/**
 * Parse and validate an inclusive start/end IPv4 range.
 *
 * Both addresses must be valid dotted-quad IPv4, start <= end, the range
 * must cover at most IP_RANGE_MAX_HOSTS addresses, and both ends must be
 * private LAN addresses (see ip_is_private_lan).
 *
 * @param start_ip  e.g. "172.16.3.1"
 * @param end_ip    e.g. "172.16.3.255"
 * @param first     receives the first address (host byte order)
 * @param last      receives the last address (host byte order)
 * @param error     receives a user-facing reason on failure (may be NULL)
 * @return 0 on success, -1 if invalid
 */
int ip_range_parse(const char *start_ip, const char *end_ip,
                   uint32_t *first, uint32_t *last,
                   char *error, size_t error_size);

/**
 * Parse a CIDR block such as "172.16.3.0/24" into its usable host range
 * (network and broadcast addresses excluded for prefixes up to /30), then
 * apply the same checks as ip_range_parse.
 */
int ip_range_parse_cidr(const char *cidr, uint32_t *first, uint32_t *last,
                        char *error, size_t error_size);

/** Format a host-byte-order IPv4 address as dotted quad (buffer >= 16 bytes) */
void ip_to_string(uint32_t ip, char *buffer, size_t size);

#endif /* IP_RANGE_H */
