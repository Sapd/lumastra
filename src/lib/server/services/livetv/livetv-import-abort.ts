// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Message of the error the Live TV task wrappers throw from the progress
 * callback when an admin cancels a run. Shared so the import service can tell
 * a cancel from a real failure.
 */
export const LIVETV_IMPORT_CANCELLED = 'Cancelled by admin';

export class LiveTvImportCancelledError extends Error {
    constructor() {
        super(LIVETV_IMPORT_CANCELLED);
        this.name = 'LiveTvImportCancelledError';
    }
}

/**
 * True for the cancel error, also when a transaction helper or driver rethrew
 * it wrapped (as `cause`) or as a plain Error carrying the same message.
 */
export function isLiveTvImportCancelled(error: unknown): boolean {
    for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; depth++) {
        if (e instanceof LiveTvImportCancelledError || e.message === LIVETV_IMPORT_CANCELLED) {
            return true;
        }
        e = e.cause;
    }
    return false;
}
