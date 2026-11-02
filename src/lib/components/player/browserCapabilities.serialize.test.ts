// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { serializePathScopedCaps } from './browserCapabilities.svelte';
import { parseCapsAuto } from '$lib/server/utils/info.utils';
import type { PathScopedCapabilities } from './codec-types';

function caps(overrides: Partial<PathScopedCapabilities> = {}): PathScopedCapabilities {
    return {
        directFile: { videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'] },
        nativeHls: { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'] },
        mseHls: { videoCodecs: [], audioCodecs: [] },
        subtitleRendering: { vtt: true, pgs: true, ass: true, vobsub: true, burnInRequired: [] },
        hdr: { decode: [], display: false },
        audioSwitching: true,
        maxChannels: 6,
        codecConstraints: {},
        ...overrides,
    };
}

describe('serializePathScopedCaps — separate-audio preference (iPhone/iPad)', () => {
    it('round-trips hlsDemuxAudio to the server as prefersHlsDemuxAudio', () => {
        const wire = serializePathScopedCaps(caps({ hlsDemuxAudio: true }));
        expect(wire).toContain('da:1');
        const parsed = parseCapsAuto(wire);
        expect(parsed?.deviceCaps.prefersHlsDemuxAudio).toBe(true);
        expect(parsed?.pathScoped?.hlsDemuxAudio).toBe(true);
        // The other trailing params survive next to it.
        expect(parsed?.deviceCaps.canSwitchAudioInDirectPlay).toBe(true);
        expect(parsed?.deviceCaps.maxAudioChannels).toBe(6);
    });

    it('sends nothing for other browsers', () => {
        const wire = serializePathScopedCaps(caps());
        expect(wire).not.toContain('da:');
        expect(parseCapsAuto(wire)?.deviceCaps.prefersHlsDemuxAudio).toBeUndefined();
    });
});
