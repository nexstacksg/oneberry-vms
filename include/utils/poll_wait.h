#ifndef POLL_WAIT_H
#define POLL_WAIT_H

#include <errno.h>
#include <poll.h>

/**
 * Wait until @p fd is ready for @p events (POLLIN or POLLOUT).
 *
 * Use this instead of select(): select() cannot handle file descriptors at or
 * above FD_SETSIZE (1024), and with many cameras the process has more open
 * files than that, so FD_SET would write past the end of the fd_set.
 *
 * Like select(), an error or hang-up on the socket counts as ready, so a
 * non-blocking connect() is then checked with SO_ERROR.
 *
 * @return > 0 when ready, 0 on timeout, < 0 on error (errno set)
 */
static inline int poll_wait_fd(int fd, short events, int timeout_ms) {
    struct pollfd pfd = { .fd = fd, .events = events, .revents = 0 };
    int ret;
    do {
        ret = poll(&pfd, 1, timeout_ms);
    } while (ret < 0 && errno == EINTR);
    return ret;
}

#endif /* POLL_WAIT_H */
