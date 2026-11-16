#ifndef NAS_STORAGE_H
#define NAS_STORAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>

/*
 * Network storage (NAS) for recordings, set up from Settings.
 *
 * The share (NFS or SMB) is mounted inside the container at NAS_MOUNT_POINT.
 * Like Nx Witness, the NAS has one of two roles:
 *
 *   main    New recordings go to NAS_MOUNT_POINT/recordings while it is
 *           connected and responding; otherwise to the local storage path.
 *   backup  Recordings are always made on the local disk and copied to
 *           NAS_BACKUP_DIR in the background (see nas_backup.h).
 *
 * Recordings already made keep their paths, so old recordings stay playable.
 *
 * Mounting needs the container to have the SYS_ADMIN capability (and an
 * AppArmor profile that allows mount).
 */

#define NAS_MOUNT_POINT "/var/lib/lightnvr/nas"
#define NAS_RECORDINGS_DIR NAS_MOUNT_POINT "/recordings"
#define NAS_BACKUP_DIR NAS_MOUNT_POINT "/backup"

/* Cameras chosen for backup, joined with '\n'; empty = all cameras */
#define NAS_BACKUP_CAMERAS_LEN 16384

typedef struct {
    bool enabled;
    char type[8];        /* "nfs" or "smb" */
    char server[256];    /* IP address or host name */
    char share[512];     /* NFS export path (/volume1/nvr) or SMB share (nvr or nvr/sub) */
    char username[128];  /* SMB only; empty = guest */
    char password[256];  /* SMB only; never returned by the API */
    char version[16];    /* NFS: 4.1, 4, 3; SMB: 3.0, 2.1, 1.0 */
    char role[8];        /* "main" (record to the NAS) or "backup" */

    /* Backup role only */
    char backup_when[12];     /* "realtime" or "schedule" */
    int schedule_start_hour;  /* schedule window, local time, 0-23 ... */
    int schedule_end_hour;    /* ... up to this hour (may wrap past midnight) */
    int bwlimit_mbps;         /* copy speed limit in Mbit/s, 0 = no limit */
    bool events_only;         /* only motion/detection recordings */
    bool include_existing;    /* also recordings made before backup was on */
    bool delete_local;        /* delete the local file after a verified copy */
    int reserve_gb;           /* keep this much free on the NAS (oldest backups go) */
    int keep_days;            /* delete backups older than this, 0 = until full */
    time_t backup_since;      /* backup was turned on at this time */
    char cameras[NAS_BACKUP_CAMERAS_LEN];
} nas_config_t;

typedef enum {
    NAS_STATE_DISABLED = 0,   /* not configured: recordings on local disk */
    NAS_STATE_CONNECTED,      /* mounted and responding: new recordings on the NAS */
    NAS_STATE_UNAVAILABLE     /* configured but not reachable: recordings on local disk */
} nas_state_t;

typedef struct {
    nas_state_t state;
    uint64_t total_bytes;
    uint64_t free_bytes;
    time_t last_check;
    time_t connected_since;
    char error[256];
} nas_status_t;

/* Load the saved NAS settings, connect if enabled, and start the monitor. */
int nas_storage_init(const char *config_dir);
void nas_storage_shutdown(void);

void nas_get_config(nas_config_t *out);
void nas_get_status(nas_status_t *out);
const char *nas_state_name(nas_state_t state);

/* Check that @p cfg can be mounted and written; fills total/free on success. */
int nas_test(const nas_config_t *cfg, nas_status_t *result, char *err, size_t err_len);

/* Test, mount, save and switch new recordings to the NAS. */
int nas_connect(const nas_config_t *cfg, char *err, size_t err_len);

/* Switch new recordings back to the local disk, unmount and save. */
int nas_disconnect(void);

/* Save the role and backup options while connected (no remount). */
int nas_update_options(const nas_config_t *cfg, char *err, size_t err_len);

/* True when NAS recordings are configured but the NAS is not available. */
bool nas_unavailable(void);

/* True when the NAS is configured as backup storage and answering now. */
bool nas_backup_ready(void);

/* True when @p path is a recording on the NAS and the NAS is not connected now
   (disconnected or down): the file is not missing, just out of reach. */
bool nas_path_out_of_reach(const char *path);

/* Root folder for new recordings: the NAS when connected, else @p local_root. */
void nas_recording_root(const char *local_root, char *out, size_t out_len);

/* Folder for new MP4 recordings (NAS/recordings/mp4 or the local MP4 folder). */
void nas_mp4_recording_dir(char *out, size_t out_len);

/*
 * A recording writer keeps one folder for all its segments. Before each new
 * segment it calls this: when the NAS was connected or lost since, @p dir
 * (a folder under the local or NAS MP4 folder) is moved to the other root,
 * created, and true is returned.
 */
bool nas_retarget_recording_dir(char *dir, size_t dir_len);

#endif /* NAS_STORAGE_H */
