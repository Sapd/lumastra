// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sync the OIDC provider's `picture` claim into the user's IdP avatar.
 *
 * Runs after an OIDC sign-in, off the login path. The picture is fetched (or
 * decoded, for a `data:` URI), validated as JPEG/PNG/WebP/GIF, re-encoded to
 * the same 200x200 WebP as an upload, and stored in `users.idp_avatar_*`.
 * Browsers then load it from us like any other avatar — never from the IdP or
 * Gravatar.
 *
 * The uploaded avatar (`users.avatar_data`) is never touched; the serve chain
 * puts it first.
 *
 * Fetch rules:
 *   - https only (http too when AUTH_OIDC_ALLOW_INSECURE is on);
 *   - the issuer's own origin may be a private address (self-hosted IdPs on a
 *     LAN are the normal case, and the admin configured that host already),
 *     but only while the chain never left it; every other hop must resolve
 *     to public addresses; http hops are pinned to the vetted IP;
 *   - URLs carrying credentials are refused;
 *   - redirects are followed by hand, each hop re-checked; no credentials sent;
 *   - 2 MB body cap, 5 s per hop, 16 MP decode cap, 2 syncs at once;
 *   - an unreachable picture is not retried for an hour (per process).
 *
 * SVG is refused in every form: it is a document that can carry script.
 */

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { resolveSafePublicUrl, pinnedFetch, type SafeUrl } from '$lib/server/utils/ssrf-guard.js';
import { isAllowedAvatarImage, processAvatarImage } from '$lib/server/utils/avatar-image.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';
import {
    getUserIdpAvatarState,
    setUserIdpAvatar,
    touchUserIdpAvatar,
} from '$lib/server/database/queries/users.queries.js';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';

const logger = Logger.for('IdpAvatarSync');

/** Largest picture we accept, raw bytes (same cap as an upload). */
export const IDP_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** An unchanged picture is refetched after this long (a Gravatar URL never changes). */
export const IDP_AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_HOPS = 3;

/** The picture can never be used as it is; retrying the same claim will not help. */
export class IdpAvatarRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IdpAvatarRejectedError';
    }
}

export type IdpAvatarSyncOutcome =
    'disabled' | 'unchanged' | 'stored' | 'cleared' | 'rejected' | 'unavailable';

/** Raster types allowed in a `data:` URI. Everything else (SVG first) is refused. */
const DATA_URI_RE =
    /^data:image\/(?:png|jpeg|jpg|webp|gif)(?:;[a-z0-9=._-]+)*;base64,([a-z0-9+/=\s]+)$/i;

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function decodeDataUri(picture: string): Buffer {
    const match = DATA_URI_RE.exec(picture);
    if (!match) {
        throw new IdpAvatarRejectedError('data: URI is not a base64 PNG/JPEG/WebP/GIF');
    }
    const bytes = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    if (bytes.length > IDP_AVATAR_MAX_BYTES) {
        throw new IdpAvatarRejectedError('data: URI exceeds the size cap');
    }
    return bytes;
}

async function readCapped(res: Response): Promise<Buffer> {
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > IDP_AVATAR_MAX_BYTES) {
        await res.body?.cancel();
        throw new IdpAvatarRejectedError('picture exceeds the size cap');
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > IDP_AVATAR_MAX_BYTES) {
            await reader.cancel();
            throw new IdpAvatarRejectedError('picture exceeds the size cap');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

function assertFetchableProtocol(url: URL): void {
    if (url.protocol === 'https:') return;
    if (url.protocol === 'http:' && config.AUTH_OIDC_ALLOW_INSECURE) return;
    throw new IdpAvatarRejectedError(`picture URL protocol not allowed: ${url.protocol}`);
}

async function fetchPicture(picture: string, issuer: string): Promise<Buffer> {
    let current: URL;
    let issuerOrigin: string | null;
    try {
        current = new URL(picture);
    } catch {
        throw new IdpAvatarRejectedError('picture is neither a URL nor a data: URI');
    }
    try {
        issuerOrigin = new URL(issuer).origin;
    } catch {
        issuerOrigin = null;
    }
    // The private-address allowance holds only while the whole chain stays on
    // the issuer's origin. A public host redirecting INTO the issuer origin
    // gets no allowance: otherwise any picture URL could reach any path on an
    // internal issuer host.
    let onIssuerChain = issuerOrigin !== null && current.origin === issuerOrigin;

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        assertFetchableProtocol(current);
        if (current.username || current.password) {
            throw new IdpAvatarRejectedError('picture URL carries credentials');
        }
        onIssuerChain = onIssuerChain && current.origin === issuerOrigin;

        // Resolved and pinned to the vetted IP on every hop; only an unbroken
        // issuer-origin chain may resolve to a private address.
        let target: SafeUrl;
        try {
            target = await resolveSafePublicUrl(current, { allowPrivate: onIssuerChain });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('private IP')) {
                throw new IdpAvatarRejectedError('picture URL resolves to a private address');
            }
            throw error; // DNS failure: transient
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            // Its own per-hop guard (ssrf-guard.ts family): every hop above is
            // re-checked, redirects are never followed by fetch itself, and no
            // credentials are sent.
            const res = await pinnedFetch(target, {
                headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
                redirect: 'manual',
                credentials: 'omit',
                signal: controller.signal,
            });

            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location');
                await res.body?.cancel();
                if (!location) throw new IdpAvatarRejectedError('redirect without Location');
                current = new URL(location, current);
                continue;
            }
            if (res.status === 404 || res.status === 410) {
                await res.body?.cancel();
                throw new IdpAvatarRejectedError(`picture URL answered ${res.status}`);
            }
            if (!res.ok) {
                await res.body?.cancel();
                throw new Error(`picture fetch failed: HTTP ${res.status}`);
            }
            const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
            if (contentType.includes('svg')) {
                await res.body?.cancel();
                throw new IdpAvatarRejectedError('picture is an SVG');
            }
            return await readCapped(res);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new IdpAvatarRejectedError('too many redirects');
}

/** Bytes of the picture, from a `data:` URI or a guarded fetch. */
export async function loadIdpPicture(picture: string, issuer: string): Promise<Buffer> {
    if (picture.length > IDP_AVATAR_MAX_BYTES * 2) {
        throw new IdpAvatarRejectedError('picture claim is too long');
    }
    if (/^data:/i.test(picture)) return decodeDataUri(picture);
    return await fetchPicture(picture, issuer);
}

/** At most this many pictures are fetched and decoded at once, per process. */
const syncSlots = new AsyncSemaphore(2);

/**
 * Pictures that could not be reached, per user: not retried for an hour, so a
 * dead host does not cost up to four 5 s hops on every sign-in. In-process
 * only — another replica may retry once, which is fine.
 */
const TRANSIENT_BACKOFF_MS = 60 * 60 * 1000;
const TRANSIENT_BACKOFF_MAX = 1_000;
const transientFailures = new Map<string, { source: string; until: number }>();

function inTransientBackoff(userId: string, source: string): boolean {
    const entry = transientFailures.get(userId);
    if (!entry) return false;
    if (entry.source === source && entry.until > Date.now()) return true;
    transientFailures.delete(userId);
    return false;
}

function recordTransientFailure(userId: string, source: string): void {
    if (transientFailures.size >= TRANSIENT_BACKOFF_MAX) {
        const oldest = transientFailures.keys().next().value;
        if (oldest !== undefined) transientFailures.delete(oldest);
    }
    transientFailures.set(userId, { source, until: Date.now() + TRANSIENT_BACKOFF_MS });
}

/** One sync per user at a time in this process; a second login joins the first. */
const inFlight = new Map<string, Promise<IdpAvatarSyncOutcome>>();

/** Test-only: forget backoff and in-flight entries. */
export function _resetIdpAvatarSyncStateForTests(): void {
    transientFailures.clear();
    inFlight.clear();
}

/**
 * Bring the stored IdP avatar in line with `picture`. Never throws: a failure
 * to reach the picture keeps whatever was stored, and is only logged.
 */
export async function syncIdpAvatar(
    sql: postgres.Sql,
    params: { userId: string; username: string; picture: string | null; issuer: string },
): Promise<IdpAvatarSyncOutcome> {
    if (!config.AUTH_OIDC_SYNC_AVATAR) return 'disabled';
    const running = inFlight.get(params.userId);
    if (running) return await running;
    const promise = runSync(sql, params).finally(() => inFlight.delete(params.userId));
    inFlight.set(params.userId, promise);
    return await promise;
}

async function runSync(
    sql: postgres.Sql,
    params: { userId: string; username: string; picture: string | null; issuer: string },
): Promise<IdpAvatarSyncOutcome> {
    const { userId, username, picture, issuer } = params;
    let source: string | null = null;

    try {
        const state = await getUserIdpAvatarState(sql, userId);
        if (!state) return 'unchanged';

        if (!picture) {
            if (state.source === null) return 'unchanged';
            const cleared = await setUserIdpAvatar(sql, userId, state.source, {
                data: null,
                contentType: null,
                source: null,
            });
            if (cleared && state.hasData) {
                await getImageProxyService().invalidateAvatarCache(username);
            }
            return cleared ? 'cleared' : 'unchanged';
        }

        source = sha256(picture);
        const fresh =
            state.updatedAt !== null &&
            Date.now() - state.updatedAt.getTime() < IDP_AVATAR_REFRESH_MS;
        if (state.source === source && fresh) return 'unchanged';
        if (inTransientBackoff(userId, source)) return 'unavailable';

        let processed: Buffer;
        try {
            processed = await syncSlots.withPermit(async () => {
                const raw = await loadIdpPicture(picture, issuer);
                if (!isAllowedAvatarImage(raw)) {
                    throw new IdpAvatarRejectedError('picture is not a JPEG, PNG, WebP or GIF');
                }
                try {
                    // 16 MP is plenty for a 200 px square and bounds the decode
                    // (~64 MB RGBA) for bytes we did not choose.
                    return await processAvatarImage(raw, { maxInputPixels: 16_000_000 });
                } catch {
                    throw new IdpAvatarRejectedError('picture could not be decoded');
                }
            });
        } catch (error) {
            if (!(error instanceof IdpAvatarRejectedError)) throw error;
            logger.info('IdP avatar rejected', { username, reason: error.message });
            if (state.source === source && state.hasData) {
                // The same picture we already hold now fails (expired signed
                // URL, a brief 404): keep the copy, retry after the window.
                await touchUserIdpAvatar(sql, userId, source);
                return 'rejected';
            }
            // Recorded with its source so the same picture is not refetched on
            // every sign-in; a changed claim (or the refresh window) retries.
            const written = await setUserIdpAvatar(sql, userId, state.source, {
                data: null,
                contentType: null,
                source,
            });
            if (written && state.hasData) {
                await getImageProxyService().invalidateAvatarCache(username);
            }
            return 'rejected';
        }

        // Compare-and-set on the source we read: a concurrent sync on another
        // replica that already wrote a newer picture is not overwritten.
        const written = await setUserIdpAvatar(sql, userId, state.source, {
            data: processed,
            contentType: 'image/webp',
            source,
        });
        if (!written) return 'unchanged';
        await getImageProxyService().invalidateAvatarCache(username);
        logger.info('IdP avatar stored', { username, size: processed.length });
        return 'stored';
    } catch (error) {
        if (source !== null) recordTransientFailure(userId, source);
        logger.warn('IdP avatar sync failed; keeping the stored copy', {
            username,
            error: error instanceof Error ? error.message : String(error),
        });
        return 'unavailable';
    }
}
