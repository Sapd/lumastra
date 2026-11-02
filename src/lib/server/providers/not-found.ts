// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Definitive "this id does not exist upstream" classification for provider
 * detail errors. 404 and 410 are terminal answers about the item itself;
 * 429/5xx/timeouts/network errors say nothing about it and must stay retriable.
 *
 * Prefers a numeric `status` property (TmdbApiError, and the legacy TMDB
 * plugin provider which attaches one); falls back to the
 * `TMDB API request failed: <status>` message shape for errors that lost
 * their typing on the way through the plugin boundary.
 */
export function isProviderNotFoundError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === 'number') {
            return status === 404 || status === 410;
        }
    }
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /^TMDB API request failed: (404|410)\b/.test(message);
}
