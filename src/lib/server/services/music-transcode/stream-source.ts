// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Per-request lookups for the music stream route, cached across the burst of
// ranged requests AVFoundation sends to start one track.
//
// A track start is a `bytes=0-1` probe followed by several more ranged GETs
// (and sometimes a HEAD), all within a second or two. Each one used to repeat
// the track lookup, the library/age access check and the path resolution
// (stat + access calls) before its first byte. None of that changes between
// requests of one burst, so it is remembered briefly.

import type postgres from 'postgres';
import { stat } from 'node:fs/promises';
import { getTrackStreamSource } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import type { UserContext } from '$lib/server/types';
import { probeAudioSource } from './index.js';
import type { SourceMetadata } from './decision.js';

/**
 * Long enough to cover one track start, short enough that a revoked library
 * grant or a replaced file is picked up almost at once. Only SUCCESSFUL
 * resolutions are cached: a 404 or a denial is always re-checked, so nothing
 * here can keep a user locked out.
 */
export const STREAM_SOURCE_TTL_MS = 15_000;
const STREAM_SOURCE_MAX_ENTRIES = 1_000;

/** Source metadata depends only on the file, so it can live longer. */
const PROBE_TTL_MS = 10 * 60_000;
const PROBE_MAX_ENTRIES = 1_000;

export type StreamSource =
    | {
          kind: 'ok';
          trackId: string;
          containerPath: string;
          fileSize: number;
          mtimeMs: number;
          durationSeconds?: number;
      }
    /** Unknown track, access denied, or no file — all 404 to the caller. */
    | { kind: 'not_found'; reason: 'track' | 'access' | 'no_file_path' }
    /** The file is known but can't be served right now. */
    | { kind: 'unavailable'; reason: string };

export type OkSource = Extract<StreamSource, { kind: 'ok' }>;

interface Entry<T> {
    value: T;
    expiresAt: number;
}

/** Insertion-ordered Map; the oldest entry goes first once it is full. */
class TtlCache<T> {
    private readonly entries = new Map<string, Entry<T>>();

    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries: number,
    ) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        if (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }
}

const sourceCache = new TtlCache<OkSource>(STREAM_SOURCE_TTL_MS, STREAM_SOURCE_MAX_ENTRIES);
const probeCache = new TtlCache<Promise<SourceMetadata>>(PROBE_TTL_MS, PROBE_MAX_ENTRIES);
/** Lookups under way, so concurrent requests of one burst share a single one. */
const inflight = new Map<string, Promise<StreamSource>>();

/**
 * Track lookup + access check + path resolution for one user and track.
 *
 * Keyed by user id AND track id: the access half of the answer belongs to
 * this user only and is never served to anyone else.
 */
export async function resolveStreamSource(
    sql: postgres.Sql,
    trackId: string,
    user: UserContext,
): Promise<StreamSource> {
    const key = `${user.userId}|${trackId}`;
    const cached = sourceCache.get(key);
    if (cached) {
        // One stat, so a file replaced within the TTL is never served with
        // the old size: Content-Length/Content-Range and the direct-play size
        // guard all read `fileSize`.
        const current = await stat(cached.containerPath).catch(() => null);
        if (current && current.size === cached.fileSize && current.mtimeMs === cached.mtimeMs) {
            return cached;
        }
        sourceCache.delete(key);
    }

    const pending = inflight.get(key);
    if (pending) return pending;
    const lookup = lookupStreamSource(sql, trackId, user).finally(() => inflight.delete(key));
    inflight.set(key, lookup);
    const source = await lookup;
    if (source.kind === 'ok') sourceCache.set(key, source);
    return source;
}

async function lookupStreamSource(
    sql: postgres.Sql,
    trackId: string,
    user: UserContext,
): Promise<StreamSource> {
    const track = await getTrackStreamSource(sql, trackId);
    if (!track) return { kind: 'not_found', reason: 'track' };

    // Library + age gate (NOT library-only): an age-restricted account must
    // not be able to stream a track it can't browse. 404, not 403, so a
    // restricted track's existence doesn't leak. fileBacked: the row came from
    // the music track table and delivery is bound to its file, so the
    // remote-audiobook retirement lookup can never apply here.
    if (!(await checkMediaAccess(sql, track.id, user, { fileBacked: true }))) {
        return { kind: 'not_found', reason: 'access' };
    }

    if (!track.file_path) return { kind: 'not_found', reason: 'no_file_path' };

    const pathInfo = await resolveMediaPath(track.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) {
        return { kind: 'unavailable', reason: pathInfo?.reason ?? 'unknown' };
    }
    if (!pathInfo.fileSize) return { kind: 'unavailable', reason: 'file size unavailable' };

    // mtime is what later cache hits compare against (see above).
    const stats = await stat(pathInfo.containerPath).catch(() => null);
    if (!stats) return { kind: 'unavailable', reason: 'file vanished' };

    return {
        kind: 'ok',
        trackId: track.id,
        containerPath: pathInfo.containerPath,
        fileSize: stats.size,
        mtimeMs: stats.mtimeMs,
        durationSeconds: track.duration_seconds ?? undefined,
    };
}

/**
 * `probeAudioSource` (a sniff plus two ffprobe spawns) for a file, shared
 * across requests. Keyed by path, size AND mtime so a replaced file is
 * re-probed even when the new one happens to have the same size.
 * The in-flight promise is what gets cached, so concurrent requests share one
 * probe; a failed probe is dropped so the next request tries again.
 */
export function probeAudioSourceCached(source: OkSource): Promise<SourceMetadata> {
    const { containerPath, fileSize, mtimeMs } = source;
    const key = `${mtimeMs}|${fileSize}|${containerPath}`;
    const cached = probeCache.get(key);
    if (cached) return cached;
    const probe = probeAudioSource(containerPath);
    probeCache.set(key, probe);
    probe.catch(() => {
        if (probeCache.get(key) === probe) probeCache.delete(key);
    });
    return probe;
}

/** Test hook: forget everything. */
export function clearStreamSourceCaches(): void {
    sourceCache.clear();
    probeCache.clear();
    inflight.clear();
}
