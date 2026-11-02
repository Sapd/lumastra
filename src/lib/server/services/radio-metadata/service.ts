// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { Logger } from '$lib/server/utils/logger';
import {
    type RadioMetadataSource,
    type RadioNowPlaying,
    type RadioNowPlayingCacheRecord,
    type FlatFields,
} from './types';
import { parseJson, parseRegex } from './parser';
import { RegexBudgetExceededError } from './regex-runner';
import { fetchMetadataUrl } from './fetcher';
import { getNowPlaying as defaultIcyFetch } from '$lib/server/services/icy-metadata.service';

const logger = Logger.for('RadioMetadataService');

export interface StationInput {
    id: string;
    streamUrl: string;
    metadataSource?: RadioMetadataSource;
}

type IcyFetch = (streamUrl: string) => Promise<string | null>;
let icyFetchImpl: IcyFetch = defaultIcyFetch;

/** Test seam — swap the ICY fetcher for unit tests. */
export function __setIcyForTests(fn: IcyFetch): void {
    icyFetchImpl = fn;
}

const cache = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);

function cacheKey(stationId: string): string {
    return `station:v2:${stationId}`;
}

/**
 * Security review 2026-09-12, C7: a station whose regex blew its time budget is
 * poisoned under this key. The record carries the pattern it was recorded for,
 * so an admin editing the pattern is never held behind a stale poison.
 */
function regexPoisonKey(stationId: string): string {
    return `station:${stationId}:regex-budget`;
}

interface RegexPoison {
    pattern: string;
    message: string;
}

export async function clearRadioCache(stationId: string): Promise<void> {
    await cache.delete(cacheKey(stationId));
    await cache.delete(regexPoisonKey(stationId));
}

function emptyRecord(
    stationId: string,
    source: RadioNowPlaying['source'],
): RadioNowPlayingCacheRecord {
    return {
        stationId,
        fetchedAt: new Date().toISOString(),
        source,
        track: {},
        show: {},
        dj: {},
        upNext: {},
    };
}

function projectToNested(
    stationId: string,
    flat: FlatFields,
    source: 'url',
): RadioNowPlayingCacheRecord {
    const rec = emptyRecord(stationId, source);
    if (flat.title !== undefined) rec.track.title = String(flat.title);
    if (flat.artist !== undefined) rec.track.artist = String(flat.artist);
    if (typeof flat.trackDurationSeconds === 'number')
        rec.track.durationMs = Math.round(flat.trackDurationSeconds * 1000);
    if (typeof flat.trackElapsedSeconds === 'number')
        rec.track.elapsedMs = Math.round(flat.trackElapsedSeconds * 1000);

    if (flat.showName !== undefined) rec.show.name = String(flat.showName);
    if (flat.showDescription !== undefined) rec.show.description = String(flat.showDescription);
    if (flat.showStartsAt !== undefined) rec.show.startsAt = String(flat.showStartsAt);
    if (flat.showEndsAt !== undefined) rec.show.endsAt = String(flat.showEndsAt);

    if (flat.djName !== undefined) rec.dj.name = String(flat.djName);

    if (flat.upNextTitle !== undefined) rec.upNext.title = String(flat.upNextTitle);
    if (flat.upNextArtist !== undefined) rec.upNext.artist = String(flat.upNextArtist);

    const imageUrls: RadioNowPlayingCacheRecord['_imageUrls'] = {};
    if (flat.djImageUrl !== undefined) {
        imageUrls.dj = String(flat.djImageUrl);
        rec.dj.imageUrl = `/api/music/radio/${stationId}/image/dj`;
    }
    if (flat.showImageUrl !== undefined) {
        imageUrls.show = String(flat.showImageUrl);
        rec.show.imageUrl = `/api/music/radio/${stationId}/image/show`;
    }
    if (flat.upNextImageUrl !== undefined) {
        imageUrls.upNext = String(flat.upNextImageUrl);
        rec.upNext.imageUrl = `/api/music/radio/${stationId}/image/up-next`;
    }
    if (Object.keys(imageUrls).length > 0) rec._imageUrls = imageUrls;

    return rec;
}

function toPublic(record: RadioNowPlayingCacheRecord): RadioNowPlaying {
    const { _imageUrls, _lastError, ...pub } = record;
    return pub;
}

const FRESH_MS = 30_000;
const STALE_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 10_000;

/**
 * @param opts.poison whether this call may read and write the regex-budget
 *        poison record. The poller does; the admin preview does not, so an
 *        admin can keep iterating on a pattern (still under the time budget)
 *        without reading — or writing — shared state.
 */
async function tryUrlWithError(
    station: StationInput,
    opts: { poison: boolean },
): Promise<{ record: RadioNowPlayingCacheRecord } | { error: string } | null> {
    if (!station.metadataSource) return null;
    const src = station.metadataSource;
    const poisonable = opts.poison && src.format === 'regex' && Boolean(src.regexPattern);
    if (poisonable) {
        // Security review 2026-09-12, C7: a pattern that already blew its budget
        // against this station burns 250ms of a worker thread every poll tick and
        // cannot start succeeding on its own. Skip the fetch and the match
        // entirely until the poison expires, and keep reporting the same error.
        const poisoned = await cache.get<RegexPoison>(regexPoisonKey(station.id));
        if (poisoned && poisoned.pattern === src.regexPattern) {
            return { error: poisoned.message };
        }
    }
    try {
        const { contentType, text } = await fetchMetadataUrl(src.url, {
            timeoutMs: src.timeoutMs,
            userAgent: src.userAgent,
        });
        let flat: FlatFields = {};
        if (src.format === 'json') {
            const trimmed = text.trim();
            if (
                !contentType.includes('json') &&
                !trimmed.startsWith('{') &&
                !trimmed.startsWith('[')
            )
                throw new Error(`Not JSON (content-type ${contentType})`);
            const parsed: unknown = JSON.parse(text);
            flat = parseJson(parsed, src.jsonPaths ?? {});
        } else {
            if (!src.regexPattern) throw new Error('Regex pattern missing');
            flat = await parseRegex(text, src.regexPattern);
        }
        if (Object.keys(flat).length === 0) {
            throw new Error('No fields matched');
        }
        return { record: projectToNested(station.id, flat, 'url') };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RegexBudgetExceededError && poisonable && src.regexPattern) {
            await cache.set(
                regexPoisonKey(station.id),
                { pattern: src.regexPattern, message },
                STALE_MS,
            );
        }
        logger.warn('Radio metadata URL fetch/parse failed', {
            stationId: station.id,
            error: message,
        });
        return { error: message };
    }
}

async function tryIcyRecord(station: StationInput): Promise<RadioNowPlayingCacheRecord | null> {
    // The admin preview may run before a stream URL is entered.
    if (!station.streamUrl) return null;
    try {
        const combined = await icyFetchImpl(station.streamUrl);
        if (!combined) return null;
        const rec = emptyRecord(station.id, 'icy');
        rec.track.title = combined;
        return rec;
    } catch (err) {
        logger.warn('ICY fallback failed', {
            stationId: station.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

export async function getNowPlaying(station: StationInput): Promise<RadioNowPlaying> {
    const key = cacheKey(station.id);
    const cached = await cache.get<RadioNowPlayingCacheRecord>(key);
    const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

    // Fresh hit: serve immediately
    if (cached && age < FRESH_MS) {
        return toPublic(cached);
    }

    // Try URL
    const urlOutcome = await tryUrlWithError(station, { poison: true });
    if (urlOutcome && 'record' in urlOutcome) {
        // Success — clear any prior error
        await cache.set(key, urlOutcome.record, STALE_MS);
        return toPublic(urlOutcome.record);
    }

    const urlError = urlOutcome && 'error' in urlOutcome ? urlOutcome.error : undefined;

    // Try ICY
    const icyRecord = await tryIcyRecord(station);
    if (icyRecord) {
        if (urlError) {
            icyRecord._lastError = {
                at: new Date().toISOString(),
                message: urlError,
            };
        }
        await cache.set(key, icyRecord, STALE_MS);
        return toPublic(icyRecord);
    }

    // Both failed — try stale
    if (cached && age < STALE_MS) {
        const stale: RadioNowPlayingCacheRecord = {
            ...cached,
            source: 'stale',
            _lastError: urlError
                ? { at: new Date().toISOString(), message: urlError }
                : cached._lastError,
        };
        // Don't re-write; let the original cache entry expire naturally
        return toPublic(stale);
    }

    // Nothing to serve
    const empty = emptyRecord(station.id, null);
    if (urlError) {
        empty._lastError = {
            at: new Date().toISOString(),
            message: urlError,
        };
    }
    await cache.set(key, empty, NEGATIVE_TTL_MS);
    return toPublic(empty);
}

/**
 * Fetch + parse without touching the shared cache. Used by the admin preview
 * endpoint to evaluate in-progress mappings without affecting what other
 * users see.
 */
export async function previewNowPlaying(station: StationInput): Promise<RadioNowPlaying> {
    const urlOutcome = await tryUrlWithError(station, { poison: false });
    if (urlOutcome && 'record' in urlOutcome) {
        return toPublic(urlOutcome.record);
    }
    const urlError = urlOutcome && 'error' in urlOutcome ? urlOutcome.error : undefined;

    const icyRecord = await tryIcyRecord(station);
    if (icyRecord) {
        if (urlError) {
            icyRecord._lastError = {
                at: new Date().toISOString(),
                message: urlError,
            };
        }
        return toPublic(icyRecord);
    }

    const empty = emptyRecord(station.id, null);
    if (urlError) {
        empty._lastError = {
            at: new Date().toISOString(),
            message: urlError,
        };
    }
    return toPublic(empty);
}

export async function peekNowPlaying(station: StationInput): Promise<RadioNowPlaying | null> {
    const cached = await cache.get<RadioNowPlayingCacheRecord>(cacheKey(station.id));
    return cached ? toPublic(cached) : null;
}

export async function peekCacheRecord(
    stationId: string,
): Promise<RadioNowPlayingCacheRecord | null> {
    return (await cache.get<RadioNowPlayingCacheRecord>(cacheKey(stationId))) ?? null;
}
