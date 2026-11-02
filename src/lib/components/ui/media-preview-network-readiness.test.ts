/*
 * SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The hls.js readiness path (MANIFEST_LOADED / LEVEL_LOADED ->
 * `markReadyFromNetworkDetails` -> this decision) is the path EVERY Chrome
 * and Firefox user takes -- happy-dom has no `MediaSource`, so it cannot be
 * driven through a mounted `MediaPreviewPlayer` component test (see
 * `MediaPreviewPlayer.session-reuse.test.ts`, which covers the Safari
 * native-HLS readiness call site instead). This file is what actually pins
 * the hls.js call site's behaviour: the decision logic lives in
 * `media-preview-network-readiness.ts` precisely so it can be tested here,
 * directly, without hls.js or a DOM at all.
 */

import { describe, expect, it } from 'vitest';
import { isPreviewReadyFromNetworkDetails } from './media-preview-network-readiness';

describe('isPreviewReadyFromNetworkDetails', () => {
    it('is ready for an XHR-like object whose getResponseHeader returns the marker', () => {
        const xhrLike = {
            getResponseHeader: (name: string) =>
                name === 'X-Lumastra-Preview-Static' ? '1' : null,
        };
        expect(isPreviewReadyFromNetworkDetails(xhrLike)).toBe(true);
    });

    it('is NOT ready for an XHR-like object whose getResponseHeader returns null', () => {
        const xhrLike = { getResponseHeader: (_name: string) => null };
        expect(isPreviewReadyFromNetworkDetails(xhrLike)).toBe(false);
    });

    it('is NOT ready for a Response-like object with no getResponseHeader (feature-test, must not throw)', () => {
        // Shaped like the `Response` half of hls.js's `networkDetails` union
        // -- has `.headers.get(...)`, NOT `.getResponseHeader(...)`. The
        // function must feature-test rather than assume the XHR shape, so
        // this must return false without throwing.
        const responseLike = {
            headers: { get: (name: string) => (name === 'X-Lumastra-Preview-Static' ? '1' : null) },
        };
        expect(() => isPreviewReadyFromNetworkDetails(responseLike)).not.toThrow();
        expect(isPreviewReadyFromNetworkDetails(responseLike)).toBe(false);
    });

    it('is NOT ready for null or undefined networkDetails', () => {
        expect(isPreviewReadyFromNetworkDetails(null)).toBe(false);
        expect(isPreviewReadyFromNetworkDetails(undefined)).toBe(false);
    });
});
