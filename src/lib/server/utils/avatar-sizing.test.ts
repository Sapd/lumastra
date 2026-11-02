// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Avatar sizing — the request parsing and the width ladder.
 *
 * Background, because the numbers here are not arbitrary. The avatar endpoint
 * resolves custom upload → Jellyfin → Gravatar. The upload path has always
 * resized to 200 × 200 and Gravatar is fetched at `s=200`, but the **Jellyfin**
 * branch re-encoded the upstream image to WebP without ever resizing it. On prod
 * that served a 2048 × 2080 avatar — roughly 17 MB of decoded bitmap — for a
 * button drawn at 44 pt, and no parameter could make it smaller because the
 * route read none. Measured 2026-08-28 by the iOS client:
 *
 *     GET /users/test/images/avatar             → 2048x2080, 189602 bytes
 *     GET /users/test/images/avatar?width=150   → byte-identical
 *     GET /users/test/images/avatar?size=thumb  → byte-identical
 *
 * These cover the parsing and ladder halves. The normalization itself lives in
 * ImageProxyService and is exercised against a real image there.
 */

import { describe, it, expect } from 'vitest';
import { parseAvatarWidth, AVATAR_SIZE_TO_WIDTH } from './image-params.js';

function url(qs: string): URL {
    return new URL(`https://example.test/api/v1/users/u/images/avatar${qs}`);
}

describe('parseAvatarWidth', () => {
    it('returns undefined when neither parameter is present', () => {
        // Must stay undefined rather than defaulting to a rung: a caller that
        // passes nothing has to keep getting the stored size, or every existing
        // client silently changes behaviour on deploy.
        expect(parseAvatarWidth(url(''))).toBeUndefined();
    });

    it('reads ?width=', () => {
        expect(parseAvatarWidth(url('?width=40'))).toBe(40);
    });

    it('maps ?size= onto the named widths the listing endpoint advertises', () => {
        // users/[id]/images/index.ts emits ?size=thumb|card|full hrefs. Those
        // were pointing at a handler that read neither, so the links described a
        // contract nothing implemented.
        expect(parseAvatarWidth(url('?size=thumb'))).toBe(AVATAR_SIZE_TO_WIDTH.thumb);
        expect(parseAvatarWidth(url('?size=card'))).toBe(AVATAR_SIZE_TO_WIDTH.card);
        expect(parseAvatarWidth(url('?size=full'))).toBe(AVATAR_SIZE_TO_WIDTH.full);
    });

    it('accepts a size in any case', () => {
        expect(parseAvatarWidth(url('?size=THUMB'))).toBe(AVATAR_SIZE_TO_WIDTH.thumb);
    });

    it('prefers width over size when both are given', () => {
        expect(parseAvatarWidth(url('?size=full&width=40'))).toBe(40);
    });

    it('ignores a junk or non-positive width instead of failing the request', () => {
        // An avatar is decoration; a bad parameter must degrade to the default,
        // never 4xx a page's worth of images.
        for (const qs of ['?width=abc', '?width=0', '?width=-5', '?width=']) {
            expect({ qs, got: parseAvatarWidth(url(qs)) }).toEqual({ qs, got: undefined });
        }
    });

    it('ignores an unknown size name', () => {
        expect(parseAvatarWidth(url('?size=enormous'))).toBeUndefined();
    });
});

describe('avatar width ladder', () => {
    // Imported lazily: the service module pulls the whole image-proxy chain, and
    // only the pure static needs testing here.
    async function snap(n: number | undefined): Promise<number> {
        const { ImageProxyService } = await import('../services/image-proxy/service.js');
        return ImageProxyService.snapAvatarWidth(n);
    }

    it('snaps UP, never down', async () => {
        // The media-image ladder picks the NEAREST rung, so ?width=300 yields
        // 250 and ?width=400 yields 350 — a caller can quietly receive fewer
        // pixels than it asked for, which reads as a soft image. At a 200 px
        // ceiling the bytes saved by rounding down are negligible and the cost
        // is visible, so this ladder only ever over-serves.
        expect(await snap(40)).toBe(48);
        expect(await snap(48)).toBe(48);
        expect(await snap(49)).toBe(96);
        expect(await snap(100)).toBe(160);
        expect(await snap(161)).toBe(200);
    });

    it('caps at the stored size for anything larger', async () => {
        // There is no more detail to serve — the source is normalized to 200.
        expect(await snap(1000)).toBe(200);
        expect(await snap(4000)).toBe(200);
    });

    it('defaults to the stored size when nothing was requested', async () => {
        expect(await snap(undefined)).toBe(200);
        expect(await snap(Number.NaN)).toBe(200);
    });

    it('lands on a bounded set of rungs, so the cache cannot be fanned out', async () => {
        // The avatar cache is keyed by width. An open integer parameter would
        // let one caller mint unbounded entries for a picture that is at most
        // 200 px to begin with.
        const seen = new Set<number>();
        for (let i = 1; i <= 400; i++) seen.add(await snap(i));
        expect([...seen].sort((a, b) => a - b)).toEqual([48, 96, 160, 200]);
    });
});
