// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Top Shelf content-key derivation (§9.1).
 */

import { describe, it, expect } from 'vitest';
import {
    computeTopShelfContentKey,
    bucketTopShelfStartPosition,
    TOPSHELF_CONTENT_KEY_BUCKET_SECONDS,
    OVERLAY_PROFILE_REV,
    type TopShelfContentKeyInput,
} from './topshelf-content-key';

const base: TopShelfContentKeyInput = {
    sourceItemId: 'item-1',
    fileId: 'file-1',
    fileVersion: 'v1',
    variant: 'preview',
    startSeconds: 100,
    durationSeconds: 30,
};

describe('computeTopShelfContentKey', () => {
    it('is stable for identical inputs', () => {
        expect(computeTopShelfContentKey(base)).toBe(computeTopShelfContentKey({ ...base }));
    });

    it('is a 16-hex-char string', () => {
        const key = computeTopShelfContentKey(base);
        expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    it('changes when fileVersion changes', () => {
        const other = computeTopShelfContentKey({ ...base, fileVersion: 'v2' });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when variant changes', () => {
        const other = computeTopShelfContentKey({ ...base, variant: 'cinemagraph' });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when startBucket changes', () => {
        const other = computeTopShelfContentKey({ ...base, startSeconds: 1000 });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when durationSeconds changes', () => {
        const other = computeTopShelfContentKey({ ...base, durationSeconds: 15 });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when profileRev changes', () => {
        const other = computeTopShelfContentKey({ ...base, profileRev: 'ts-other' });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when sourceItemId changes', () => {
        const other = computeTopShelfContentKey({ ...base, sourceItemId: 'item-2' });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('changes when fileId changes', () => {
        const other = computeTopShelfContentKey({ ...base, fileId: 'file-2' });
        expect(other).not.toBe(computeTopShelfContentKey(base));
    });

    it('is stable across small start-position deltas inside the same bucket', () => {
        const a = computeTopShelfContentKey({ ...base, startSeconds: 100 });
        const b = computeTopShelfContentKey({
            ...base,
            startSeconds: 100 + Math.floor(TOPSHELF_CONTENT_KEY_BUCKET_SECONDS / 3),
        });
        expect(a).toBe(b);
    });
});

describe('bucketTopShelfStartPosition', () => {
    it('rounds to the nearest bucket multiple', () => {
        expect(bucketTopShelfStartPosition(0)).toBe(0);
        expect(bucketTopShelfStartPosition(7)).toBe(
            Math.round(7 / TOPSHELF_CONTENT_KEY_BUCKET_SECONDS) *
                TOPSHELF_CONTENT_KEY_BUCKET_SECONDS,
        );
    });

    it('never returns a negative bucket', () => {
        expect(bucketTopShelfStartPosition(-5)).toBeGreaterThanOrEqual(0);
    });
});

describe('computeTopShelfContentKey — overlay extension', () => {
    const basePlain = {
        sourceItemId: 'item-1',
        fileId: 'file-1',
        fileVersion: 'v-1',
        variant: 'preview' as const,
        startSeconds: 10,
        durationSeconds: 30,
    };

    it('plain key is unchanged by the presence of the new optional params', () => {
        const withUndef = computeTopShelfContentKey({
            ...basePlain,
            overlayContentHash: undefined,
            overlayProfileRev: undefined,
        });
        const legacy = computeTopShelfContentKey(basePlain);
        expect(withUndef).toBe(legacy);
    });

    it('overlaid variants with different content hashes get different keys', () => {
        const a = computeTopShelfContentKey({
            ...basePlain,
            variant: 'preview-ov-logo-tl-s1-x40',
            overlayContentHash: 'aaaaaaaaaaaaaaaa',
            overlayProfileRev: OVERLAY_PROFILE_REV,
        });
        const b = computeTopShelfContentKey({
            ...basePlain,
            variant: 'preview-ov-logo-tl-s1-x40',
            overlayContentHash: 'bbbbbbbbbbbbbbbb',
            overlayProfileRev: OVERLAY_PROFILE_REV,
        });
        expect(a).not.toBe(b);
    });

    it('overlaid differs from plain even with the same base variant string', () => {
        const plain = computeTopShelfContentKey(basePlain);
        const overlaid = computeTopShelfContentKey({
            ...basePlain,
            variant: 'preview-ov-logo-tl-s1-x40',
            overlayContentHash: 'aaaaaaaaaaaaaaaa',
            overlayProfileRev: OVERLAY_PROFILE_REV,
        });
        expect(overlaid).not.toBe(plain);
    });
});
