// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `maxConcurrentDownloads()` is exercised in candidates.def.test.ts too, but
 * only against one static config value (4) via the whole HTTP handler. This
 * file drives the function directly (it accepts an optional override so
 * tests don't have to fight the config module's import graph) across the
 * low-`MUSIC_TRANSCODE_MAX_PER_USER` edge -- the case where the server has
 * no, or barely any, spare per-user transcode capacity to hand a download
 * once playback's own slots are accounted for.
 */

import { describe, it, expect } from 'vitest';
import { maxConcurrentDownloads } from './candidates.js';

describe('maxConcurrentDownloads', () => {
    it('advertises 0 when the server has no per-user transcode capacity at all', () => {
        expect(maxConcurrentDownloads(0)).toBe(0);
    });

    it('advertises 0 when the per-user cap leaves no room once playback is accounted for', () => {
        // A cap of 1 means the server can run exactly one transcode per user
        // at all -- advertising a download slot here would let a download
        // collide with the user's own playback, which is the exact failure
        // this function exists to prevent.
        expect(maxConcurrentDownloads(1)).toBe(0);
    });

    it('advertises 1 once the cap can spare a single slot', () => {
        expect(maxConcurrentDownloads(2)).toBe(1);
        expect(maxConcurrentDownloads(3)).toBe(1);
    });

    it('clamps to 2 even on a generous cap', () => {
        expect(maxConcurrentDownloads(4)).toBe(2);
        expect(maxConcurrentDownloads(20)).toBe(2);
    });
});
