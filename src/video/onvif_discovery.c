#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200112L

#include "video/onvif_discovery.h"
#include "video/onvif_discovery_messages.h"
#include "video/onvif_discovery_network.h"
#include "video/onvif_discovery_probe.h"
#include "video/onvif_discovery_response.h"
#include "video/onvif_discovery_thread.h"
#include "video/onvif_device_management.h"
#include "core/logger.h"
#include "core/config.h"
#include "core/curl_init.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <errno.h>
#include <time.h>
#include <stdbool.h>
#include <fcntl.h>
#include <curl/curl.h>
#include "utils/poll_wait.h"

// Maximum number of networks to detect
#define MAX_DETECTED_NETWORKS 10

// Maximum number of discovered devices
#define MAX_DISCOVERED_DEVICES 32

// Array of discovered devices
static onvif_device_info_t g_discovered_devices[MAX_DISCOVERED_DEVICES];
static int g_discovered_device_count = 0;

// Mutex for thread safety
pthread_mutex_t g_discovery_mutex = PTHREAD_MUTEX_INITIALIZER;

// Initialize ONVIF discovery module
int init_onvif_discovery(void) {
    // Initialize random number generator for UUID generation.
    // Mix time() with getpid() to reduce seed predictability across processes
    // started at the same second (cert-msc32-c / cert-msc51-cpp).
    srand((unsigned int)time(NULL) ^ ((unsigned int)getpid() << 16));
    
    // Initialize discovered devices array
    memset(g_discovered_devices, 0, sizeof(g_discovered_devices));
    g_discovered_device_count = 0;
    
    log_info("ONVIF discovery module initialized");
    
    return 0;
}

// Shutdown ONVIF discovery module
void shutdown_onvif_discovery(void) {
    log_info("ONVIF discovery module shutdown");
}

// Get discovery mutex
pthread_mutex_t* get_discovery_mutex(void) {
    return &g_discovery_mutex;
}

// Get current discovery network
const char* get_current_discovery_network(void) {
    return NULL; // No longer using a persistent network
}

// Start ONVIF discovery process - deprecated, use discover_onvif_devices directly
int start_onvif_discovery(const char *network, int interval) {
    log_warn("start_onvif_discovery is deprecated, use discover_onvif_devices directly");
    return -1;
}

// Stop ONVIF discovery process - deprecated, use discover_onvif_devices directly
int stop_onvif_discovery(void) {
    log_warn("stop_onvif_discovery is deprecated, use discover_onvif_devices directly");
    return 0;
}

// Get discovered ONVIF devices
int get_discovered_onvif_devices(onvif_device_info_t *devices, int max_devices) {
    int count;
    
    if (!devices || max_devices <= 0) {
        return -1;
    }
    
    pthread_mutex_lock(&g_discovery_mutex);
    
    count = g_discovered_device_count < max_devices ? g_discovered_device_count : max_devices;
    
    for (int i = 0; i < count; i++) {
        memcpy(&devices[i], &g_discovered_devices[i], sizeof(onvif_device_info_t));
    }
    
    pthread_mutex_unlock(&g_discovery_mutex);
    
    return count;
}

#define ONVIF_UNICAST_MAX_HOSTS 1024
#define ONVIF_REPLY_WAIT_MS 3000

// Send a WS-Discovery probe directly to every host in the network (plus the
// broadcast and multicast addresses) and read ProbeMatch replies on the same
// socket. Cameras answer to the port the probe came from, and multicast
// neither leaves nor re-enters a Docker bridge, so unicast probes on one
// socket are what find cameras when LightNVR runs in a container.
static int probe_hosts_for_onvif(uint32_t first_host, uint32_t last_host, bool send_group_probes,
                                 onvif_device_info_t *devices, int max_devices) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        log_error("Failed to create discovery socket: %s", strerror(errno));
        return -1;
    }
    int enable = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &enable, sizeof(enable));

    struct sockaddr_in bind_addr = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_ANY) };
    if (bind(sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        log_warn("Failed to bind discovery socket: %s", strerror(errno));
    }

    struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons(3702) };
    char message[1024];
    char uuid[64];
    int sent = 0;

    for (uint32_t host = first_host; host <= last_host && host != 0 && sent < ONVIF_UNICAST_MAX_HOSTS; host++) {
        generate_uuid(uuid, sizeof(uuid));
        int len = snprintf(message, sizeof(message), ONVIF_DISCOVERY_MSG, uuid);
        dest.sin_addr.s_addr = htonl(host);
        if (sendto(sock, message, (size_t)len, 0, (struct sockaddr *)&dest, sizeof(dest)) >= 0) {
            sent++;
        }
    }

    // Broadcast and multicast still help when running on the host network
    uint32_t group_targets[2] = { last_host + 1, 0 };
    inet_pton(AF_INET, "239.255.255.250", &group_targets[1]);
    group_targets[1] = ntohl(group_targets[1]);
    for (int i = 0; send_group_probes && i < 2; i++) {
        generate_uuid(uuid, sizeof(uuid));
        int len = snprintf(message, sizeof(message), ONVIF_DISCOVERY_MSG, uuid);
        dest.sin_addr.s_addr = htonl(group_targets[i]);
        sendto(sock, message, (size_t)len, 0, (struct sockaddr *)&dest, sizeof(dest));
    }
    log_info("Sent ONVIF discovery probes to %d hosts plus broadcast and multicast", sent);

    int count = 0;
    char buffer[16384];
    struct timeval deadline, now;
    gettimeofday(&deadline, NULL);
    deadline.tv_sec += ONVIF_REPLY_WAIT_MS / 1000;

    while (count < max_devices) {
        gettimeofday(&now, NULL);
        long remaining_ms = (deadline.tv_sec - now.tv_sec) * 1000 + (deadline.tv_usec - now.tv_usec) / 1000;
        if (remaining_ms <= 0) {
            break;
        }
        if (poll_wait_fd(sock, POLLIN, (int)remaining_ms) <= 0) {
            break;
        }

        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        ssize_t n = recvfrom(sock, buffer, sizeof(buffer) - 1, 0, (struct sockaddr *)&from, &from_len);
        if (n <= 0) {
            continue;
        }
        buffer[n] = '\0';
        if (!strstr(buffer, "ProbeMatch")) {
            continue;  // our own multicast probe echoed back, or unrelated traffic
        }

        onvif_device_info_t info;
        if (parse_device_info(buffer, &info) != 0) {
            continue;
        }
        if (info.ip_address[0] == '\0') {
            snprintf(info.ip_address, sizeof(info.ip_address), "%s", inet_ntoa(from.sin_addr));
        }
        // Range scans only report devices inside the requested range
        if (!send_group_probes) {
            uint32_t reply_ip = ntohl(from.sin_addr.s_addr);
            if (reply_ip < first_host || reply_ip > last_host) {
                continue;
            }
        }

        bool duplicate = false;
        for (int i = 0; i < count; i++) {
            if (strcmp(devices[i].ip_address, info.ip_address) == 0) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            devices[count++] = info;
            log_info("ONVIF device found: %s (%s)", info.ip_address, info.device_service);
        }
    }

    close(sock);
    return count;
}

// Discover ONVIF devices on a specific network
int discover_onvif_devices(const char *network, onvif_device_info_t *devices,
                          int max_devices) {
    uint32_t base_addr, subnet_mask;
    int count = 0;
    char selected_network[64] = {0};
    int discovery_sock = -1;
    int broadcast_enabled = 1;

    if (!devices || max_devices <= 0) {
        log_error("Invalid parameters for discover_onvif_devices");
        return -1;
    }

    // Check if we need to auto-detect networks
    if (!network || strlen(network) == 0 || strcmp(network, "auto") == 0) {
        // Priority 1: Check environment variable LIGHTNVR_ONVIF_NETWORK
        const char *env_network = getenv("LIGHTNVR_ONVIF_NETWORK");
        if (env_network && strlen(env_network) > 0 && strcmp(env_network, "auto") != 0) {
            log_info("Using ONVIF discovery network from environment variable: %s", env_network);
            strncpy(selected_network, env_network, sizeof(selected_network) - 1);
            selected_network[sizeof(selected_network) - 1] = '\0';
            network = selected_network;
        }
        // Priority 2: Check config file setting
        else if (g_config.onvif_discovery_network[0] != '\0' &&
                 strcmp(g_config.onvif_discovery_network, "auto") != 0) {
            log_info("Using ONVIF discovery network from config file: %s", g_config.onvif_discovery_network);
            strncpy(selected_network, g_config.onvif_discovery_network, sizeof(selected_network) - 1);
            selected_network[sizeof(selected_network) - 1] = '\0';
            network = selected_network;
        }
        // Priority 3: Auto-detect networks
        else {
            log_info("Auto-detecting networks for ONVIF discovery");

            // Detect local networks
            char detected_networks[MAX_DETECTED_NETWORKS][64];
            int network_count = detect_local_networks(detected_networks, MAX_DETECTED_NETWORKS);

            if (network_count <= 0) {
                log_error("Failed to auto-detect networks for ONVIF discovery");
                return -1;
            }

            // Use the first detected network
            strncpy(selected_network, detected_networks[0], sizeof(selected_network) - 1);
            selected_network[sizeof(selected_network) - 1] = '\0';

            log_info("Auto-detected network for ONVIF discovery: %s", selected_network);

            // Use the selected network
            network = selected_network;
        }
    }

    log_info("Starting ONVIF discovery on network %s", network);

    // Parse network
    if (parse_network(network, &base_addr, &subnet_mask) != 0) {
        log_error("Failed to parse network: %s", network);
        return -1;
    }

    // Calculate network range
    uint32_t network_addr = base_addr & subnet_mask;
    uint32_t broadcast = network_addr | ~subnet_mask;
    // Array to store IPs with open ports
    #define MAX_CANDIDATE_IPS 256
    char candidate_ips[MAX_CANDIDATE_IPS][16];
    int candidate_count = 0;

    log_info("Skipping slow TCP pre-scan; using UDP broadcast and multicast for ONVIF discovery");
    
    // If no candidates found, probe every host directly (plus broadcast and multicast)
    if (candidate_count == 0) {
        count = probe_hosts_for_onvif(network_addr + 1, broadcast - 1, true, devices, max_devices);
        if (count < 0) {
            return -1;
        }
    } else {
        // Create a socket for discovery probes
        discovery_sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (discovery_sock < 0) {
            log_error("Failed to create discovery socket: %s", strerror(errno));
            return -1;
        }

        // Set socket options for broadcast
        if (setsockopt(discovery_sock, SOL_SOCKET, SO_BROADCAST, &broadcast_enabled, sizeof(broadcast_enabled)) < 0) {
            log_error("Failed to set SO_BROADCAST option: %s", strerror(errno));
            close(discovery_sock);
            return -1;
        }

        // Try binding to any interface to improve reliability
        struct sockaddr_in bind_addr;
        memset(&bind_addr, 0, sizeof(bind_addr));
        bind_addr.sin_family = AF_INET;
        bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
        bind_addr.sin_port = htons(0);  // Use any available port for sending

        if (bind(discovery_sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
            log_warn("Failed to bind discovery socket: %s", strerror(errno));
            // Continue anyway, might still work
        }

        // Set up destination address structure
        struct sockaddr_in dest_addr;
        memset(&dest_addr, 0, sizeof(dest_addr));
        dest_addr.sin_family = AF_INET;
        
        // Send probes to each candidate IP
        log_info("Sending discovery probes to %d candidate IPs", candidate_count);
        
        for (int i = 0; i < candidate_count; i++) {
            // Try port 3702 (ONVIF discovery)
            dest_addr.sin_port = htons(3702);
            if (inet_aton(candidate_ips[i], &dest_addr.sin_addr) != 0) {
                log_debug("Sending discovery probe to %s:3702", candidate_ips[i]);
                send_all_discovery_probes(discovery_sock, candidate_ips[i], &dest_addr);
            }
            
            // Try port 80 (HTTP)
            dest_addr.sin_port = htons(80);
            if (inet_aton(candidate_ips[i], &dest_addr.sin_addr) != 0) {
                log_debug("Sending discovery probe to %s:80", candidate_ips[i]);
                send_all_discovery_probes(discovery_sock, candidate_ips[i], &dest_addr);
            }
        }
        
        // Close the sending socket
        close(discovery_sock);
        
        // Try to receive responses
        log_info("Waiting for discovery responses...");
        count = receive_discovery_responses(devices, max_devices);
        
        // If no devices found, try with a slightly shorter timeout to speed up the process
        if (count == 0) {
            log_info("No devices found with standard timeout, trying with shorter timeout");
            count = receive_extended_discovery_responses(devices, max_devices, 1, 2); // 1 sec timeout, 2 attempts
        }
    }

    // Store the discovered devices for later retrieval
    pthread_mutex_lock(&g_discovery_mutex);
    g_discovered_device_count = 0;
    
    for (int i = 0; i < count && i < MAX_DISCOVERED_DEVICES; i++) {
        memcpy(&g_discovered_devices[i], &devices[i], sizeof(onvif_device_info_t));
        g_discovered_device_count++;
    }
    
    pthread_mutex_unlock(&g_discovery_mutex);

    // If we didn't find any devices with WS-Discovery, try direct HTTP probing
    if (count == 0 && candidate_count > 0) {
        log_info("No devices found with WS-Discovery, trying direct HTTP probing");
        count = try_direct_http_discovery(candidate_ips, candidate_count, devices, max_devices);
    }

    log_info("ONVIF discovery completed, found %d devices", count);

    // Return 0 instead of -1 when no devices are found
    return count < 0 ? 0 : count;
}

// Forward declaration of the callback function
static size_t onvif_curl_write_callback(void *contents, size_t size, size_t nmemb, void *userp);

// Try direct HTTP probing for ONVIF devices
int try_direct_http_discovery(char candidate_ips[][16], int candidate_count, 
                             onvif_device_info_t *devices, int max_devices) {
    int count = 0;
    CURL *curl;
    CURLcode res;
    
    // Initialize CURL global (thread-safe, idempotent)
    if (curl_init_global() != 0) {
        log_error("Failed to initialize curl global for direct HTTP discovery");
        return 0;
    }
    curl = curl_easy_init();
    if (!curl) {
        log_error("Failed to initialize CURL for direct HTTP discovery");
        return 0;
    }
    
    // SOAP request for GetSystemDateAndTime (simple request that doesn't require authentication)
    const char *soap_request = 
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\">"
        "  <s:Body xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">"
        "    <GetSystemDateAndTime xmlns=\"http://www.onvif.org/ver10/device/wsdl\"/>"
        "  </s:Body>"
        "</s:Envelope>";
    
    // Common ONVIF device service paths to try
    const char *onvif_paths[] = {
        "/onvif/device_service",
        "/onvif/services",
        "/onvif/service",
        "/onvif/devices",
        "/onvif/device",
        "/device_service",
        "/services",
        "/service",
        NULL
    };
    
    // Set up CURL options
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 2L);  // Short timeout
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 1L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, soap_request);
    curl_easy_setopt(curl, CURLOPT_NOBODY, 0L);
    
    // Set HTTP headers
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/soap+xml; charset=utf-8");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    
    // Disable verbose output and don't write response to stdout
    curl_easy_setopt(curl, CURLOPT_VERBOSE, 0L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, onvif_curl_write_callback);
    
    log_info("Starting direct HTTP/HTTPS probing for %d candidate IPs", candidate_count);

    // Try HTTP first, then HTTPS (some cameras only expose ONVIF over TLS)
    // codeql[cpp/non-https-url] - ONVIF discovery probes both HTTP and HTTPS on the local network
    const char *schemes[] = {"http", "https", NULL};

    // Try each candidate IP
    for (int i = 0; i < candidate_count && count < max_devices; i++) {
        const char *ip = candidate_ips[i];
        log_info("Probing IP %s for ONVIF services", ip);
        bool device_found = false;

        for (int s = 0; schemes[s] != NULL && !device_found && count < max_devices; s++) {
            const char *scheme = schemes[s];
            bool is_https = (schemes[s][4] == 's');  /* "https" vs "http" */

            // IP cameras almost always use self-signed certificates; skip peer/host
            // verification for HTTPS so we can reach them without a trusted CA.
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, is_https ? 0L : 1L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, is_https ? 0L : 2L);

            // Try each ONVIF path
            for (int j = 0; onvif_paths[j] != NULL && !device_found && count < max_devices; j++) {
                char url[256];
                snprintf(url, sizeof(url), "%s://%s%s", scheme, ip, onvif_paths[j]);

                log_debug("Trying URL: %s", url);
                curl_easy_setopt(curl, CURLOPT_URL, url);

                // Perform the request
                res = curl_easy_perform(curl);

                // Check if successful
                if (res == CURLE_OK) {
                    long http_code = 0;
                    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

                    if (http_code >= 200 && http_code < 300) {
                        log_info("Found ONVIF device at %s", url);

                        // Initialize device info
                        memset(&devices[count], 0, sizeof(onvif_device_info_t));

                        // Set device info
                        strncpy(devices[count].ip_address, ip, sizeof(devices[count].ip_address) - 1);
                        strncpy(devices[count].device_service, url, sizeof(devices[count].device_service) - 1);
                        strncpy(devices[count].endpoint, url, sizeof(devices[count].endpoint) - 1);
                        snprintf(devices[count].model, sizeof(devices[count].model),
                                 "Unknown (%s discovery)", is_https ? "HTTPS" : "HTTP");

                        // Set discovery time and online status
                        devices[count].discovery_time = time(NULL);
                        devices[count].online = true;

                        count++;
                        device_found = true;  /* stop trying other paths/schemes for this IP */
                    }
                }
            }
        }
    }

    // Clean up (Note: Don't call curl_global_cleanup() - it's managed centrally)
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    log_info("Direct HTTP/HTTPS probing completed, found %d devices", count);
    
    return count;
}

// Callback function for CURL to discard response data
static size_t onvif_curl_write_callback(void *contents, size_t size, size_t nmemb, void *userp) {
    // Just discard the data, we only care if the request succeeds
    return size * nmemb;
}

// Probe every address in [first, last] (host byte order) with a unicast
// WS-Discovery probe and return the ONVIF devices that answer from inside
// that range. Used by the subnet scan.
int discover_onvif_devices_in_range(uint32_t first, uint32_t last,
                                    onvif_device_info_t *devices, int max_devices) {
    if (!devices || max_devices <= 0 || first > last) {
        return -1;
    }
    return probe_hosts_for_onvif(first, last, false, devices, max_devices);
}
