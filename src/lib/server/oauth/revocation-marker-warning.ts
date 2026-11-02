// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '../utils/logger';

const logger = Logger.for('OAuth:Revocation');
const WARN_INTERVAL_MS = 30_000;
let lastWarnAt = 0;

/**
 * Rate-limited warning for "the cross-replica revocation marker could not be
 * read". Token validation then confirms cached tokens against their row, so
 * an operator should know propagation is degraded and auth costs an extra
 * read per request.
 */
export function warnRevocationMarkerUnavailable(err: unknown, now: number = Date.now()): void {
    if (now - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = now;
    logger.warn('Token revocation marker unavailable; confirming cached tokens against the DB', {
        error: String(err),
    });
}
