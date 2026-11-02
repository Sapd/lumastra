// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobooks API domain module — the `/audiobooks` destination's reads.
 */

import { base } from '$app/paths';
import { apiGet } from './client.js';
import { AudiobookBrowseResponseSchema } from '$lib/schemas/api-audiobooks-responses';
import type { AudiobookSortValue } from '$lib/schemas/api-audiobooks-responses';
import type {
    AudiobookProgressAck,
    OpenAudiobookSessionRequest,
} from '$lib/schemas/api-audiobook-session';
import type {
    AudiobookPlayerDeps,
    AudiobookProgressReport,
    AudiobookSessionPayload,
} from '$lib/stores/audiobook-player.store';

import { startPlaySession } from './playback.js';
import { getMediaDetails } from './content.js';
import type { ApiRequestOptions } from './types.js';
import { ContributorDetailSchema } from '$lib/schemas/api-audiobook';
import { AudiobookPageSchema, SeriesDetailSchema } from '$lib/schemas/api-audiobook-preview';
import { AudiobookFacetsSchema } from '$lib/schemas/api-audiobooks-responses';

const SESSION_MUTATION_TIMEOUT_MS = 5_000;

export interface AudiobookBrowseParams {
    libraryGroupId?: string;
    lang?: string;
    authorId?: string;
    narratorId?: string;
    seriesId?: string;
    collapse?: 'series';
    q?: string;
    letter?: string;
    sort?: 'title' | 'added' | 'year' | 'series';
    order?: 'asc' | 'desc';
    offset?: number;
    limit?: number;
}

/** Translate the destination's sort control into the catalog's sort/order pair. */
export function audiobookSortParams(value: AudiobookSortValue) {
    return {
        sort: value === 'series_sequence' ? 'series' : value.split('_')[0],
        order: value.endsWith('_desc') ? 'desc' : 'asc',
    } as const;
}

export function getAudiobookBrowse(
    params: AudiobookBrowseParams = {},
    options?: ApiRequestOptions,
) {
    return apiGet('/api/audiobooks', AudiobookBrowseResponseSchema, {
        ...options,
        params: { ...params },
    });
}

export function getAudiobookFacets(
    params: AudiobookBrowseParams = {},
    options?: ApiRequestOptions,
) {
    const { q, authorId, narratorId, seriesId, libraryGroupId, lang, collapse } = params;
    return apiGet('/api/audiobooks/facets', AudiobookFacetsSchema, {
        ...options,
        params: { q, authorId, narratorId, seriesId, libraryGroupId, lang, collapse },
    });
}

export type AudiobookResource = 'authors' | 'narrators' | 'series';

export function getAudiobookResource(
    kind: AudiobookResource,
    id: string,
    options?: ApiRequestOptions,
) {
    const path = `/api/audiobooks/${kind}/${encodeURIComponent(id)}`;
    return kind === 'series'
        ? apiGet(path, SeriesDetailSchema, options)
        : apiGet(path, ContributorDetailSchema, options);
}

export function getAudiobookResourceBooks(
    kind: AudiobookResource,
    id: string,
    offset = 0,
    options?: ApiRequestOptions,
) {
    return apiGet(`/api/audiobooks/${kind}/${encodeURIComponent(id)}/books`, AudiobookPageSchema, {
        ...options,
        params: { offset, limit: 60 },
    });
}

// ---------------------------------------------------------------------------
// Playback session transport
// ---------------------------------------------------------------------------

/**
 * The player store's injected transport, wired to the real endpoints.
 *
 * `openSession` awaits a 201 whose write side has already committed the
 * `play_sessions` row the byte proxy validates — that ordering is the server's
 * to keep (`services/audiobook-session.service.ts`), and this function's only
 * job is not to resolve before the response arrives. Do not "optimise" it into
 * a fire-and-forget or an optimistic payload: ABS serves `/hls/:sid/*` with no
 * authentication of its own, so that row is the only thing pinning a session id
 * to this user and this book, and a segment requested before it exists is a
 * hard 404.
 */
export const audiobookSessionTransport: AudiobookPlayerDeps = {
    async openSession(input: OpenAudiobookSessionRequest): Promise<AudiobookSessionPayload> {
        const result = await startPlaySession({
            mediaId: input.mediaId,
            deviceId: input.deviceId,
            capabilities: {
                containers: input.supportedMimeTypes ?? ['audio/mpeg', 'audio/mp4'],
                videoCodecs: [],
                audioCodecs: ['mp3', 'aac', 'flac', 'opus'],
                subtitleFormats: [],
                hdr: [],
            },
            startPositionMs: input.positionMs,
            requestedMethod: input.requestedMethod,
            audio: input.purpose === 'download' ? { download: true } : undefined,
        });
        if (!result.data) {
            // Carries the problem+json code so the store can tell "no ABS link"
            // (forbidden, permanent) from "ABS is down" (retryable) rather than
            // showing one generic failure for both.
            throw new AudiobookSessionError(
                result.error ?? 'Could not open the audiobook session',
                result.status,
                result.code,
            );
        }
        const start = result.data;
        const delivery = start.delivery;
        if (delivery.kind !== 'multipart-audio') throw new Error('Expected audiobook delivery');
        const details = await getMediaDetails(input.mediaId);
        return {
            playbackSessionId: start.playbackSessionId,
            mediaId: start.mediaId,
            start,
            playMethod:
                delivery.tracks[0]?.mime === 'application/vnd.apple.mpegurl'
                    ? 'transcode'
                    : 'direct',
            tracks: delivery.tracks.map((track) => ({
                ...track,
                mimeType: track.mime,
            })),
            chapters: delivery.chapters.map((chapter) => ({
                id: chapter.index,
                title: chapter.name,
                startMs: chapter.startMs,
                durationMs: chapter.endMs - chapter.startMs,
            })),
            startPositionMs: delivery.startPositionMs,
            durationMs: delivery.durationMs ?? undefined,
            book: delivery.book ?? { title: details.data?.title ?? input.mediaId, images: {} },
        };
    },

    /**
     * Sent with `keepalive`, and NOT through `apiPost`.
     *
     * The store flushes a final report on `pagehide`. A plain `fetch` is aborted
     * when the document is destroyed, so exactly the report the flush handler
     * exists for — the tab-close one — never left the browser, silently losing up
     * to a full reporting interval of progress. `keepalive` is what makes the
     * request outlive the page; the body is a handful of integers, far under the
     * 64 KiB keepalive limit.
     */
    async reportProgress(report: AudiobookProgressReport): Promise<AudiobookProgressAck> {
        return sendReport(report, report.status ?? 'ACTIVE');
    },
    async heartbeat(input): Promise<AudiobookProgressAck> {
        return sendReport({ ...input, listenedMs: 0 }, input.status);
    },
    async closeSession(report: AudiobookProgressReport): Promise<AudiobookProgressAck> {
        return sendReport(report, 'COMPLETED');
    },
};

const SESSION_GONE: AudiobookProgressAck = { synced: false, sessionLost: true };

/**
 * `AbortSignal.timeout` is Safari 16+. Constructing it on Safari 15 throws, and
 * because that construction sits inside the request's try/catch it would degrade
 * to "transport failure" on EVERY progress report and close — silently, for the
 * whole book. A manual controller works everywhere.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const pendingListenedMs = new Map<string, number>();
const sessionElapsed = new Map<string, number>();
async function sendReport(
    report: AudiobookProgressReport,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
): Promise<AudiobookProgressAck> {
    const id = report.playbackSessionId;
    sessionElapsed.set(
        id,
        (sessionElapsed.get(id) ?? 0) + Math.max(0, Math.round(report.listenedMs)),
    );
    const listenedMs = report.listenedMs + (pendingListenedMs.get(id) ?? 0);
    pendingListenedMs.delete(id);
    const ack = await sendReportOnce({ ...report, listenedMs }, status);
    if (!ack.synced && !ack.sessionLost && !ack.superseded) pendingListenedMs.set(id, listenedMs);
    if (status === 'COMPLETED' || ack.sessionLost || ack.superseded) {
        eventSequences.delete(id);
        sessionElapsed.delete(id);
    }
    if (ack.sessionLost || ack.superseded || (status === 'COMPLETED' && ack.synced)) {
        pendingListenedMs.delete(id);
    }
    return ack;
}

async function sendReportOnce(
    report: AudiobookProgressReport,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
): Promise<AudiobookProgressAck> {
    const url = `${base}/api/play-sessions/${encodeURIComponent(report.playbackSessionId)}`;
    // The player serializes reports, heartbeats and close. Aborting the actual
    // request bounds a book switch without allowing a timed-out mutation to land
    // after the queue has advanced.
    const timeout = timeoutSignal(SESSION_MUTATION_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toReportBody(report, status)),
            keepalive: true,
            signal: timeout.signal,
        });
    } catch {
        // A transport failure is not evidence the session is gone; the store must
        // keep playing and keep trying.
        return { synced: false };
    } finally {
        timeout.done();
    }
    // 404 means no live session of ours matched — the row was closed or reaped.
    // That IS "the session is gone", and it is what makes the store reopen one
    // instead of syncing into a void every 15 s for the rest of the book.
    if (response.status === 404 || response.status === 410) return SESSION_GONE;
    if (!response.ok) return { synced: false };

    if (response.status === 204) return { synced: true };
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') return { synced: true };
    if (body.action === 'kill') return SESSION_GONE;
    return {
        synced: body.synced !== false && !body.sessionLost,
        sessionLost: body.sessionLost === true,
        superseded: body.action === 'superseded',
    };
}

/**
 * `playbackSessionId` travels in the PATH, so it is stripped from the body.
 *
 * Leaving it in would be harmless today (the request schema strips unknown
 * fields) but would create two statements of the same id in one request, and
 * the server reads only one of them.
 */
const eventSequences = new Map<string, number>();
function toReportBody(
    report: AudiobookProgressReport,
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED',
): Record<string, unknown> {
    const eventSeq = (eventSequences.get(report.playbackSessionId) ?? 0) + 1;
    eventSequences.set(report.playbackSessionId, eventSeq);
    return {
        positionMs: Math.max(0, Math.round(report.bookPositionMs)),
        listenedDeltaMs: Math.max(0, Math.round(report.listenedMs)),
        sessionElapsedMs: sessionElapsed.get(report.playbackSessionId) ?? 0,
        finished: report.isFinished === true,
        status,
        eventSeq,
    };
}

export class AudiobookSessionError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
    ) {
        super(message);
        this.name = 'AudiobookSessionError';
    }
}
