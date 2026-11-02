// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Next-episode subtitle prefetch.
 *
 * The first request for an embedded subtitle track makes FFmpeg read the whole
 * container (subtitle packets are interleaved through the file), which took
 * 4-7 s on prod at nearly every episode start while someone was binge-watching.
 * When a subtitle is served for an episode, this resolves the MATCHING track of
 * the next episode in the background, so its caches are warm by the time the
 * viewer gets there. Both tiers the resolver fills are useful: the disk tier
 * (`.cache/subtitles`, shared by every replica) and this replica's memory LRU.
 *
 * Deliberately modest: it starts after a delay (so it never competes with the
 * current episode's start-up reads), runs one extraction per process at a
 * time and drops the rest, and remembers what it already warmed.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { isExternalSubtitleStreamIndex } from '$lib/server/utils/external-subtitle-index.js';
import { getNextEpisodeWithFile } from '$lib/server/database/queries/media-hierarchy.queries.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    getStreamsForFile,
    type MediaStreamRow,
} from '$lib/server/database/queries/media-streams.queries.js';
import {
    isBitmapSubtitle,
    resolveSubtitle,
    type ResolveSubtitleOptions,
} from './subtitle-resolver.service.js';

const logger = Logger.for('SubtitlePrefetch');

const PREFETCH_DELAY_MS = 30_000;
const RECENT_TTL_MS = 6 * 60 * 60 * 1000;
const RECENT_MAX = 500;

/** Keys warmed (or being warmed) recently: `${fileId}:${streamIndex}:${format}`. */
const recent = new Map<string, number>();
let running = false;

export interface SubtitlePrefetchRequest {
    /** The episode whose subtitle was just served. */
    mediaItemId: string;
    /** The file it was served from, when the client named one. */
    fileId: string | null | undefined;
    streamIndex: number;
    format: NonNullable<ResolveSubtitleOptions['format']>;
}

export interface SubtitlePrefetchDeps {
    delayMs?: number;
    resolve?: typeof resolveSubtitle;
}

function isBitmap(stream: MediaStreamRow): boolean {
    return stream.is_text_subtitle !== true && isBitmapSubtitle(stream.codec);
}

/**
 * Pick the next episode's counterpart of `current`: same language, forced and
 * SDH flags, and the same text/bitmap kind (the client asked for a format that
 * only fits one kind). Prefers the same codec, then the same title, then the
 * closest stream index. Null when nothing matches — guessing a different
 * language would warm a track nobody asked for.
 */
export function pickMatchingSubtitleStream(
    current: MediaStreamRow,
    candidates: MediaStreamRow[],
): MediaStreamRow | null {
    const lang = (s: MediaStreamRow): string => (s.language ?? '').toLowerCase();
    const matches = candidates.filter(
        (s) =>
            s.stream_type === 'subtitle' &&
            lang(s) === lang(current) &&
            s.is_forced === current.is_forced &&
            s.is_hearing_impaired === current.is_hearing_impaired &&
            isBitmap(s) === isBitmap(current),
    );
    if (matches.length === 0) return null;
    const score = (s: MediaStreamRow): [number, number, number] => [
        s.codec === current.codec ? 0 : 1,
        (s.title ?? '') === (current.title ?? '') ? 0 : 1,
        Math.abs(s.stream_index - current.stream_index),
    ];
    return [...matches].sort((a, b) => {
        const [a1, a2, a3] = score(a);
        const [b1, b2, b3] = score(b);
        return a1 - b1 || a2 - b2 || a3 - b3;
    })[0];
}

function remember(key: string): boolean {
    const now = Date.now();
    const seen = recent.get(key);
    if (seen !== undefined && now - seen < RECENT_TTL_MS) return false;
    recent.set(key, now);
    if (recent.size > RECENT_MAX) {
        // Map iterates in insertion order: drop the oldest entry.
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
    }
    return true;
}

async function prefetch(
    sql: postgres.Sql,
    req: SubtitlePrefetchRequest,
    deps: SubtitlePrefetchDeps,
): Promise<void> {
    // Pseudo-indices >= 1000 are external sidecar files: already cheap to read.
    if (isExternalSubtitleStreamIndex(req.streamIndex)) return;

    const currentFileId =
        req.fileId ?? (await resolvePlaybackSelection(sql, req.mediaItemId)).fileId;
    if (!currentFileId) return;
    const current = (await getStreamsForFile(sql, currentFileId)).find(
        (s) => s.stream_type === 'subtitle' && s.stream_index === req.streamIndex,
    );
    if (!current) return;

    const next = await getNextEpisodeWithFile(sql, req.mediaItemId);
    if (!next) return;
    const nextFileId = (await resolvePlaybackSelection(sql, next.id)).fileId;
    if (!nextFileId) return;
    const match = pickMatchingSubtitleStream(current, await getStreamsForFile(sql, nextFileId));
    if (!match) return;

    const key = `${nextFileId}:${match.stream_index}:${req.format}`;
    if (!remember(key)) return;

    await new Promise((r) => setTimeout(r, deps.delayMs ?? PREFETCH_DELAY_MS));
    if (running) {
        recent.delete(key); // not warmed — let a later request try again
        return;
    }
    running = true;
    const started = Date.now();
    let warmed = false;
    try {
        const result = await (deps.resolve ?? resolveSubtitle)(sql, next.id, match.stream_index, {
            fileId: nextFileId,
            format: req.format,
        });
        warmed = result !== null;
        logger.info('Prefetched next-episode subtitle', {
            episodeId: next.id,
            streamIndex: match.stream_index,
            format: req.format,
            ok: result !== null,
            ms: Date.now() - started,
        });
    } finally {
        running = false;
        // Nothing was cached: let a later request try again instead of
        // remembering the key for RECENT_TTL_MS.
        if (!warmed) recent.delete(key);
    }
}

/**
 * Fire-and-forget: warm the next episode's matching subtitle track. Never
 * throws and never delays the caller.
 */
export function prefetchNextEpisodeSubtitle(
    sql: postgres.Sql,
    req: SubtitlePrefetchRequest,
    deps: SubtitlePrefetchDeps = {},
): Promise<void> {
    return prefetch(sql, req, deps).catch((err: unknown) => {
        logger.warn('Next-episode subtitle prefetch failed', {
            mediaItemId: req.mediaItemId,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

/** Test hook. */
export function resetSubtitlePrefetchState(): void {
    recent.clear();
    running = false;
}
