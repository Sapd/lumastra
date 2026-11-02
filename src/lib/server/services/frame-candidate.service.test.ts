// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildCandidateArgs, DEFAULT_CANDIDATES } from './frame-candidate.service.js';

const VIDEO = '/data/series/Show/Season 01/Show - S01E01 - Title - Bluray-1080p.mkv';
const TIMES = [500.5006, 900.25, 1300, 1700.125];

describe('buildCandidateArgs', () => {
    const args = buildCandidateArgs(VIDEO, TIMES, '/tmp/out', 80, 640, 360, 1800);

    it('input-seeks: every -ss precedes its -i', () => {
        // Output seek (-i before -ss) decodes from zero and discards, which is a
        // full linear read of the file over the media mount. This ordering is
        // the single most expensive thing to get wrong.
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '-i') {
                const ss = args.lastIndexOf('-ss', i);
                expect(ss).toBeGreaterThan(-1);
                expect(ss).toBeLessThan(i);
            }
        }
    });

    it('opens the file once per candidate', () => {
        expect(args.filter((a) => a === '-i')).toHaveLength(TIMES.length);
        expect(args.filter((a) => a === VIDEO)).toHaveLength(TIMES.length);
    });

    it('supplies -threads per input, not globally', () => {
        // A single global -threads binds to input 0 only, leaving the other
        // inputs auto-threaded; supplying our own also stops the shared
        // injectThreadsFlag() from prepending one.
        expect(args.filter((a) => a === '-threads')).toHaveLength(TIMES.length);
    });

    it('accurately decodes to each target and stops at the episode end', () => {
        expect(args).not.toContain('-skip_frame');
        expect(args).not.toContain('-noaccurate_seek');
        expect(args.filter((a) => a === '-accurate_seek')).toHaveLength(TIMES.length);
        expect(args).toContain('-copyts');
        expect(args).toContain('-start_at_zero');
        const filters = args.flatMap((a, i) => (a === '-vf' ? [args[i + 1]] : []));
        filters.forEach((filter, i) =>
            expect(filter).toContain(
                `trim=start=${TIMES[i].toFixed(3)}:end=1800.000000,setpts=PTS-STARTPTS`,
            ),
        );
    });

    it('maps only true video streams (capital V)', () => {
        // Lowercase v can select an attached cover-art mjpeg, which on some MKVs
        // is stream 0 — every candidate would then be the poster.
        TIMES.forEach((_, i) => expect(args).toContain(`${i}:V:0`));
        expect(args.some((a) => /^\d+:v:0$/.test(a))).toBe(false);
    });

    it('writes candidates to the given temp dir, never beside the video', () => {
        const outs = args.filter((a) => a.endsWith('.jpg'));
        expect(outs).toHaveLength(TIMES.length);
        for (const o of outs) {
            expect(o.startsWith('/tmp/out/')).toBe(true);
            expect(o.includes('/data/')).toBe(false);
        }
    });

    it('formats seek times with millisecond precision', () => {
        expect(args).toContain('500.501');
        expect(args).toContain('1700.125');
    });

    it('samples four candidates by default', () => {
        expect(DEFAULT_CANDIDATES).toBe(4);
    });
});
