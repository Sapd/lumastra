// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type { ImageResponse } from './types';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';

export interface ImageCacheOptions {
    hasRevision?: boolean;
    bounded?: boolean;
    scope?: 'public' | 'private';
    /** Mutable avatar/live-image TTL override. */
    maxAge?: number;
    /** Compatibility for callers outside canonical byte routes; still requires v. */
    immutable?: boolean;
    /**
     * Use the result's own Cache-Control unchanged (plus stale-while-revalidate). For
     * surfaces whose URLs are versioned by something other than `v`, such as the /j image tags.
     */
    keepCacheControl?: boolean;
}

/** A revision alone cannot make an unbounded derivative immutable. */
export function imageCacheControl(
    options: ImageCacheOptions,
    sourceCacheControl = 'public, max-age=3600',
): string {
    if (options.keepCacheControl) {
        return sourceCacheControl.includes('stale-while-revalidate')
            ? sourceCacheControl
            : `${sourceCacheControl}, stale-while-revalidate=86400`;
    }
    const scope = options.scope ?? (sourceCacheControl.startsWith('private') ? 'private' : 'public');
    const sourceMaxAge = Number(sourceCacheControl.match(/max-age=(\d+)/)?.[1] ?? 3600);
    const immutable =
        options.hasRevision === true &&
        (options.bounded ?? options.immutable) === true &&
        sourceMaxAge > 0;
    // Without a revision the URL can show different bytes later: never longer than an hour,
    // and never longer than the source itself allows.
    const maxAge = immutable ? sourceMaxAge : Math.min(sourceMaxAge, options.maxAge ?? 3600);
    return `${scope}, max-age=${maxAge}, stale-while-revalidate=86400${immutable ? ', immutable' : ''}`;
}

/**
 * A `v` only earns `immutable` when it looks like a real revision. The constant fallbacks the
 * descriptor builders use when nothing better exists ('0', '1') and an empty value do not count.
 */
export function isRevision(v: string | null | undefined): boolean {
    return !!v && v !== '0' && v !== '1' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/** Build image responses with identical cache metadata on 200 and 304. */
export function imageResponse(
    result: ImageResponse,
    request?: Request,
    opts: ImageCacheOptions = {},
): Response {
    const etag = result.etag ?? generateETag(result.buffer);
    const hasRevision = opts.hasRevision ?? (request ? isRevision(new URL(request.url).searchParams.get('v')) : false);
    const cacheControl = imageCacheControl({ ...opts, hasRevision }, result.cacheControl);
    const scope = opts.scope ?? (result.cacheControl.startsWith('private') ? 'private' : 'public');

    // Common headers shared by 200 and 304 — browsers and CDNs need
    // Content-Type / ETag / Cache-Control / Vary on 304s so they can
    // refresh their cache metadata without re-downloading the body.
    // RFC 9110 §15.4.5: representation metadata SHOULD be sent on 304
    // when it would have been sent on the 200; some CDNs misbehave
    // when Content-Type is absent.
    const commonHeaders: Record<string, string> = {
        'Content-Type': result.contentType,
        'Cache-Control': cacheControl,
        ETag: etag,
        // - Save-Data: endpoint may downgrade size when the client opts
        //   into data-saver, so caches must partition by that header.
        // - Accept: when AVIF is enabled, the chosen format depends on
        //   `Accept: image/avif`, so a non-AVIF client must NOT receive an
        //   AVIF response from a CDN cache (and vice versa). Always set
        //   both even when this specific response wasn't differentiated,
        //   so clients toggling data-saver or upgrading browsers
        //   mid-session don't get a stale cached hit.
        Vary: scope === 'private' ? 'Accept, Save-Data, Authorization, Cookie' : 'Accept, Save-Data',
        ...(result.cacheStatus ? { 'X-Cache': result.cacheStatus } : {}),
    };

    // 304 Not Modified — body skipped, browser keeps its cached bytes.
    // RFC 9110 §13.1.2 If-None-Match comparison:
    //   - Wildcard `*` matches any current representation.
    //   - Otherwise the header is a comma-separated list of entity-tags;
    //     a 304 is appropriate if any one matches.
    //   - Comparison uses the weak match function, but both sides here
    //     are produced by the same generator (W/"...") so exact string
    //     compare is sufficient and we skip the strong/weak normalization.
    if (request && shouldReturn304(request, etag)) {
        return new Response(null, {
            status: 304,
            headers: commonHeaders,
        });
    }

    bandwidthTracker.trackImage(result.buffer.byteLength);
    return new Response(new Uint8Array(result.buffer), {
        headers: commonHeaders,
    });
}

function shouldReturn304(request: Request, etag: string): boolean {
    const ifNoneMatch = request.headers.get('if-none-match');
    if (!ifNoneMatch) return false;
    const trimmed = ifNoneMatch.trim();
    if (trimmed === '*') return true;
    // Split on comma, trim, exact-match against our ETag form.
    return trimmed.split(',').some((candidate) => candidate.trim() === etag);
}

function generateETag(buffer: Buffer): string {
    const hash = createHash('md5');
    hash.update(buffer.subarray(0, 32));
    if (buffer.length > 32) hash.update(buffer.subarray(-32));
    hash.update(String(buffer.length));
    return `W/"${hash.digest('hex').substring(0, 16)}"`;
}
