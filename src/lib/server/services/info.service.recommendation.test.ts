// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildTrackRecommendation } from './info.service';

const TRACKS = {
    audio: [
        { index: 0, absoluteIndex: 1, language: 'ger', title: null, default: true },
        { index: 1, absoluteIndex: 2, language: 'jpn', title: null, default: false },
    ],
    // NOTE: the schema field is `forced`, NOT `isForced`.
    subtitles: [{ index: 4, language: 'eng', forced: false, codec: 'subrip' }],
};

const BASE_PREFS = {
    preferOriginalAudio: false,
    audioLanguage: null,
    lastAudioLanguage: null,
    subtitleLanguage: null,
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: false,
    subtitleTrackHint: null,
};

describe('buildTrackRecommendation', () => {
    it('recommends the original language when the viewer prefers it', () => {
        const r = buildTrackRecommendation(
            TRACKS,
            { ...BASE_PREFS, preferOriginalAudio: true, audioLanguage: 'en' },
            'ja',
        );
        expect(r.audio_track_index).toBe(1);
        expect(r.reason.audio).toBe('original-language');
    });

    it('omits the subtitle index and says why, rather than encoding null', () => {
        const r = buildTrackRecommendation(
            TRACKS,
            { ...BASE_PREFS, subtitlesEnabled: false },
            null,
        );
        expect(r.subtitle_track_index).toBeUndefined();
        expect(r.reason.subtitle).toBe('off');
    });
});

describe('buildTrackRecommendation: subtitle title-only forced heuristic', () => {
    // Round-2 finding: the AUDIO mapping passes `title` through to the shared
    // resolver (`title: a.title ?? null`), but the SUBTITLE mapping dropped it
    // entirely — even though LumastraSubtitleTrackSchema carries a `title`
    // field and the caller's `tracks.subtitles` objects already have one. That
    // silently starved the server's isTrackForced() of the title-based
    // fallback the client (playerStore.svelte.ts, since the round-1 refactor)
    // uses via `title: s.displayTitle`. A file whose only "forced" signal is
    // in the title — `forced: false` in the container, but the stream title
    // itself contains "forced" — is exactly the case client and server must
    // agree on; without the mapping they don't.
    const TRACKS_TITLE_ONLY_FORCED = {
        audio: [{ index: 0, language: 'eng', title: null, default: true }],
        subtitles: [
            {
                index: 4,
                language: 'eng',
                forced: false, // container bit NOT set — title is the only signal
                codec: 'subrip',
                title: 'English (Forced)',
            },
        ],
    };

    it('recommends the title-tagged forced subtitle when the container forced bit is unset', () => {
        const r = buildTrackRecommendation(
            TRACKS_TITLE_ONLY_FORCED,
            { ...BASE_PREFS, forcedSubtitlesEnabled: true },
            null,
        );
        expect(r.subtitle_track_index).toBe(4);
        expect(r.reason.subtitle).toBe('forced-for-audio');
    });
});

it('restores exact same-file subtitle identity through the real server recommendation adapter (B9)', () => {
    const tracks = {
        ...TRACKS,
        subtitles: [4, 5].map((index) => ({
            index,
            language: 'eng',
            forced: false,
            codec: 'subrip',
            title: 'English',
        })),
    };
    const prefs = {
        ...BASE_PREFS,
        subtitleTrackHint: {
            language: 'eng',
            isForced: false,
            codec: 'subrip',
            title: 'English',
            fileId: 'file-a',
            trackId: 'file-a:5',
        },
    };
    expect(buildTrackRecommendation(tracks, prefs, null, 'file-a').subtitle_track_index).toBe(5);
    expect(buildTrackRecommendation(tracks, prefs, null, 'file-b').subtitle_track_index).toBe(4);
});
