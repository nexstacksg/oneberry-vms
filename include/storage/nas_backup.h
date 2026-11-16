#ifndef NAS_BACKUP_H
#define NAS_BACKUP_H

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

/*
 * NAS backup, like Nx Witness backup storage.
 *
 * With the NAS in the "backup" role (nas_storage.h), cameras record to the
 * local disk and finished recordings are copied to NAS_BACKUP_DIR one at a
 * time, oldest first, in real time or in a daily time window, at a limited
 * speed. A copy is written as a ".partial" file, synced, checked against the
 * local file (size and sampled content), then renamed into place.
 *
 * Main and backup storage have their own retention, as in Nx:
 *   - When local retention or disk cleanup removes a recording that has a
 *     backup, only the local file goes; the recording then plays from the
 *     NAS copy (its file_path points there).
 *   - With "delete local copy" on, that happens right after the copy.
 *   - Backups are deleted oldest first to keep the reserved space free on
 *     the NAS, and when older than the backup "keep days" (if set).
 *
 * Queue: table nas_backups (migration 0045), one row per recording.
 */

typedef struct {
    const char *state;          /* off, copying, up_to_date, waiting_schedule, nas_unavailable, error */
    int queue_waiting;          /* recordings waiting to be copied */
    uint64_t queue_bytes;
    time_t backed_up_until;     /* oldest recording still waiting; 0 = nothing waiting */
    int copied_today;
    uint64_t copied_today_bytes;
    time_t last_backup_at;
    double last_speed_mbps;     /* speed of the last copy */
    int backups_total;          /* recordings with a backup copy on the NAS */
    uint64_t backups_bytes;
    char current[128];          /* camera being copied now */
    char error[256];
} nas_backup_status_t;

int nas_backup_init(void);
void nas_backup_shutdown(void);

/* Look for work now (settings changed, NAS back). */
void nas_backup_wake(void);

void nas_backup_get_status(nas_backup_status_t *out);

/* True when @p path is a backup copy on the NAS. */
bool nas_backup_is_backup_path(const char *path);

/*
 * Local retention is about to delete recording @p id stored at @p local_path.
 * When it has a verified backup, point the recording at the backup copy and
 * return true: the caller deletes only the local file and keeps the recording.
 */
bool nas_backup_take_over(uint64_t id, const char *local_path);

#endif /* NAS_BACKUP_H */
