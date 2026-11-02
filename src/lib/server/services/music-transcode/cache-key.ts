// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MusicCodec } from './types.js';

export interface CacheKeyInput {
    trackUuid: string;
    mtimeMs: number;
    codec: MusicCodec;
    bitrateKbps: number;
    /** Normalized MP3 length; absent for encode-then-serve/pipe output. */
    expectedSize?: number | null;
}

export function computeCacheKey(input: CacheKeyInput): string {
    // Bump when encoder args or the on-disk format/length contract changes.
    const canonical = [
        'music-encode-v2-no-xing',
        input.trackUuid,
        input.mtimeMs,
        input.codec,
        input.bitrateKbps,
        input.expectedSize ?? 'native',
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
}

const EXT_FOR_CODEC: Record<MusicCodec, string> = {
    mp3: 'mp3',
    opus: 'opus',
    aac: 'aac',
    // Distinct extension AND distinct cache key: an ADTS payload served as
    // audio/mp4 would fail to open, so the two must never share an entry.
    m4a: 'm4a',
};

export function cachePathFor(cacheDir: string, key: string, codec: MusicCodec): string {
    const shard = key.slice(0, 2);
    return join(cacheDir, shard, `${key}.${EXT_FOR_CODEC[codec]}`);
}

export function partialPathFor(finalPath: string): string {
    return `${finalPath}.partial`;
}
