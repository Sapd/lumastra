// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeChapterImageRevision, revisionCacheControl } from './playback-image-revision.js';

describe('chapter image revisions', () => {
    it('hashes file, start, width, and a pre-resolved manifest revision', () => {
        const revision = computeChapterImageRevision('file', 100, 320, 'base');
        expect(revision).toBe(createHash('sha256').update('file:100:320:base').digest('hex'));
        expect(computeChapterImageRevision('other', 100, 320, 'base')).not.toBe(revision);
        expect(computeChapterImageRevision('file', 200, 320, 'base')).not.toBe(revision);
        expect(computeChapterImageRevision('file', 100, 640, 'base')).not.toBe(revision);
        expect(computeChapterImageRevision('file', 100, 320, 'next')).not.toBe(revision);
        expect(computeChapterImageRevision('file', 100, 320, null)).toBeNull();
    });
    it('allows immutable caching only for the current revision', () => {
        expect(revisionCacheControl('current', 'current')).toBe(
            'public, max-age=31536000, immutable',
        );
        for (const requested of [null, '', 'old'])
            expect(revisionCacheControl(requested, 'current')).toBe('no-cache');
        expect(revisionCacheControl(null, null)).toBe('no-cache');
    });
});
