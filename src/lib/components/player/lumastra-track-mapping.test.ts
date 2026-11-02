// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { mapLumastraAudioStreams, type LumastraAudioTrack } from './lumastra-track-mapping';
import { resolvePreferredAudioTrack } from '$lib/shared/track-selection';

const audio = (o: Partial<LumastraAudioTrack> & { index: number }): LumastraAudioTrack => ({
    codec: 'aac',
    channels: 2,
    language: 'eng',
    default: false,
    ...o,
});

describe('mapLumastraAudioStreams', () => {
    it('carries the raw title through, not only folded into displayTitle', () => {
        const [track] = mapLumastraAudioStreams([
            audio({ index: 0, title: "Director's Commentary" }),
        ]);
        expect(track.title).toBe("Director's Commentary");
        expect(track.displayTitle).toBe("Director's Commentary");
    });

    it('leaves title undefined when the file has none, without inventing one', () => {
        // displayTitle falls back for presentation; `title` must NOT, or the
        // commentary filter would start matching synthesized labels.
        const [track] = mapLumastraAudioStreams([audio({ index: 2, language: null })]);
        expect(track.title).toBeUndefined();
        expect(track.displayTitle).toBe('Audio 2');
    });

    it('preserves both index conventions', () => {
        const [track] = mapLumastraAudioStreams([audio({ index: 1, absoluteIndex: 3 })]);
        expect(track.index).toBe(1);
        expect(track.absoluteIndex).toBe(3);
    });

    // The point of carrying `title`: the shared resolver's commentary filter is
    // a no-op on any candidate list that lacks it. This asserts the two halves
    // fit together, which neither module can prove alone.
    it('produces candidates the shared resolver can filter commentary from', () => {
        const streams = mapLumastraAudioStreams([
            audio({ index: 0, title: "Director's Commentary", default: true }),
            audio({ index: 1, title: 'English 5.1', channels: 6 }),
        ]);

        const resolved = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'eng', lastAudioLanguage: null },
            null,
            0,
        );

        expect(resolved.index).toBe(1);
    });
});
