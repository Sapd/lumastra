// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

// A DELIBERATELY hostile double: every method throws. This is the shape that
// caused the regression this suite guards — a partial stub missing whatever
// env-snapshot most recently started reading.
// `vi.hoisted` because vi.mock factories are hoisted above ordinary consts.
const { throwing } = vi.hoisted(() => ({
    throwing: () => {
        throw new Error('not stubbed');
    },
}));

vi.mock('./hardware-detection.js', () => ({
    hardwareDetection: {
        getCachedCapabilities: throwing,
        getCachedNvidiaGpuName: throwing,
        getNonHardwareDecodableCodecs: throwing,
    },
}));

vi.mock('./gpu-identity.js', () => ({ readGpuIdentities: throwing }));

// A Proxy over a literal with no `buildInfo` — exactly how several suites mock
// config, and what turned a two-level dereference into a lost failure record.
vi.mock('$lib/server/config.js', () => ({
    config: new Proxy({} as Record<string, unknown>, {
        get: (t, p: string) => t[p],
    }),
}));

import { buildTranscodeEnvSnapshot } from './env-snapshot.js';

describe('buildTranscodeEnvSnapshot', () => {
    // The caller wraps this in a catch that logs at DEBUG — invisible at prod log
    // level — so a throw here does not degrade the failure report, it deletes it.
    // The snapshot must therefore be structurally incapable of throwing, whatever
    // the state of the things it reads.
    it('never throws, even when every dependency it reads throws', () => {
        expect(() => buildTranscodeEnvSnapshot()).not.toThrow();
    });

    it('still reports the fields that do not depend on a throwing source', () => {
        const snap = buildTranscodeEnvSnapshot();

        expect(snap.node).toBe(process.version);
        expect(snap.os).toEqual(expect.any(String));
        expect(snap.arch).toEqual(expect.any(String));
    });

    // `null` rather than a missing key: JSON.stringify DROPS undefined, which would
    // make an unreadable field indistinguishable from a schema change.
    it('degrades an unreadable field to null rather than omitting the key', () => {
        const snap = buildTranscodeEnvSnapshot();

        for (const key of ['hardwareDecoders', 'learnedDecodeDenials', 'gpus', 'videoEncoders']) {
            expect(snap).toHaveProperty(key);
            expect(snap[key]).toBeNull();
        }
    });

    it('falls back to a usable build identity when config carries none', () => {
        expect(buildTranscodeEnvSnapshot().appVersion).toBe('unknown');
    });
});
