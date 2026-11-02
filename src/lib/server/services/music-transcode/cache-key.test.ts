// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { computeCacheKey, cachePathFor } from './cache-key.js';

describe('computeCacheKey', () => {
    const base = {
        trackUuid: 'aaaa-bbbb',
        mtimeMs: 1000,
        codec: 'mp3' as const,
        bitrateKbps: 192,
    };

    it('invalidates entries from the old encoder format', () => {
        const legacy = createHash('sha256')
            .update([base.trackUuid, base.mtimeMs, base.codec, base.bitrateKbps].join('|'))
            .digest('hex');
        expect(computeCacheKey(base)).not.toBe(legacy);
    });
    it('isolates native-length output and each normalized length', () => {
        expect(computeCacheKey({ ...base, expectedSize: 160_000 })).not.toBe(computeCacheKey(base));
        expect(computeCacheKey({ ...base, expectedSize: 160_000 })).not.toBe(
            computeCacheKey({ ...base, expectedSize: 176_000 }),
        );
    });
    it('is deterministic', () => {
        expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
    });
    it('changes when mtime changes', () => {
        expect(computeCacheKey({ ...base, mtimeMs: 2000 })).not.toBe(computeCacheKey(base));
    });
    it('changes when codec changes', () => {
        expect(computeCacheKey({ ...base, codec: 'opus' })).not.toBe(computeCacheKey(base));
    });
    it('changes when bitrate changes', () => {
        expect(computeCacheKey({ ...base, bitrateKbps: 320 })).not.toBe(computeCacheKey(base));
    });
});

describe('cachePathFor', () => {
    it('shards by first 2 chars and uses codec extension', () => {
        const path = cachePathFor('/cache', '0123456789abcdef', 'mp3');
        expect(path).toBe('/cache/01/0123456789abcdef.mp3');
    });
    it('uses .opus extension for opus', () => {
        expect(cachePathFor('/cache', 'abcd', 'opus').endsWith('.opus')).toBe(true);
    });
    it('uses .aac extension for aac', () => {
        expect(cachePathFor('/cache', 'abcd', 'aac').endsWith('.aac')).toBe(true);
    });
});
