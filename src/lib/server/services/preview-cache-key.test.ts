// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { seekBucket, buildPreviewKey, type PreviewProfile } from './preview-cache-key';

const PROFILE: PreviewProfile = {
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioTrackIndex: 1,
    maxWidth: 1280,
    maxHeight: 720,
    maxDurationSeconds: 30,
    encodingPreset: 'veryfast',
};

describe('seekBucket', () => {
    it('rounds to the nearest bucket', () => {
        expect(seekBucket(2124, 15)).toBe(2130); // 2124/15=141.6 → 142*15
        expect(seekBucket(7, 15)).toBe(0);
        expect(seekBucket(8, 15)).toBe(15);
    });
    it('never returns negative', () => {
        expect(seekBucket(-5, 15)).toBe(0);
    });
});

describe('buildPreviewKey', () => {
    const base = {
        fileId: 'f1',
        rawSeekSeconds: 100,
        bucketSeconds: 15,
        profile: PROFILE,
        fileVersion: 'v1',
    };
    it('is deterministic (same inputs → same 64-hex key)', () => {
        const a = buildPreviewKey(base);
        const b = buildPreviewKey({ ...base });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
    it('keys by the BUCKET, not the raw seek (7 and 14 → different buckets)', () => {
        const at7 = buildPreviewKey({ ...base, rawSeekSeconds: 7 });
        const at14 = buildPreviewKey({ ...base, rawSeekSeconds: 14 });
        expect(at7).not.toBe(at14); // 7→0, 14→15
        const at2 = buildPreviewKey({ ...base, rawSeekSeconds: 2 });
        expect(at7).toBe(at2); // both → bucket 0
    });
    it('a fileVersion change rotates the key (content changed)', () => {
        expect(buildPreviewKey(base)).not.toBe(buildPreviewKey({ ...base, fileVersion: 'v2' }));
    });
    it('a resolved absolute audio track change rotates the key', () => {
        const other = { ...PROFILE, audioTrackIndex: 3 };
        expect(buildPreviewKey(base)).not.toBe(buildPreviewKey({ ...base, profile: other }));
        expect(buildPreviewKey(base)).toBe(
            buildPreviewKey({ ...base, profile: { ...PROFILE, audioTrackIndex: 1 } }),
        );
    });
    it('a profile change rotates the key', () => {
        const other = buildPreviewKey({ ...base, profile: { ...PROFILE, maxHeight: 1080 } });
        expect(buildPreviewKey(base)).not.toBe(other);
    });
});
