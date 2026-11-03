#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE  // timegm()
#endif
#include "video/onvif_device_management.h"
#include "video/onvif_soap.h"
#include "video/stream_manager.h"
#include "core/config.h"
#include "core/logger.h"
#include "database/db_streams.h"
#include "video/stream_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <curl/curl.h>
#include "ezxml.h"
#include <libavformat/avformat.h>
#include "core/url_utils.h"

// Structure to store memory for CURL responses
typedef struct {
    char *memory;
    size_t size;
} MemoryStruct;

// Callback function for CURL to write received data
static size_t write_callback(void *contents, size_t size, size_t nmemb, void *userp) {
    size_t realsize = size * nmemb;
    MemoryStruct *mem = (MemoryStruct *)userp;

    char *ptr = realloc(mem->memory, mem->size + realsize + 1);
    if (ptr == NULL) {
        log_error("Not enough memory (realloc returned NULL)");
        return 0;
    }

    mem->memory = ptr;
    memcpy(&(mem->memory[mem->size]), contents, realsize);
    mem->size += realsize;
    mem->memory[mem->size] = 0;

    return realsize;
}

// Send a SOAP request to the ONVIF device
static char* send_soap_request(const char *device_url, const char *soap_action, const char *request_body,
                              const char *username, const char *password) {
    CURL *curl;
    CURLcode res;
    MemoryStruct chunk;
    struct curl_slist *headers = NULL;
    char *soap_envelope = NULL;
    char *response = NULL;
    char *security_header = NULL;
    
    // Initialize memory chunk
    chunk.memory = malloc(1);
    chunk.size = 0;
    
    curl = curl_easy_init();
    if (!curl) {
        log_error("Failed to initialize CURL");
        free(chunk.memory);
        return NULL;
    }
    
    // Log the request details
    log_info("Sending SOAP request to: %s", device_url);
    log_info("Request body: %s", request_body);
    
    // Create security header if authentication is required
    if (username && password && strlen(username) > 0 && strlen(password) > 0) {
        security_header = onvif_create_security_header(username, password);
        log_info("Using authentication with username: %s", username);
    } else {
        security_header = strdup("");
        log_info("No authentication credentials provided");
    }
    
    // Try simpler SOAP envelope format for better compatibility with onvif_simple_server
    // Based on the curl example that worked
    soap_envelope = malloc(strlen(request_body) + strlen(security_header) + 1024);
    
    // First try with simplified envelope format
    sprintf(soap_envelope,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<s:Envelope xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\">"
        "<s:Header>%s</s:Header>"
        "<s:Body xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" "
        "xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">%s</s:Body>"
        "</s:Envelope>",
        security_header, request_body);
    
    // Set up the HTTP headers
    headers = curl_slist_append(headers, "Content-Type: application/soap+xml; charset=utf-8");
    if (soap_action) {
        char soap_action_header[256];
        sprintf(soap_action_header, "SOAPAction: %s", soap_action);
        headers = curl_slist_append(headers, soap_action_header);
    }
    
    // Set up CURL options with more verbose debugging
    curl_easy_setopt(curl, CURLOPT_URL, device_url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, soap_envelope);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, (void *)&chunk);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L); // Enable verbose output
    
    // Perform the request
    res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        log_error("CURL failed: %s", curl_easy_strerror(res));

        // If the first attempt failed, try with the original envelope format
        log_info("First SOAP format failed, trying alternative format");

        // Reset response buffer for retry
        free(chunk.memory);
        chunk.memory = malloc(1);
        chunk.size = 0;

        free(soap_envelope);
        soap_envelope = malloc(strlen(request_body) + strlen(security_header) + 1024);
        sprintf(soap_envelope,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            "<SOAP-ENV:Envelope "
                "xmlns:SOAP-ENV=\"http://www.w3.org/2003/05/soap-envelope\" "
                "xmlns:SOAP-ENC=\"http://www.w3.org/2003/05/soap-encoding\" "
                "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" "
                "xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" "
                "xmlns:wsa=\"http://www.w3.org/2005/08/addressing\" "
                "xmlns:tds=\"http://www.onvif.org/ver10/device/wsdl\" "
                "xmlns:trt=\"http://www.onvif.org/ver10/media/wsdl\" "
                "xmlns:timg=\"http://www.onvif.org/ver20/imaging/wsdl\" "
                "xmlns:tev=\"http://www.onvif.org/ver10/events/wsdl\" "
                "xmlns:tptz=\"http://www.onvif.org/ver20/ptz/wsdl\">"
                "<SOAP-ENV:Header>%s</SOAP-ENV:Header>"
                "<SOAP-ENV:Body>%s</SOAP-ENV:Body>"
            "</SOAP-ENV:Envelope>",
            security_header, request_body);

        // Retry the request
        res = curl_easy_perform(curl);
        if (res != CURLE_OK) {
            log_error("Both SOAP formats failed: %s", curl_easy_strerror(res));
        } else {
            log_info("Second SOAP format succeeded");
        }
    } else {
        log_info("First SOAP format succeeded");
    }

    // Check HTTP response code and parse any SOAP fault
    if (res == CURLE_OK) {
        long http_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

        if (http_code != 200) {
            log_error("ONVIF device management request failed with HTTP code %ld", http_code);
            if (chunk.size > 0) {
                onvif_log_soap_fault(chunk.memory, chunk.size, "Device Management");
            }
        } else if (chunk.size > 0) {
            response = strdup(chunk.memory);
        }
    }

    // Log response if available
    if (response) {
        // Log first 200 characters of response for debugging
        char debug_response[201] = {0};
        strncpy(debug_response, response, 200);
        log_info("Response (first 200 chars): %s", debug_response);
    }
    
    // Clean up
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);
    free(soap_envelope);
    free(security_header);
    free(chunk.memory);
    
    return response;
}

// Find a child element by name
// Element name without its namespace prefix ("env:Body" -> "Body")
static const char *local_name(const char *name) {
    const char *colon = name ? strchr(name, ':') : NULL;
    return colon ? colon + 1 : name;
}

// Find a child by local name, whatever prefix the camera uses: cameras write
// env:Body, SOAP-ENV:Body, s:Body, tr2:Profiles... for the same elements
static ezxml_t find_child(ezxml_t parent, const char *name) {
    if (!parent || !name) return NULL;
    const char *wanted = local_name(name);
    for (ezxml_t child = parent->child; child; child = child->sibling) {
        if (strcmp(local_name(child->name), wanted) == 0) {
            return child;
        }
    }
    return NULL;
}

// Find a child element by name with namespace prefix
static ezxml_t find_child_with_ns(ezxml_t parent, const char *ns, const char *name) {
    if (!parent) return NULL;
    
    (void)ns;  // match on the local name; prefixes differ between cameras
    return find_child(parent, name);
}

// Find all elements with a specific name
static void find_elements_by_name(ezxml_t root, const char *name, ezxml_t *results, int *count, int max_count) {
    if (!root || !name || !results || !count || max_count <= 0) return;
    
    // Check if the current element matches
    if (strcmp(local_name(root->name), local_name(name)) == 0) {
        if (*count < max_count) {
            results[*count] = root;
            (*count)++;
        }
    }
    
    // Check children
    for (ezxml_t child = root->child; child; child = child->sibling) {
        find_elements_by_name(child, name, results, count, max_count);
    }
}

// Get media service URL from device service
static char* get_media_service_url(const char *device_url, const char *username, const char *password) {
    const char *request_body =
        "<GetServices xmlns=\"http://www.onvif.org/ver10/device/wsdl\">"
            "<IncludeCapability>false</IncludeCapability>"
        "</GetServices>";
    
    char *response = send_soap_request(device_url, NULL, request_body, username, password);
    if (!response) {
        log_error("Failed to get services");
        return NULL;
    }
    
    // Parse the XML response
    ezxml_t xml = ezxml_parse_str(response, strlen(response));
    if (!xml) {
        log_error("Failed to parse XML response");
        free(response);
        return NULL;
    }
    
    // Find the media service URL
    char *media_url = NULL;
    
    // Try with SOAP-ENV namespace first
    ezxml_t body = find_child(xml, "SOAP-ENV:Body");
    if (!body) {
        // Try with s namespace (used by onvif_simple_server)
        body = find_child(xml, "s:Body");
        log_info("Using 's:Body' namespace for XML parsing");
    }
    
    if (body) {
        // Try with tds namespace
        ezxml_t get_services_response = find_child(body, "tds:GetServicesResponse");
        if (!get_services_response) {
            // Try without namespace prefix
            get_services_response = find_child(body, "GetServicesResponse");
            log_info("Using 'GetServicesResponse' without namespace for XML parsing");
        }
        
        if (get_services_response) {
            // Try with tds namespace
            ezxml_t service = find_child(get_services_response, "tds:Service");
            if (!service) {
                // Try without namespace prefix
                service = find_child(get_services_response, "Service");
                log_info("Using 'Service' without namespace for XML parsing");
            }
            
            while (service) {
                // Try with and without namespace for Namespace element
                ezxml_t namespace = find_child(service, "Namespace");
                if (!namespace) {
                    namespace = find_child(service, "tds:Namespace");
                }
                
                if (namespace && strcmp(ezxml_txt(namespace), "http://www.onvif.org/ver10/media/wsdl") == 0) {
                    // Try with and without namespace for XAddr element
                    ezxml_t xaddr = find_child(service, "XAddr");
                    if (!xaddr) {
                        xaddr = find_child(service, "tds:XAddr");
                    }
                    
                    if (xaddr) {
                        media_url = strdup(ezxml_txt(xaddr));
                        char safe_media_url[MAX_URL_LENGTH];
                        if (url_redact_for_logging(media_url, safe_media_url, sizeof(safe_media_url)) != 0) {
                            strncpy(safe_media_url, "[invalid-url]", sizeof(safe_media_url) - 1);
                            safe_media_url[sizeof(safe_media_url) - 1] = '\0';
                        }
                        log_info("Found media service URL: %s", safe_media_url);
                        break;
                    }
                }
                
                // Try next sibling
                service = service->next;
                if (!service) {
                    // Try next sibling with different method
                    service = ezxml_next(get_services_response->child);
                }
            }
        }
    }
    
    // If we still don't have a media URL, try a fallback approach for onvif_simple_server
    if (!media_url) {
        log_info("Standard XML parsing failed, trying fallback for onvif_simple_server");
        
        // For onvif_simple_server, we might need to use the device URL as the media URL
        // with a different path
        char *device_path = strstr(device_url, "/onvif/");
        if (device_path) {
            // Construct media URL by replacing "/device_service" with "/media_service"
            const char *media_path = strstr(device_path, "/device_service");
            if (media_path) {
                size_t prefix_len = media_path - device_url;
                // prefix already ends in ".../onvif", so only the last segment changes
                size_t media_url_size = prefix_len + strlen("/media_service") + 1;
                media_url = malloc(media_url_size);
                if (media_url) {
                    snprintf(media_url, media_url_size, "%.*s/media_service", (int)prefix_len, device_url);
                    char safe_media_url[MAX_URL_LENGTH];
                    if (url_redact_for_logging(media_url, safe_media_url, sizeof(safe_media_url)) != 0) {
                        strncpy(safe_media_url, "[invalid-url]", sizeof(safe_media_url) - 1);
                        safe_media_url[sizeof(safe_media_url) - 1] = '\0';
                    }
                    log_info("Created fallback media URL: %s", safe_media_url);
                }
            } else {
                // Just use the device URL as the media URL
                media_url = strdup(device_url);
                char safe_media_url[MAX_URL_LENGTH];
                if (url_redact_for_logging(media_url, safe_media_url, sizeof(safe_media_url)) != 0) {
                    strncpy(safe_media_url, "[invalid-url]", sizeof(safe_media_url) - 1);
                    safe_media_url[sizeof(safe_media_url) - 1] = '\0';
                }
                log_info("Using device URL as media URL: %s", safe_media_url);
            }
        }
    }
    
    // Clean up
    ezxml_free(xml);
    free(response);
    
    return media_url;
}

// Read a number from <...:Name>N</...:Name> under `parent`, or -1
static int xml_child_int(ezxml_t parent, const char *name) {
    ezxml_t node = find_child(parent, name);
    return node ? atoi(ezxml_txt(node)) : -1;
}

// Ask the camera for its UTC time (GetSystemDateAndTime needs no login) and
// make following WS-Security timestamps on this thread use the camera's
// clock. Many cameras reject a login whose timestamp is a few minutes off.
static void sync_camera_clock(const char *device_url) {
    onvif_set_camera_clock_offset(0);
    const char *request_body = "<GetSystemDateAndTime xmlns=\"http://www.onvif.org/ver10/device/wsdl\"/>";
    char *response = send_soap_request(device_url, NULL, request_body, NULL, NULL);
    if (!response) {
        return;
    }
    time_t now = time(NULL);
    ezxml_t xml = ezxml_parse_str(response, strlen(response));
    ezxml_t found[1];
    int count = 0;
    if (xml) {
        find_elements_by_name(xml, "UTCDateTime", found, &count, 1);
    }
    if (count == 1) {
        ezxml_t date = find_child(found[0], "Date");
        ezxml_t clock = find_child(found[0], "Time");
        struct tm camera_tm = {0};
        camera_tm.tm_year = xml_child_int(date, "Year") - 1900;
        camera_tm.tm_mon = xml_child_int(date, "Month") - 1;
        camera_tm.tm_mday = xml_child_int(date, "Day");
        camera_tm.tm_hour = xml_child_int(clock, "Hour");
        camera_tm.tm_min = xml_child_int(clock, "Minute");
        camera_tm.tm_sec = xml_child_int(clock, "Second");
        if (camera_tm.tm_year > 70 && camera_tm.tm_mon >= 0 && camera_tm.tm_mday > 0 &&
            camera_tm.tm_hour >= 0 && camera_tm.tm_min >= 0 && camera_tm.tm_sec >= 0) {
            long offset = (long)(timegm(&camera_tm) - now);
            // Small differences do not matter; only correct real clock drift
            if (offset > 5 || offset < -5) {
                onvif_set_camera_clock_offset(offset);
                log_info("Camera clock differs from server by %+ld s; using camera time for ONVIF login", offset);
            }
        }
    }
    if (xml) ezxml_free(xml);
    free(response);
}

// Get ONVIF device profiles
int get_onvif_device_profiles(const char *device_url, const char *username, 
                             const char *password, onvif_profile_t *profiles, 
                             int max_profiles) {
    sync_camera_clock(device_url);
    char *media_url = get_media_service_url(device_url, username, password);
    if (!media_url) {
        log_error("Couldn't get media service URL");
        return 0;
    }
    
    char safe_device_url[MAX_URL_LENGTH];
    char safe_media_url[MAX_URL_LENGTH];
    if (url_redact_for_logging(device_url, safe_device_url, sizeof(safe_device_url)) != 0) {
        strncpy(safe_device_url, "[invalid-url]", sizeof(safe_device_url) - 1);
        safe_device_url[sizeof(safe_device_url) - 1] = '\0';
    }
    if (url_redact_for_logging(media_url, safe_media_url, sizeof(safe_media_url)) != 0) {
        strncpy(safe_media_url, "[invalid-url]", sizeof(safe_media_url) - 1);
        safe_media_url[sizeof(safe_media_url) - 1] = '\0';
    }
    log_info("Getting profiles for ONVIF device: %s (Media URL: %s)", safe_device_url, safe_media_url);
    
    const char *request_body = "<GetProfiles xmlns=\"http://www.onvif.org/ver10/media/wsdl\"/>";
    char *response = send_soap_request(media_url, NULL, request_body, username, password);
    if (!response) {
        log_error("Failed to get profiles");
        free(media_url);
        return 0;
    }
    
    // Parse the XML response
    ezxml_t xml = ezxml_parse_str(response, strlen(response));
    if (!xml) {
        log_error("Failed to parse XML response");
        free(response);
        free(media_url);
        return 0;
    }
    
    // Find all profiles
    ezxml_t profile_elements[max_profiles];
    int profile_count = 0;
    
    ezxml_t body = find_child(xml, "SOAP-ENV:Body");
    if (body) {
        ezxml_t get_profiles_response = find_child(body, "trt:GetProfilesResponse");
        if (get_profiles_response) {
            ezxml_t profile = find_child(get_profiles_response, "trt:Profiles");
            while (profile && profile_count < max_profiles) {
                profile_elements[profile_count++] = profile;
                profile = profile->next;
            }
        }
    }
    
    if (profile_count == 0) {
        log_error("No profiles found");
        ezxml_free(xml);
        free(response);
        free(media_url);
        return 0;
    }
    
    log_info("Found %d profiles, returning up to %d", profile_count, max_profiles);
    
    int count = (profile_count < max_profiles) ? profile_count : max_profiles;
    
    for (int i = 0; i < count; i++) {
        ezxml_t profile = profile_elements[i];
        
        // Get profile token
        const char *token = ezxml_attr(profile, "token");
        if (token) {
            strncpy(profiles[i].token, token, sizeof(profiles[i].token) - 1);
            profiles[i].token[sizeof(profiles[i].token) - 1] = '\0';
        }
        
        // Get profile name
        ezxml_t name = find_child(profile, "tt:Name");
        if (name) {
            strncpy(profiles[i].name, ezxml_txt(name), sizeof(profiles[i].name) - 1);
            profiles[i].name[sizeof(profiles[i].name) - 1] = '\0';
        }
        
        // Get video encoder configuration
        ezxml_t video_encoder = find_child(profile, "tt:VideoEncoderConfiguration");
        if (video_encoder) {
            ezxml_t encoding = find_child(video_encoder, "tt:Encoding");
            if (encoding) {
                strncpy(profiles[i].encoding, ezxml_txt(encoding), sizeof(profiles[i].encoding) - 1);
                profiles[i].encoding[sizeof(profiles[i].encoding) - 1] = '\0';
            }
            
            ezxml_t resolution = find_child(video_encoder, "tt:Resolution");
            if (resolution) {
                ezxml_t width = find_child(resolution, "tt:Width");
                if (width) {
                    profiles[i].width = (int)strtol(ezxml_txt(width), NULL, 10);
                }

                ezxml_t height = find_child(resolution, "tt:Height");
                if (height) {
                    profiles[i].height = (int)strtol(ezxml_txt(height), NULL, 10);
                }
            }

            ezxml_t rate_control = find_child(video_encoder, "tt:RateControl");
            if (rate_control) {
                ezxml_t fps = find_child(rate_control, "tt:FrameRateLimit");
                if (fps) {
                    profiles[i].fps = (int)strtol(ezxml_txt(fps), NULL, 10);
                }

                ezxml_t bitrate = find_child(rate_control, "tt:BitrateLimit");
                if (bitrate) {
                    profiles[i].bitrate = (int)strtol(ezxml_txt(bitrate), NULL, 10);
                }
            }
        }
        
        // Get the stream URI for this profile
        get_onvif_stream_url(device_url, username, password, profiles[i].token, 
                            profiles[i].stream_uri, sizeof(profiles[i].stream_uri));
    }
    
    // Clean up
    ezxml_free(xml);
    free(response);
    free(media_url);
    
    return count;
}

// Get ONVIF stream URL for a specific profile
int get_onvif_stream_url(const char *device_url, const char *username, 
                        const char *password, const char *profile_token, 
                        char *stream_url, size_t url_size) {
    char *media_url = get_media_service_url(device_url, username, password);
    if (!media_url) {
        log_error("Couldn't get media service URL");
        return -1;
    }
    
    char safe_device_url[MAX_URL_LENGTH];
    if (url_redact_for_logging(device_url, safe_device_url, sizeof(safe_device_url)) != 0) {
        strncpy(safe_device_url, "[invalid-url]", sizeof(safe_device_url) - 1);
        safe_device_url[sizeof(safe_device_url) - 1] = '\0';
    }
    log_info("Getting stream URL for ONVIF device: %s, profile: %s", safe_device_url, profile_token);
    
    // Create request body for GetStreamUri
    char request_body[512];
    snprintf(request_body, sizeof(request_body),
        "<GetStreamUri xmlns=\"http://www.onvif.org/ver10/media/wsdl\">"
            "<StreamSetup>"
                "<Stream xmlns=\"http://www.onvif.org/ver10/schema\">RTP-Unicast</Stream>"
                "<Transport xmlns=\"http://www.onvif.org/ver10/schema\">"
                    "<Protocol>RTSP</Protocol>"
                "</Transport>"
            "</StreamSetup>"
            "<ProfileToken>%s</ProfileToken>"
        "</GetStreamUri>",
        profile_token);
    
    char *response = send_soap_request(media_url, NULL, request_body, username, password);
    if (!response) {
        log_error("Failed to get stream URI");
        free(media_url);
        return -1;
    }
    
    // Parse the XML response
    ezxml_t xml = ezxml_parse_str(response, strlen(response));
    if (!xml) {
        log_error("Failed to parse XML response");
        free(response);
        free(media_url);
        return -1;
    }
    
    // Extract the URI
    const char *uri = NULL;
    ezxml_t body = find_child(xml, "SOAP-ENV:Body");
    if (body) {
        ezxml_t get_stream_uri_response = find_child(body, "trt:GetStreamUriResponse");
        if (get_stream_uri_response) {
            ezxml_t media_uri = find_child(get_stream_uri_response, "trt:MediaUri");
            if (media_uri) {
                ezxml_t uri_element = find_child(media_uri, "tt:Uri");
                if (uri_element) {
                    uri = ezxml_txt(uri_element);
                }
            }
        }
    }
    
    if (!uri) {
        log_error("Stream URI not found in response");
        ezxml_free(xml);
        free(response);
        free(media_url);
        return -1;
    }
    
    {
        char safe_uri[MAX_URL_LENGTH];
        if (url_redact_for_logging(uri, safe_uri, sizeof(safe_uri)) != 0) {
            strncpy(safe_uri, "[invalid-url]", sizeof(safe_uri) - 1);
            safe_uri[sizeof(safe_uri) - 1] = '\0';
        }
        log_info("Got stream URI: %s", safe_uri);
    }
    
    // Copy the URI to the output parameter
    strncpy(stream_url, uri, url_size - 1);
    stream_url[url_size - 1] = '\0';
    
    (void)username;
    (void)password;
    
    // Clean up
    ezxml_free(xml);
    free(response);
    free(media_url);
    
    return 0;
}

// Add discovered ONVIF device as a stream
int add_onvif_device_as_stream(const onvif_device_info_t *device_info, 
                              const onvif_profile_t *profile, 
                              const char *username, const char *password, 
                              const char *stream_name) {
    stream_config_t config;
    
    if (!device_info || !profile || !stream_name) {
        log_error("Invalid parameters for add_onvif_device_as_stream");
        return -1;
    }
    
    // Initialize stream configuration
    memset(&config, 0, sizeof(config));
    
    // Set stream name
    strncpy(config.name, stream_name, MAX_STREAM_NAME - 1);
    config.name[MAX_STREAM_NAME - 1] = '\0';
    
    // Store the raw stream URL and keep credentials in dedicated ONVIF fields.
    if (url_strip_credentials(profile->stream_uri, config.url, sizeof(config.url)) != 0) {
        strncpy(config.url, profile->stream_uri, MAX_URL_LENGTH - 1);
        config.url[MAX_URL_LENGTH - 1] = '\0';
    }
    
    // Set stream parameters
    config.enabled = true;  // Enable the stream by default
    config.width = profile->width;
    config.height = profile->height;
    config.fps = profile->fps;
    
    // Set codec - convert ONVIF encoding format to our format
    if (strcasecmp(profile->encoding, "H264") == 0) {
        strncpy(config.codec, "h264", sizeof(config.codec) - 1);
    } else if (strcasecmp(profile->encoding, "H265") == 0) {
        strncpy(config.codec, "h265", sizeof(config.codec) - 1);
    } else {
        // Default to h264 if unknown
        strncpy(config.codec, "h264", sizeof(config.codec) - 1);
        log_warn("Unknown encoding format '%s', defaulting to h264", profile->encoding);
    }
    config.codec[sizeof(config.codec) - 1] = '\0';
    
    // Set default values
    config.priority = 5;
    config.record = true;  // Enable recording by default
    config.segment_duration = 60;
    config.detection_based_recording = true;  // Enable detection-based recording by default
    config.detection_interval = 10;
    config.detection_threshold = 0.5f;
    config.pre_detection_buffer = 5;
    config.post_detection_buffer = 10;
    config.streaming_enabled = true;  // Enable live streaming by default
    config.retention_days = 1;
    config.detection_retention_days = 1;
    
    // Set default detection model to "motion" which doesn't require a separate model file
    strncpy(config.detection_model, "motion", sizeof(config.detection_model) - 1);
    config.detection_model[sizeof(config.detection_model) - 1] = '\0';
    
    // Set protocol to TCP or UDP based on URL (most ONVIF cameras use TCP/RTSP)
    config.protocol = STREAM_PROTOCOL_TCP;
    
    // If URL contains "udp", set protocol to UDP
    if (strstr(profile->stream_uri, "udp") != NULL) {
        config.protocol = STREAM_PROTOCOL_UDP;
    }
    
    // Set ONVIF flag
    config.is_onvif = true;
    
    // Set ONVIF-specific fields
    if (username) {
        strncpy(config.onvif_username, username, sizeof(config.onvif_username) - 1);
        config.onvif_username[sizeof(config.onvif_username) - 1] = '\0';
        
        // For onvif_simple_server compatibility, log the username
        log_info("Setting ONVIF username for stream %s: %s", stream_name, username);
    }
    
    if (password) {
        strncpy(config.onvif_password, password, sizeof(config.onvif_password) - 1);
        config.onvif_password[sizeof(config.onvif_password) - 1] = '\0';
        
        // For onvif_simple_server compatibility, log that we have a password
        log_info("Setting ONVIF password for stream %s", stream_name);
    }
    
    {
        char safe_url[MAX_URL_LENGTH];
        if (url_redact_for_logging(config.url, safe_url, sizeof(safe_url)) != 0) {
            strncpy(safe_url, "[invalid-url]", sizeof(safe_url) - 1);
            safe_url[sizeof(safe_url) - 1] = '\0';
        }
        log_info("Using ONVIF stream URI without embedded credentials: %s", safe_url);
    }
    
    strncpy(config.onvif_profile, profile->token, sizeof(config.onvif_profile) - 1);
    config.onvif_profile[sizeof(config.onvif_profile) - 1] = '\0';
    
    config.onvif_discovery_enabled = true;
    
    // Refuse a camera beyond the supported number (see MAX_STREAMS)
    if (camera_limit_reached()) {
        log_error("Camera limit reached (%d): not adding ONVIF device stream %s", MAX_STREAMS, stream_name);
        return -1;
    }

    // First add the stream to the database
    uint64_t stream_id = add_stream_config(&config);
    if (stream_id == 0) {
        log_error("Failed to add ONVIF device stream configuration to database: %s", stream_name);
        return -1;
    }
    
    log_info("Added ONVIF device stream configuration to database with ID %llu: %s", 
             (unsigned long long)stream_id, stream_name);
    
    // Then add stream to memory
    stream_handle_t handle = add_stream(&config);
    if (!handle) {
        log_error("Failed to add ONVIF device as stream in memory: %s", stream_name);
        // Don't delete from database, as it might be a temporary memory issue
        // The stream will be loaded from the database on next startup
        return -1;
    }
    
    log_info("Added ONVIF device as stream: %s", stream_name);
    
    return 0;
}

// Test connection to an ONVIF device
int test_onvif_connection(const char *url, const char *username, const char *password) {
    sync_camera_clock(url);
    // Attempt to get device profiles as a way to test the connection
    char safe_device_url[MAX_URL_LENGTH];
    if (url_redact_for_logging(url, safe_device_url, sizeof(safe_device_url)) != 0) {
        strncpy(safe_device_url, "[invalid-url]", sizeof(safe_device_url) - 1);
        safe_device_url[sizeof(safe_device_url) - 1] = '\0';
    }
    log_info("Testing connection to ONVIF device: %s", safe_device_url);
    
    onvif_profile_t profiles[1];
    int count = get_onvif_device_profiles(url, username, password, profiles, 1);
    
    if (count <= 0) {
        log_error("Failed to connect to ONVIF device: %s", safe_device_url);
        return -1;
    }
    
    log_info("Successfully connected to ONVIF device: %s", safe_device_url);
    
    // Now test the stream connection
    if (strlen(profiles[0].stream_uri) > 0) {
        char stream_url[MAX_URL_LENGTH];
        char safe_stream_url[MAX_URL_LENGTH];

        if (url_apply_credentials(profiles[0].stream_uri,
                                  (username && strlen(username) > 0) ? username : NULL,
                                  (password && strlen(password) > 0) ? password : NULL,
                                  stream_url, sizeof(stream_url)) != 0) {
            strncpy(stream_url, profiles[0].stream_uri, sizeof(stream_url) - 1);
            stream_url[sizeof(stream_url) - 1] = '\0';
        }

        if (url_redact_for_logging(stream_url, safe_stream_url, sizeof(safe_stream_url)) != 0) {
            strncpy(safe_stream_url, "[invalid-url]", sizeof(safe_stream_url) - 1);
            safe_stream_url[sizeof(safe_stream_url) - 1] = '\0';
        }

        log_info("Testing stream connection for profile: %s, URI: %s",
                 profiles[0].token, safe_stream_url);
        
        // Try to open the stream with TCP protocol first
        AVFormatContext *input_ctx = NULL;
        int ret = open_input_stream(&input_ctx, stream_url, STREAM_PROTOCOL_TCP);
        
        if (ret < 0) {
            log_warn("Failed to connect to stream with TCP protocol, trying UDP: %s", safe_stream_url);
            
            // Try UDP protocol as fallback
            ret = open_input_stream(&input_ctx, stream_url, STREAM_PROTOCOL_UDP);
            
            if (ret < 0) {
                // Try with a direct RTSP URL without any modifications
                log_warn("Failed with UDP protocol too, trying direct RTSP connection");

                log_info("Trying direct RTSP URL: %s", safe_stream_url);
                ret = open_input_stream(&input_ctx, stream_url, STREAM_PROTOCOL_TCP);
                
                if (ret < 0) {
                    log_error("All connection attempts failed for stream: %s", safe_stream_url);
                    return -1;
                }
            }
        }
        
        // Close the stream
        avformat_close_input(&input_ctx);
        log_info("Successfully connected to stream: %s", safe_stream_url);
    }
    
    return 0;
}
