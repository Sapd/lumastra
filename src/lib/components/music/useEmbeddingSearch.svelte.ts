// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { searchMusicByText, searchMusicByLyrics } from '$lib/api/music.js';
import type { MusicSearchResultItem } from '$lib/schemas/api-music-responses';

/**
 * Rune-state primitive that owns the fetch/abort/state machine for embedding
 * (sonic or lyrics) search. Instantiate with `createEmbeddingSearch`.
 *
 * Uses the typed API client (apiGet + problem+json) instead of raw fetch.
 * Each call goes to the def-mounted endpoint which returns `{ items, page }`.
 * `resolvedQuery` is set to the query that was sent (the server no longer
 * echoes a `query` field in the response).
 *
 * The `enabled` guard lives at the call site — the component only calls
 * `search()` when enabled.
 */

/** Maps the BFF endpoint path to the matching typed client function. */
function resolveSearchFn(endpoint: string) {
    if (endpoint.includes('lyrics-search')) return searchMusicByLyrics;
    return searchMusicByText;
}

export class EmbeddingSearch {
    loading = $state(false);
    errorMsg = $state<string | null>(null);
    tracks = $state<MusicSearchResultItem[]>([]);
    resolvedQuery = $state('');
    fetchedForQuery = $state<string | null>(null);
    /** Track the in-flight query to prevent duplicate fetches. */
    inFlightQuery = $state<string | null>(null);

    #controller: AbortController | null = null;

    constructor(private readonly endpoint: () => string) {}

    async search(q: string): Promise<void> {
        if (!q.trim()) return;
        // Abort any in-flight request before starting a new one.
        this.#controller?.abort();
        const controller = new AbortController();
        this.#controller = controller;
        this.loading = true;
        this.errorMsg = null;
        // Mark in-flight optimistically so a second expand can't double-fire.
        this.inFlightQuery = q;

        const searchFn = resolveSearchFn(this.endpoint());

        try {
            const result = await searchFn(q, 30, controller.signal);

            if (this.#controller !== controller) return;
            if (result.error) {
                this.errorMsg = result.error;
                this.tracks = [];
                return;
            }

            this.tracks = result.data?.items ?? [];
            // Server no longer echoes the query — use the one we sent.
            this.resolvedQuery = q;
            this.fetchedForQuery = q;
        } catch {
            if (this.#controller === controller) {
                this.errorMsg = 'Unable to search. Please try again.';
                this.tracks = [];
            }
        } finally {
            // Only the current in-flight query owns the spinner. A request that
            // was superseded (its abort surfaces here as status 0) must NOT flip
            // loading off while the newer request is still running — same guard
            // the `tracks` write uses.
            if (this.#controller === controller) {
                this.loading = false;
                // Clear in-flight marker so a later retry after error can refetch.
                if (this.fetchedForQuery !== q) {
                    this.inFlightQuery = null;
                }
            }
        }
    }

    /** Abort in-flight request and reset all state (cost wall on query change). */
    reset(): void {
        this.#controller?.abort();
        this.#controller = null;
        this.tracks = [];
        this.errorMsg = null;
        this.fetchedForQuery = null;
        this.inFlightQuery = null;
        this.resolvedQuery = '';
        // Clear the spinner too: an in-flight request's finally now gates on
        // inFlightQuery, which we just nulled, so it would never clear loading —
        // leaving the search UI permanently disabled. Reset it here directly.
        this.loading = false;
    }

    /** Abort on component destroy. */
    dispose(): void {
        this.reset();
    }
}

export function createEmbeddingSearch(endpoint: () => string): EmbeddingSearch {
    return new EmbeddingSearch(endpoint);
}
