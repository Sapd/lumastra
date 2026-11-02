// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI API domain module
 *
 * Typed functions for AI recommendations, ratings, watchlist (saved movies),
 * chat, onboarding, genre suggestions, and admin AI endpoints.
 *
 * All responses are validated at runtime using Zod schemas.
 */

import { z } from 'zod';
import { apiGet, apiPost, apiDelete } from './client.js';
import {
    WatchlistListResponseSchema,
    type WatchlistListResponse,
    type WatchlistItem,
} from '$lib/schemas/api-watchlist-responses';
import { monitoredFetch } from '$lib/auth-monitor.js';
import type { ExternalIds, ApiMediaTypeInput } from '$lib/types/api-common';
import {
    RateQueueResponseSchema,
    UserStatsResponseSchema,
    GenreResponseSchema,
    RateResponseSchema,
    SaveMovieResponseSchema,
    ResetProfileResponseSchema,
    UserRatingsResponseSchema,
    ChatRateLimitResponseSchema,
    ChatMessageResponseSchema,
    AssistantHistoryResponseSchema,
    AiUsersResponseSchema,
    ClearUserAiDataResponseSchema,
    EmbeddingSearchResponseSchema,
    LookupEmbeddingResponseSchema,
    MdblistStatusResponseSchema,
    WatchHistoryCountResponseSchema,
    RateSkipResponseSchema,
    type RateQueueResponse,
    type UserStatsResponse,
    type RateResponse,
    type SaveMovieResponse,
    type ResetProfileResponse,
    type WatchHistoryCountResponse,
    type ChatMessageResponse,
    type RateSkipResponse,
} from '$lib/schemas/api-ai-responses';
import type { ApiResult } from './types.js';
import {
    EmbeddingPreviewsResponseSchema,
    EmbeddingOverviewStatsSchema,
    VideoEmbeddingStatsSchema,
    MusicEmbeddingStatsSchema,
    EmbeddingTextResponseSchema,
} from '$lib/schemas/admin-types';

// Re-export types for convenience
export type {
    RateQueueResponse,
    UserStatsResponse,
    WatchlistListResponse,
    WatchlistItem,
    RateResponse,
    SaveMovieResponse,
    ResetProfileResponse,
    WatchHistoryCountResponse,
};

// =========================================================================
// Ratings
// =========================================================================

export function submitRating(
    externalIds: ExternalIds,
    mediaType: ApiMediaTypeInput,
    rating: number,
    context?: string,
    opts?: { ratingStyle?: 'quick' | 'stars' },
) {
    return apiPost('/api/ai/rate', RateResponseSchema, {
        externalIds,
        mediaType,
        rating,
        context,
        ratingStyle: opts?.ratingStyle,
    });
}

/** Remove an existing rating (re-tapping an already-active quick-rating button). */
export function clearRating(
    externalIds: ExternalIds,
    mediaType: ApiMediaTypeInput,
    context?: string,
) {
    return apiPost('/api/ai/rate', RateResponseSchema, {
        externalIds,
        mediaType,
        clear: true,
        context,
    });
}

// =========================================================================
// Genre Lookup
// =========================================================================

export function getAvailableGenres(mediaType: string) {
    return apiGet('/api/ai/available-genres', GenreResponseSchema, {
        params: { mediaType },
    });
}

// =========================================================================
// Saved Movies (Watchlist)
// =========================================================================

/**
 * Fetch the caller's watchlist.
 *
 * Points at the canonical `/api/watchlist` endpoint. The former
 * `/api/ai/saved-movies/user` twin was retired: it ran the same
 * `getUserWatchlistMedia` query but emitted a divergent flat shape with three
 * hardcoded "AI" fields and no pagination.
 *
 * Items arrive in the canonical `{ media, isAvailable, … }` envelope — see
 * `toWatchlistStoreItem` in Watchlist.svelte for the flattening adapter that
 * feeds the client store.
 */
export async function getSavedMovies() {
    const load = (offset: number) =>
        apiGet('/api/watchlist', WatchlistListResponseSchema, { params: { offset, limit: 100 } });
    const first = await load(0);
    if (first.error || !first.data) return first;
    const items = [...first.data.items];
    let page = first.data.page;
    while (page.hasMore) {
        const next = await load((page.offset ?? 0) + page.limit);
        if (next.error || !next.data) return next;
        if (!next.data.items.length)
            return { ...next, data: null, error: 'Watchlist pagination did not advance' };
        items.push(...next.data.items);
        page = next.data.page;
    }
    return { ...first, data: { ...first.data, items, page: { ...page, offset: 0 } } };
}

export function saveMovie(body: {
    externalIds: ExternalIds;
    mediaType: ApiMediaTypeInput;
    title?: string;
    overview?: string;
    rating?: number;
    criticRating?: number;
    canRequest?: boolean;
    isAvailable?: boolean;
    availabilitySource?: string;
}) {
    return apiPost('/api/ai/save-movie', SaveMovieResponseSchema, body);
}

export function unsaveMovie(body: { externalIds: ExternalIds; mediaType: ApiMediaTypeInput }) {
    return apiDelete('/api/ai/save-movie', SaveMovieResponseSchema, body);
}

// =========================================================================
// User Stats & Rate Queue
// =========================================================================

export function getUserStats() {
    return apiGet('/api/ai/user-stats', UserStatsResponseSchema);
}

/**
 * Watched-first rating-trainer queue. Pass back the previous page's
 * `nextCursor` as `cursor` to keep excluding items already served this
 * session; omit it (or pass a stale/garbage value) to start a fresh session.
 */
export function getRateQueue(params?: {
    filter?: 'seen' | 'all';
    count?: number;
    cursor?: string;
}) {
    return apiGet('/api/rate/queue', RateQueueResponseSchema, { params });
}

/** Mirrors the UUID_RE in defs/rate/queue.ts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Durable skip beacon — persists skipped items so `getRateQueue` excludes
 * them for ~30 days instead of resurfacing them next session. Best-effort:
 * the endpoint 422s the WHOLE batch if any id isn't a valid UUID, so this
 * filters to UUID-shaped ids first and skips the network call entirely when
 * nothing is left to send.
 */
export function skipRateItems(mediaIds: string[]): Promise<ApiResult<RateSkipResponse>> {
    const ids = mediaIds.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
    if (ids.length === 0) {
        return Promise.resolve({ data: { ok: true }, error: null, status: 200 });
    }
    return apiPost('/api/rate/skip', RateSkipResponseSchema, { mediaIds: ids });
}

// =========================================================================
// Profile
// =========================================================================

export function resetProfile() {
    return apiPost('/api/ai/reset-profile', ResetProfileResponseSchema);
}

// =========================================================================
// User Ratings
// =========================================================================

export function getUserRatings(options?: { limit?: number; rating_min?: number }) {
    return apiGet('/api/ai/user-ratings/user', UserRatingsResponseSchema, {
        params: options,
    });
}

// =========================================================================
// AI Assistant
// =========================================================================

export function getAssistantRateLimit() {
    return apiGet('/api/assistant', ChatRateLimitResponseSchema);
}

export function sendAssistantMessage(
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
    return apiPost('/api/assistant', ChatMessageResponseSchema, {
        message,
        history,
    });
}

/**
 * Fetch the persisted conversation history for the current user so the chat UI
 * can hydrate after a page reload. Text-only (no recommendation cards).
 *
 * @param limit  Max messages to return (server clamps to 1..100).
 * @param after  Optional ISO-8601 cutoff — only messages created strictly after
 *               this timestamp are returned (used to keep a "New chat"-cleared
 *               conversation cleared across reloads).
 */
export function getAssistantHistory(limit = 50, after?: string) {
    const params: Record<string, string | number | boolean | undefined> = { limit };
    if (after) params.after = after;
    return apiGet('/api/assistant/history', AssistantHistoryResponseSchema, { params });
}

// -------------------------------------------------------------------------
// AI Assistant — SSE streaming client
// -------------------------------------------------------------------------

/** Body for a streaming assistant request (mirrors {@link sendAssistantMessage}). */
export interface AssistantStreamPayload {
    message: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** `status` frame payload — either a model round or a tool invocation. */
export interface AssistantStreamStatus {
    phase: 'model' | 'tool';
    round: number;
    /** Tool name — present only when `phase === 'tool'`. */
    tool?: string;
}

/** Client-safe error surfaced by an `error` SSE frame or a pre-stream rejection. */
export interface AssistantStreamError {
    message: string;
    status?: number;
}

/** Typed callbacks invoked as SSE frames are parsed off the stream. */
export interface AssistantStreamHandlers {
    onStatus?: (status: AssistantStreamStatus) => void;
    onText?: (delta: string) => void;
    onThinking?: (delta: string) => void;
    /** Terminal success — the authoritative, schema-validated response. */
    onDone?: (data: ChatMessageResponse) => void;
    /** Terminal failure delivered in-band (HTTP-status rejection or `error` frame). */
    onError?: (error: AssistantStreamError) => void;
}

/**
 * Parse an error message from a non-ok Response, matching the precedence used by
 * the shared API client (problem+json: detail → error → title; legacy: error →
 * message) so streamed errors read identically to {@link sendAssistantMessage}.
 */
async function parseAssistantStreamError(response: Response): Promise<AssistantStreamError> {
    try {
        const data = (await response.json()) as {
            code?: string;
            error?: string;
            detail?: string;
            title?: string;
            message?: string;
        };
        const isProblem = (response.headers.get('content-type') ?? '').includes(
            'application/problem+json',
        );
        const message = isProblem
            ? (data.detail ?? data.error ?? data.title ?? `HTTP ${response.status}`)
            : (data.error ?? data.message ?? `HTTP ${response.status}`);
        return { message, status: response.status };
    } catch {
        return {
            message: response.statusText || `HTTP ${response.status}`,
            status: response.status,
        };
    }
}

/** Dispatch a single fully-buffered `event:/data:` SSE frame to the handlers. */
function dispatchAssistantFrame(frame: string, handlers: AssistantStreamHandlers): void {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line === '' || line.startsWith(':')) continue; // blank / comment
        if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
    }
    if (dataLines.length === 0) return;

    let data: unknown;
    try {
        data = JSON.parse(dataLines.join('\n'));
    } catch {
        return; // malformed frame — skip rather than throw
    }
    const record = (data ?? {}) as Record<string, unknown>;

    switch (eventName) {
        case 'status':
            handlers.onStatus?.({
                phase: record.phase === 'tool' ? 'tool' : 'model',
                round: typeof record.round === 'number' ? record.round : 0,
                tool: typeof record.tool === 'string' ? record.tool : undefined,
            });
            break;
        case 'text':
            handlers.onText?.(typeof record.delta === 'string' ? record.delta : '');
            break;
        case 'thinking':
            handlers.onThinking?.(typeof record.delta === 'string' ? record.delta : '');
            break;
        case 'done': {
            // Validate the terminal payload with the SAME schema sendAssistantMessage
            // uses. Fail-open (mirrors the shared client) so a schema drift doesn't
            // drop an otherwise-usable answer.
            const parsed = ChatMessageResponseSchema.safeParse(data);
            handlers.onDone?.(parsed.success ? parsed.data : (data as ChatMessageResponse));
            break;
        }
        case 'error':
            handlers.onError?.({
                message: typeof record.message === 'string' ? record.message : 'Error',
                status: typeof record.status === 'number' ? record.status : undefined,
            });
            break;
        // unknown event names are ignored
    }
}

/**
 * Send an assistant message and consume the SSE stream, invoking typed handlers
 * as frames arrive.
 *
 * Resolution vs. rejection contract (so the caller can decide on a fallback):
 * - HTTP-status rejections (pre-stream 401/403/429/503 JSON) are delivered via
 *   `onError` and the promise RESOLVES — these must NOT trigger a retry.
 * - `error` frames mid-stream are likewise delivered via `onError` and resolve.
 * - Network-ish failures (fetch throw, body read error) and aborts REJECT, so the
 *   caller can distinguish an AbortError (user pressed Stop) from a transport
 *   failure worth falling back to the non-streaming endpoint for.
 * - If the server answers with JSON instead of an event-stream (older deployment
 *   without SSE), the body is parsed as a ChatMessageResponse and delivered via
 *   `onDone`.
 */
export async function sendAssistantMessageStream(
    payload: AssistantStreamPayload,
    handlers: AssistantStreamHandlers,
    signal?: AbortSignal,
): Promise<void> {
    // monitoredFetch prefixes the base path and handles session-expiry signalling.
    const response = await monitoredFetch('/api/assistant', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
    });

    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
        // Pre-stream rejection (auth/rate/budget/unavailable) — same error shape
        // as the non-streaming path, delivered in-band.
        handlers.onError?.(await parseAssistantStreamError(response));
        return;
    }

    if (!contentType.includes('text/event-stream')) {
        // Server returned a plain JSON ChatMessageResponse (no SSE support).
        try {
            const raw: unknown = await response.json();
            const parsed = ChatMessageResponseSchema.safeParse(raw);
            handlers.onDone?.(parsed.success ? parsed.data : (raw as ChatMessageResponse));
        } catch {
            handlers.onError?.({ message: 'Malformed response', status: response.status });
        }
        return;
    }

    if (!response.body) {
        handlers.onError?.({ message: 'No response body', status: response.status });
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Frames are delimited by a blank line (\n\n). A frame may straddle
            // chunk boundaries, so we only dispatch complete frames.
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (frame.trim() !== '') dispatchAssistantFrame(frame, handlers);
                boundary = buffer.indexOf('\n\n');
            }
        }
        // Flush the decoder and dispatch any trailing frame lacking a final \n\n.
        buffer += decoder.decode();
        if (buffer.trim() !== '') dispatchAssistantFrame(buffer, handlers);
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // reader already released / stream torn down — nothing to do.
        }
    }
}

// =========================================================================
// Admin AI Endpoints
// =========================================================================

export function getAiUsers() {
    return apiGet('/api/ai/users', AiUsersResponseSchema);
}

export function clearUserAiData(userId: string) {
    return apiDelete(`/api/ai/clear-user/${userId}`, ClearUserAiDataResponseSchema);
}

export function getEmbeddingStats() {
    return apiGet('/api/ai/check-embeddings', EmbeddingOverviewStatsSchema);
}

export function getVideoEmbeddingStats() {
    return apiGet('/api/ai/check-embeddings/video', VideoEmbeddingStatsSchema);
}

export function getMusicEmbeddingStats() {
    return apiGet('/api/ai/check-embeddings/music', MusicEmbeddingStatsSchema);
}

export function getEmbeddingPreviews() {
    return apiGet('/api/ai/embedding-preview', EmbeddingPreviewsResponseSchema);
}

export function lookupEmbedding(key: string) {
    return apiGet('/api/ai/lookup-embedding', LookupEmbeddingResponseSchema, {
        params: { key },
    });
}

export function searchEmbeddings(q: string, type?: string) {
    return apiGet('/api/ai/search-embeddings', EmbeddingSearchResponseSchema, {
        params: { q, type },
    });
}

export function getMdblistStatus() {
    return apiGet('/api/ai/mdblist-status', MdblistStatusResponseSchema);
}

// Schema for sync-mdblist ?status=true response — mirrors SyncStatusSchema in +server.ts
const SyncMdblistSampleSchema = z.object({
    tmdb_id: z.number(),
    title: z.string(),
    media_type: z.string(),
    year: z.number().nullable(),
    mdblist_score: z.number().nullable(),
    imdb_rating: z.number().nullable(),
    letterboxd_rating: z.number().nullable(),
    letterboxd_votes: z.number().nullable(),
    metacritic_score: z.number().nullable(),
    rt_rating: z.number().nullable(),
    rt_audience_score: z.number().nullable(),
    trakt_score: z.number().nullable(),
    mal_score: z.number().nullable(),
    mal_votes: z.number().nullable(),
    streaming_services: z.array(z.string()).nullable(),
    anime_genres: z.array(z.string()).nullable(),
    mdblist_keywords: z.array(z.string()).nullable(),
});

const SyncMdblistStatusResponseSchema = z.object({
    apiConfigured: z.boolean(),
    total_items: z.number(),
    with_mdblist: z.number(),
    without_mdblist: z.number(),
    stale_data: z.number(),
    coverage_percent: z.number(),
    movies_without: z.number(),
    tv_without: z.number(),
    samples: z.array(SyncMdblistSampleSchema).optional(),
});

export function getSyncMdblistStatus() {
    return apiGet('/api/ai/sync-mdblist', SyncMdblistStatusResponseSchema, {
        params: { status: true },
    });
}

export function getWatchHistoryCount() {
    return apiGet('/api/ai/watch-history-count', WatchHistoryCountResponseSchema);
}

export function getEmbeddingText(id: string) {
    return apiGet(`/api/ai/embedding-text/${id}`, EmbeddingTextResponseSchema);
}
