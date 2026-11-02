// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ICY Metadata Service
 *
 * Parses ICY (Icecast/Shoutcast) metadata from internet radio streams
 * to extract "now playing" information.
 *
 * Protocol: Send request with `Icy-MetaData: 1` header.
 * Server responds with `icy-metaint` header indicating byte interval.
 * Every `metaint` bytes, a metadata block appears:
 *   - 1 byte: length * 16
 *   - N bytes: metadata string like "StreamTitle='Artist - Title';"
 */

import { Logger } from '$lib/server/utils/logger.js';
import { resolveSafePublicUrl, pinnedFetch, type SafeUrl } from '$lib/server/utils/ssrf-guard.js';

const logger = Logger.for('IcyMetadataService');

interface IcyNowPlaying {
    streamTitle: string | null;
    fetchedAt: number;
}

const cache = new Map<string, IcyNowPlaying>();
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_SIZE = 1000;
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Largest `icy-metaint` honoured. Real stations send 8000 or 16000; the value is
 * the number of audio bytes read before the metadata block, so an announced
 * 9999999999 meant reading until the station closed the connection.
 */
const MAX_METAINT = 65_536;

function cacheSet(key: string, value: IcyNowPlaying): void {
    if (cache.size >= CACHE_MAX_SIZE && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
            cache.delete(oldest);
        }
    }
    cache.set(key, value);
}

/**
 * Get the currently playing track from an Icecast/Shoutcast stream.
 * Results are cached for 15 seconds per stream URL.
 *
 * This function validates the stream URL against private/internal network
 * ranges before fetching. All callers are protected regardless of context.
 */
export async function getNowPlaying(streamUrl: string): Promise<string | null> {
    const cached = cache.get(streamUrl);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.streamTitle;
    }

    // One upstream read per station at a time: every listener polls this, and
    // nothing is cached until the read finishes, so a slow station would
    // otherwise collect one open reader per poll.
    const running = inFlight.get(streamUrl);
    if (running) return running;
    const started = fetchNowPlaying(streamUrl).finally(() => {
        inFlight.delete(streamUrl);
    });
    inFlight.set(streamUrl, started);
    return started;
}

async function fetchNowPlaying(streamUrl: string): Promise<string | null> {
    let safe: SafeUrl;
    try {
        safe = await resolveSafePublicUrl(new URL(streamUrl));
    } catch (err) {
        logger.warn('ICY metadata fetch blocked: URL resolves to private address', {
            streamUrl,
            error: (err as Error).message,
        });
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        // Public-only and pinned to the vetted IP in the transport (the
        // hostname stays in the URL, so vhost stations get the right Host);
        // a redirect is refused outright below, never followed.
        const response = await pinnedFetch(safe, {
            headers: { 'Icy-MetaData': '1' },
            redirect: 'manual',
            signal: controller.signal,
        });

        // Don't follow redirects — the redirect target could bypass the
        // assertNotPrivateUrl check performed above.
        if (response.status >= 300 && response.status < 400) {
            cacheSet(streamUrl, { streamTitle: null, fetchedAt: Date.now() });
            return null;
        }

        const metaint = parseInt(response.headers.get('icy-metaint') ?? '0', 10);

        if (!metaint || metaint < 0 || metaint > MAX_METAINT || !response.body) {
            void response.body?.cancel().catch(() => {});
            cacheSet(streamUrl, { streamTitle: null, fetchedAt: Date.now() });
            return null;
        }

        // The 5 s abort stays armed through the body read: a station that sends
        // headers and then stalls or drips must not hold the reader open.
        const streamTitle = await extractIcyMetadata(response.body, metaint, controller.signal);

        cacheSet(streamUrl, { streamTitle, fetchedAt: Date.now() });

        // Abort the stream — we only needed the first metadata block
        controller.abort();

        return streamTitle;
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            logger.debug('Failed to fetch ICY metadata', {
                streamUrl,
                error: (err as Error).message,
            });
        }
        cacheSet(streamUrl, { streamTitle: null, fetchedAt: Date.now() });
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

async function extractIcyMetadata(
    body: ReadableStream<Uint8Array>,
    metaint: number,
    signal: AbortSignal,
): Promise<string | null> {
    const reader = body.getReader();
    // Cancelling the reader settles a pending read(), so an aborted request ends
    // the loop even when the transport (or a mock) does not error the stream.
    const onAbort = (): void => {
        void reader.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    let bytesRead = 0;
    let metaBuffer: Uint8Array | null = null;
    let metaLength = 0;
    let metaBytesCollected = 0;

    try {
        while (bytesRead < metaint + 4096) {
            const { done, value } = await reader.read();
            if (done || !value) break;

            if (metaBuffer !== null) {
                const needed = metaLength - metaBytesCollected;
                const take = Math.min(needed, value.length);
                metaBuffer.set(value.subarray(0, take), metaBytesCollected);
                metaBytesCollected += take;

                if (metaBytesCollected >= metaLength) {
                    const metaString = new TextDecoder().decode(metaBuffer);
                    return parseStreamTitle(metaString);
                }

                continue;
            }

            const remaining = metaint - bytesRead;

            if (remaining < value.length) {
                const metaOffset = remaining;
                metaLength = value[metaOffset] * 16;
                if (metaLength === 0) return null;

                const metaStart = metaOffset + 1;
                const available = value.length - metaStart;

                if (available >= metaLength) {
                    const metaBytes = value.slice(metaStart, metaStart + metaLength);
                    const metaString = new TextDecoder().decode(metaBytes);
                    return parseStreamTitle(metaString);
                }

                metaBuffer = new Uint8Array(metaLength);
                metaBytesCollected = available;
                metaBuffer.set(value.subarray(metaStart), 0);
                continue;
            }

            bytesRead += value.length;
        }
    } finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }

    return null;
}

export function parseStreamTitle(metadata: string): string | null {
    const match = metadata.match(/StreamTitle='([^']*)'/);
    if (!match?.[1]) return null;
    const title = match[1].trim();
    return title.length > 0 ? title : null;
}

/** What a stream announces about itself in its `icy-*` response headers. */
export interface IcyStreamInfo {
    name?: string;
    genre?: string;
    description?: string;
    websiteUrl?: string;
    contentType?: string;
}

const STREAM_INFO_MAX_REDIRECTS = 3;
const STREAM_INFO_TIMEOUT_MS = 5000;
/** Field limits of the station create schema, so a prefilled form always saves. */
const STREAM_INFO_MAX_LENGTH = { name: 200, genre: 100, description: 2000, url: 2000 } as const;

/**
 * Header values arrive as one char per byte (latin-1). Most stations send
 * UTF-8, so re-decode when the bytes are valid UTF-8 and keep latin-1 otherwise.
 */
function decodeHeaderValue(raw: string | null, maxLength: number): string | undefined {
    if (!raw) return undefined;
    // eslint-disable-next-line no-control-regex -- strip control characters from a remote header
    const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!value) return undefined;
    let decoded = value;
    if (![...value].some((ch) => ch.charCodeAt(0) > 0xff)) {
        try {
            const bytes = Uint8Array.from([...value].map((ch) => ch.charCodeAt(0)));
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            // Not UTF-8: keep the latin-1 reading.
        }
    }
    return [...decoded].slice(0, maxLength).join('').trim() || undefined;
}

/** `icy-url` is free text; keep it only when it is an http(s) URL. */
function websiteUrl(raw: string | null): string | undefined {
    const value = decodeHeaderValue(raw, STREAM_INFO_MAX_LENGTH.url);
    if (!value) return undefined;
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:' ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read a stream's `icy-name` / `icy-genre` / `icy-description` / `icy-url`
 * headers, so the admin create form can prefill a new station. Only the
 * response headers are read; the body is cancelled straight away.
 *
 * Public addresses only, pinned per hop. Up to three redirects are followed
 * (stream URLs often bounce to a load balancer), each one re-checked before it
 * is fetched. Returns null when the stream cannot be reached.
 */
export async function getStreamInfo(streamUrl: string): Promise<IcyStreamInfo | null> {
    let current: URL;
    try {
        current = new URL(streamUrl);
    } catch {
        return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_INFO_TIMEOUT_MS);
    try {
        for (let hop = 0; hop <= STREAM_INFO_MAX_REDIRECTS; hop++) {
            if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
            const safe = await resolveSafePublicUrl(current);
            const response = await pinnedFetch(safe, {
                headers: { 'Icy-MetaData': '1' },
                redirect: 'manual',
                signal: controller.signal,
            });
            void response.body?.cancel().catch(() => {});
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location) return null;
                current = new URL(location, current);
                continue;
            }
            if (!response.ok) return null;
            const h = response.headers;
            const info: IcyStreamInfo = {
                name: decodeHeaderValue(h.get('icy-name'), STREAM_INFO_MAX_LENGTH.name),
                genre: decodeHeaderValue(h.get('icy-genre'), STREAM_INFO_MAX_LENGTH.genre),
                description: decodeHeaderValue(
                    h.get('icy-description'),
                    STREAM_INFO_MAX_LENGTH.description,
                ),
                websiteUrl: websiteUrl(h.get('icy-url')),
                contentType: decodeHeaderValue(h.get('content-type'), 200),
            };
            return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
        }
        return null;
    } catch (err) {
        logger.debug('Failed to read ICY stream info', {
            streamUrl,
            error: (err as Error).message,
        });
        return null;
    } finally {
        clearTimeout(timeout);
        // Only the headers were needed; make sure no stream connection lingers.
        controller.abort();
    }
}

/** Clear the ICY metadata cache for a specific stream or all streams. */
export function clearIcyCache(streamUrl?: string): void {
    if (streamUrl) {
        cache.delete(streamUrl);
    } else {
        cache.clear();
    }
}
