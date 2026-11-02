// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getLiveTvRung, LIVETV_RUNGS, resolveLiveTvRung } from './livetv-rungs.js';

describe('Live TV rung ladder', () => {
    it.each([
        [12_000_000, '1080p8m'],
        [8_000_000, '1080p8m'],
        [7_999_999, '720p4m'],
        [3_000_000, '540p2m'],
        [1_000_000, '360p1m'],
        [999_999, 'below_ladder'],
    ])('snaps %d bps down to %s', (requested, expected) => {
        const result = resolveLiveTvRung(requested);
        expect(typeof result === 'string' ? result : result.id).toBe(expected);
    });

    it('keeps the public ladder descending and uniquely addressable', () => {
        expect(LIVETV_RUNGS.map((rung) => rung.maxBitrate)).toEqual([
            8_000_000, 4_000_000, 2_000_000, 1_000_000,
        ]);
        expect(getLiveTvRung('540p2m')).toEqual(LIVETV_RUNGS[2]);
        expect(getLiveTvRung('../../escape')).toBeUndefined();
    });
});
