#ifndef CLOUD_STORAGE_H
#define CLOUD_STORAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>

/*
 * Cloud storage for recordings, set up from Settings.
 *
 * Cameras keep recording to the local disk (or NAS). Each finished recording
 * made after the cloud was connected is queued and uploaded in the background
 * with rclone (S3-compatible storage or Azure Blob). Uploads that fail (no
 * internet, cloud down) are retried with back-off, so nothing is lost while
 * the connection is down. Local copies are kept.
 */

typedef struct {
    bool enabled;
    char provider[16];      /* "s3" or "azureblob" */
    char s3_provider[16];   /* rclone S3 provider: AWS, Wasabi, Cloudflare, Minio, Other */
    char endpoint[256];     /* S3 endpoint URL (empty for AWS) */
    char region[64];
    char bucket[256];       /* S3 bucket or Azure container */
    char access_key[256];   /* S3 access key ID or Azure account name */
    char secret_key[256];   /* S3 secret or Azure account key; never returned by the API */
    char prefix[256];       /* folder inside the bucket */
    bool events_only;       /* upload only motion/detection recordings */
    int bwlimit_mbps;       /* total upload limit in Mbit/s, 0 = no limit */
    time_t enabled_since;   /* recordings from this time on are uploaded */
} cloud_config_t;

typedef enum {
    CLOUD_STATE_DISABLED = 0,
    CLOUD_STATE_ACTIVE,      /* uploads are working */
    CLOUD_STATE_ERROR        /* last uploads failed (e.g. no internet); retrying */
} cloud_state_t;

typedef struct {
    cloud_state_t state;
    int queue_waiting;           /* recordings waiting for upload */
    int uploaded_today;
    uint64_t uploaded_today_bytes;
    time_t last_upload_at;
    char error[256];
} cloud_status_t;

int cloud_storage_init(const char *config_dir);
void cloud_storage_shutdown(void);

void cloud_get_config(cloud_config_t *out);
void cloud_get_status(cloud_status_t *out);
const char *cloud_state_name(cloud_state_t state);

/* Check that @p cfg can list the bucket and write and delete a test file. */
int cloud_test(const cloud_config_t *cfg, char *err, size_t err_len);

/* Test, save and start uploading new recordings. */
int cloud_connect(const cloud_config_t *cfg, char *err, size_t err_len);

/* Stop uploading (queued uploads are kept for a later connect) and save. */
int cloud_disconnect(void);

#endif /* CLOUD_STORAGE_H */
