// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { serializeSong } from './song.js';

function songWithMetadata(custom_metadata: Record<string, unknown>) {
    return {
        id: 'track-1',
        title: 'Test track',
        runtime_seconds: 180,
        custom_metadata,
        sort_order: 1,
        file_path: null,
        parent_id: 'album-1',
        track_artist_id: 'artist-1',
        track_artist_title: 'Test artist',
        created_at: '2026-08-10T00:00:00.000Z',
    };
}

describe('serializeSong replayGain', () => {
    it('exposes the dashboard-equivalent ReplayGain for analyzed tracks', () => {
        const song = serializeSong(songWithMetadata({ essentia: { loudness_lufs: -8 } }) as never);

        expect(song.replayGain).toEqual({ trackGain: -6, fallbackGain: -6 });
    });

    it('uses the same safe gain cap as the dashboard player', () => {
        const song = serializeSong(songWithMetadata({ essentia: { loudness_lufs: -30 } }) as never);

        expect(song.replayGain).toEqual({ trackGain: 6, fallbackGain: 6 });
    });

    it('omits ReplayGain for tracks without a usable loudness measurement', () => {
        const song = serializeSong(songWithMetadata({ essentia: { bpm: 128 } }) as never);

        expect(song.replayGain).toBeUndefined();
    });
});
