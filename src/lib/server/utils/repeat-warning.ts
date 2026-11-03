// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

interface WarnLogger {
    warn(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * For a loop that fails the same way on every tick while a server is down
 * (PostgreSQL restarting, for example): the first failure in each window is
 * logged as a warning with the number of repeats it stands for, the repeats go
 * to debug. A tick that succeeds ends the outage via `reset()`.
 */
export function createRepeatWarning(
    log: WarnLogger,
    windowMs = 30_000,
): { warn(message: string, meta?: Record<string, unknown>): void; reset(): void } {
    let lastWarnAt = Number.NEGATIVE_INFINITY;
    let repeats = 0;
    return {
        warn(message, meta = {}) {
            const now = Date.now();
            if (now - lastWarnAt < windowMs) {
                repeats++;
                log.debug(message, meta);
                return;
            }
            lastWarnAt = now;
            log.warn(message, repeats > 0 ? { ...meta, repeatsSinceLastWarning: repeats } : meta);
            repeats = 0;
        },
        reset() {
            lastWarnAt = Number.NEGATIVE_INFINITY;
            repeats = 0;
        },
    };
}
