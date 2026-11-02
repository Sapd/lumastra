// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it, vi } from 'vitest';

const { secret } = vi.hoisted(() => ({ secret: { value: 'test-jwt-secret' as string } }));

vi.mock('$lib/server/config', () => ({
    config: {
        get JWT_SECRET() {
            return secret.value;
        },
    },
}));

import { canonicalGroupId, libraryImageTag, verifyLibraryImageTag } from './library-image-tag';

const GROUP = '5a447279-71f6-4ece-90a7-cc5cc2cc8295';
const OTHER = 'ba1a06df-a512-441a-b4c9-9f3d81700bde';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Monday 2026-10-05 12:00 UTC — mid-bucket, nothing special about it.
const NOW = Date.UTC(2026, 9, 5, 12);

describe('library image tags', () => {
    it('is 40 lowercase hex chars and verifies for its own library', () => {
        const tag = libraryImageTag(GROUP, NOW)!;
        expect(tag).toMatch(/^[0-9a-f]{40}$/);
        expect(verifyLibraryImageTag(GROUP, tag, NOW)).toBe(true);
    });

    it('does not unlock another library', () => {
        expect(verifyLibraryImageTag(OTHER, libraryImageTag(GROUP, NOW), NOW)).toBe(false);
    });

    it('accepts the dashless id form clients send, and an upper-case tag', () => {
        const tag = libraryImageTag(GROUP, NOW)!;
        expect(verifyLibraryImageTag(GROUP.replace(/-/g, ''), tag, NOW)).toBe(true);
        expect(verifyLibraryImageTag(GROUP.toUpperCase(), tag.toUpperCase(), NOW)).toBe(true);
    });

    it('stays the same within a week (stable client cache key) and rotates after', () => {
        const tag = libraryImageTag(GROUP, NOW);
        expect(libraryImageTag(GROUP, NOW + 60_000)).toBe(tag);
        expect(libraryImageTag(GROUP, NOW + 2 * WEEK_MS)).not.toBe(tag);
    });

    it('is valid for at least a week and at most two', () => {
        const tag = libraryImageTag(GROUP, NOW)!;
        expect(verifyLibraryImageTag(GROUP, tag, NOW + WEEK_MS - 1)).toBe(true);
        expect(verifyLibraryImageTag(GROUP, tag, NOW + 2 * WEEK_MS)).toBe(false);
    });

    it('rejects forged, truncated and empty tags', () => {
        const tag = libraryImageTag(GROUP, NOW)!;
        const flipped = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0');
        expect(verifyLibraryImageTag(GROUP, flipped, NOW)).toBe(false);
        // A far-future expiry with a made-up signature.
        expect(verifyLibraryImageTag(GROUP, 'ffffffff' + tag.slice(8), NOW)).toBe(false);
        expect(verifyLibraryImageTag(GROUP, tag.slice(0, 39), NOW)).toBe(false);
        expect(verifyLibraryImageTag(GROUP, '', NOW)).toBe(false);
        expect(verifyLibraryImageTag(GROUP, null, NOW)).toBe(false);
        // An ordinary Jellyfin image tag (32 hex) is never a library tag.
        expect(verifyLibraryImageTag(GROUP, 'a'.repeat(32), NOW)).toBe(false);
    });

    it('a tag signed with another secret does not verify', () => {
        const tag = libraryImageTag(GROUP, NOW)!;
        secret.value = 'rotated-secret';
        try {
            expect(verifyLibraryImageTag(GROUP, tag, NOW)).toBe(false);
        } finally {
            secret.value = 'test-jwt-secret';
        }
    });

    it('mints and accepts nothing without a secret', () => {
        secret.value = '';
        try {
            expect(libraryImageTag(GROUP, NOW)).toBeUndefined();
            expect(verifyLibraryImageTag(GROUP, 'a'.repeat(40), NOW)).toBe(false);
        } finally {
            secret.value = 'test-jwt-secret';
        }
    });

    it('canonicalGroupId re-dashes a dashless uuid and leaves other ids alone', () => {
        expect(canonicalGroupId(GROUP.replace(/-/g, '').toUpperCase())).toBe(GROUP);
        expect(canonicalGroupId('not-a-uuid')).toBe('not-a-uuid');
    });
});
