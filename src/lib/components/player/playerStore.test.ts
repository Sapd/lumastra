// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for playerStore utilities
 *
 * Tests the pure utility functions exported from playerStore.
 * The store's reactive methods (setAudioTrack, setForcedSubtitlesEnabled, etc.)
 * involve browser APIs (localStorage) and would need mocking for full coverage.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { MediaSourceInfo, SubtitleStreamInfo } from '$lib/types/playback';
import { AUDIO_ONLY_PROFILE, ORIGINAL_PROFILE } from '$lib/types/playback';
import { QualityModeSchema } from '$lib/schemas/playback-types';
// Time functions live in player-utils.ts; import directly from there
// rather than through playerStore.ts to test the canonical source. (ref: DL-006)
import { formatTime, secondsToTicks, ticksToSeconds } from './player-utils';
import {
    resolveAudioTrackIndexForMediaSource,
    resolveSubtitleTrackIndexForMediaSource,
    playerStore,
} from './playerStore.svelte';
import { DEFAULT_TRANSCODING_PROFILES } from '$lib/types/playback';
import { getPreferences, updatePreference, playbackPreferences } from './preferences-sync.svelte';
vi.mock('$lib/api/user', () => ({
    updatePlaybackPreferences: vi.fn().mockResolvedValue({ data: {}, error: null }),
}));
beforeEach(async () => {
    await playbackPreferences.forceSyncToServer();
});
import type { PlaybackPreferences } from './preferences-sync.svelte';

afterEach(() => {
    playerStore.currentQualityProfile = null;
    playerStore.previousQualityProfile = null;
    playerStore.qualityMode = 'original';
});

describe('formatTime', () => {
    it('formats seconds under a minute correctly', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(5)).toBe('0:05');
        expect(formatTime(30)).toBe('0:30');
        expect(formatTime(59)).toBe('0:59');
    });

    it('formats minutes correctly', () => {
        expect(formatTime(60)).toBe('1:00');
        expect(formatTime(65)).toBe('1:05');
        expect(formatTime(90)).toBe('1:30');
        expect(formatTime(599)).toBe('9:59');
        expect(formatTime(600)).toBe('10:00');
        expect(formatTime(3599)).toBe('59:59');
    });

    it('formats hours correctly', () => {
        expect(formatTime(3600)).toBe('1:00:00');
        expect(formatTime(3665)).toBe('1:01:05');
        expect(formatTime(7200)).toBe('2:00:00');
        expect(formatTime(7261)).toBe('2:01:01');
        expect(formatTime(36000)).toBe('10:00:00');
    });

    it('handles decimal seconds by flooring', () => {
        expect(formatTime(5.9)).toBe('0:05');
        expect(formatTime(59.99)).toBe('0:59');
        expect(formatTime(3599.9)).toBe('59:59');
    });

    it('handles edge cases', () => {
        expect(formatTime(Number.NaN)).toBe('0:00');
        expect(formatTime(Infinity)).toBe('0:00');
        expect(formatTime(-Infinity)).toBe('0:00');
        expect(formatTime(-5)).toBe('0:05'); // Absolute value used
    });
});

describe('secondsToTicks', () => {
    it('converts seconds to Jellyfin ticks (10M ticks per second)', () => {
        expect(secondsToTicks(0)).toBe(0);
        expect(secondsToTicks(1)).toBe(10000000);
        expect(secondsToTicks(60)).toBe(600000000);
        expect(secondsToTicks(3600)).toBe(36000000000);
    });

    it('handles fractional seconds', () => {
        expect(secondsToTicks(1.5)).toBe(15000000);
        expect(secondsToTicks(0.1)).toBe(1000000);
    });

    it('floors the result', () => {
        expect(secondsToTicks(1.0000001)).toBe(10000001);
    });
});

describe('ticksToSeconds', () => {
    it('converts Jellyfin ticks to seconds', () => {
        expect(ticksToSeconds(0)).toBe(0);
        expect(ticksToSeconds(10000000)).toBe(1);
        expect(ticksToSeconds(600000000)).toBe(60);
        expect(ticksToSeconds(36000000000)).toBe(3600);
    });

    it('handles fractional ticks', () => {
        expect(ticksToSeconds(15000000)).toBe(1.5);
        expect(ticksToSeconds(5000000)).toBe(0.5);
    });
});

describe('roundtrip conversion', () => {
    it('seconds -> ticks -> seconds is identity for whole seconds', () => {
        const testValues = [0, 1, 60, 3600, 7200, 86400];
        for (const seconds of testValues) {
            expect(ticksToSeconds(secondsToTicks(seconds))).toBe(seconds);
        }
    });
});

function createMediaSource(overrides: Partial<MediaSourceInfo> = {}): MediaSourceInfo {
    return {
        id: 'file-1',
        name: 'Test Source',
        path: '/video.mkv',
        container: 'mkv',
        size: 1,
        bitrate: 1,
        supportsDirectPlay: true,
        supportsDirectStream: true,
        supportsTranscoding: true,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [],
        ...overrides,
    };
}

function createSubtitleTrack(overrides: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo {
    return {
        index: 0,
        codec: 'subrip',
        language: 'eng',
        languageCode: 'eng',
        displayTitle: 'English',
        isDefault: false,
        isForced: false,
        isExternal: false,
        supportsExternalStream: true,
        isTextSubtitleStream: true,
        ...overrides,
    };
}

describe('track selection reconciliation', () => {
    it('remaps audio tracks by language when indices change', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 7,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    channels: 2,
                    isDefault: false,
                },
                {
                    index: 8,
                    codec: 'aac',
                    language: 'jpn',
                    languageCode: 'jpn',
                    displayTitle: 'Japanese',
                    channels: 2,
                    isDefault: true,
                },
            ],
            defaultAudioStreamIndex: 8,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(mediaSource, 3, {
            index: 3,
            codec: 'aac',
            language: 'en',
            languageCode: 'en',
            displayTitle: 'English',
            channels: 2,
            isDefault: false,
        });

        expect(resolved).toBe(7);
    });

    it('remaps subtitle tracks by language and forced state when indices change', () => {
        const mediaSource = createMediaSource({
            subtitleStreams: [
                createSubtitleTrack({
                    index: 11,
                    language: 'eng',
                    languageCode: 'eng',
                }),
                createSubtitleTrack({
                    index: 12,
                    language: 'eng',
                    languageCode: 'eng',
                    isForced: true,
                    displayTitle: 'English Forced',
                }),
            ],
        });

        const resolved = resolveSubtitleTrackIndexForMediaSource(
            mediaSource,
            4,
            createSubtitleTrack({
                index: 4,
                language: 'en',
                languageCode: 'en',
            }),
        );

        expect(resolved).toBe(11);
    });

    it('falls back to the new media source default subtitle when no matching subtitle remains', () => {
        const mediaSource = createMediaSource({
            subtitleStreams: [
                createSubtitleTrack({
                    index: 21,
                    language: 'deu',
                    languageCode: 'deu',
                    isDefault: true,
                }),
                createSubtitleTrack({
                    index: 22,
                    language: 'fra',
                    languageCode: 'fra',
                }),
            ],
            defaultSubtitleStreamIndex: 21,
        });

        const resolved = resolveSubtitleTrackIndexForMediaSource(
            mediaSource,
            9,
            createSubtitleTrack({
                index: 9,
                language: 'jpn',
                languageCode: 'jpn',
            }),
        );

        expect(resolved).toBe(21);
    });

    it('keeps current audio index when it still exists in the new source', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 5,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    channels: 2,
                    isDefault: false,
                },
                {
                    index: 6,
                    codec: 'aac',
                    language: 'jpn',
                    languageCode: 'jpn',
                    displayTitle: 'Japanese',
                    channels: 2,
                    isDefault: true,
                },
            ],
            defaultAudioStreamIndex: 6,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(mediaSource, 5, {
            index: 5,
            codec: 'aac',
            language: 'eng',
            languageCode: 'eng',
            displayTitle: 'English',
            channels: 2,
            isDefault: false,
        });

        expect(resolved).toBe(5);
    });

    it('keeps current subtitle index when it still exists in the new source', () => {
        const mediaSource = createMediaSource({
            subtitleStreams: [
                createSubtitleTrack({
                    index: 11,
                    language: 'eng',
                    languageCode: 'eng',
                }),
                createSubtitleTrack({
                    index: 12,
                    language: 'deu',
                    languageCode: 'deu',
                }),
            ],
        });

        const resolved = resolveSubtitleTrackIndexForMediaSource(
            mediaSource,
            12,
            createSubtitleTrack({
                index: 12,
                language: 'deu',
                languageCode: 'deu',
            }),
        );

        expect(resolved).toBe(12);
    });

    it('falls back to the new media source default audio when no matching language remains', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 10,
                    codec: 'aac',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 6,
                    isDefault: true,
                },
                {
                    index: 11,
                    codec: 'aac',
                    language: 'fra',
                    languageCode: 'fra',
                    displayTitle: 'French',
                    channels: 2,
                    isDefault: false,
                },
            ],
            defaultAudioStreamIndex: 10,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(mediaSource, 3, {
            index: 3,
            codec: 'aac',
            language: 'jpn',
            languageCode: 'jpn',
            displayTitle: 'Japanese',
            channels: 2,
            isDefault: false,
        });

        expect(resolved).toBe(10);
    });

    it('falls back to source default audio when previousAudioTrack is undefined', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 10,
                    codec: 'aac',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 6,
                    isDefault: true,
                },
            ],
            defaultAudioStreamIndex: 10,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(mediaSource, 99, undefined);

        expect(resolved).toBe(10);
    });

    it('preserves subtitles-off across media source refreshes', () => {
        const mediaSource = createMediaSource({
            subtitleStreams: [createSubtitleTrack({ index: 11 })],
        });

        const resolved = resolveSubtitleTrackIndexForMediaSource(mediaSource, null, null);

        expect(resolved).toBeNull();
    });

    it('prefers language match over same-index match for subtitles (Lumastra version switch)', () => {
        // Scenario: v1 has German PGS at index 2, v2 has English SRT at
        // index 2 and German SRT at index 3. Switching from v1 -> v2
        // must follow the user's language choice, not the coincidental
        // index collision.
        const mediaSource = createMediaSource({
            subtitleStreams: [
                createSubtitleTrack({
                    index: 2,
                    codec: 'subrip',
                    language: 'eng',
                    languageCode: 'eng',
                }),
                createSubtitleTrack({
                    index: 3,
                    codec: 'subrip',
                    language: 'deu',
                    languageCode: 'deu',
                }),
            ],
        });

        const resolved = resolveSubtitleTrackIndexForMediaSource(
            mediaSource,
            2,
            createSubtitleTrack({
                index: 2,
                codec: 'pgssub',
                language: 'deu',
                languageCode: 'deu',
            }),
        );

        expect(resolved).toBe(3);
    });

    it('prefers language match over same-index match for audio (Lumastra version switch)', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 1,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    channels: 2,
                    isDefault: false,
                },
                {
                    index: 2,
                    codec: 'aac',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 6,
                    isDefault: false,
                },
            ],
        });

        const resolved = resolveAudioTrackIndexForMediaSource(mediaSource, 1, {
            index: 1,
            codec: 'truehd',
            language: 'deu',
            languageCode: 'deu',
            displayTitle: 'German',
            channels: 6,
            isDefault: false,
        });

        expect(resolved).toBe(2);
    });

    it('preserves index when both previous and new tracks have no language and sameFile=true', () => {
        // Same-file restart (e.g. quality change) with an untagged audio
        // track selected. With no language metadata we can't language-match,
        // but the audio-relative index is stable within a file — so we
        // should keep the user's selection instead of resetting to default.
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'ac3',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'AC3 5.1 @ 448 kbps',
                    channels: 6,
                    isDefault: true,
                },
                {
                    index: 1,
                    codec: 'ac3',
                    language: undefined,
                    languageCode: undefined,
                    displayTitle: 'AC3 5.1 @ 640 kbps',
                    channels: 6,
                    isDefault: false,
                },
            ],
        });

        const resolved = resolveAudioTrackIndexForMediaSource(
            mediaSource,
            1,
            {
                index: 1,
                codec: 'ac3',
                language: undefined,
                languageCode: undefined,
                displayTitle: 'AC3 5.1 @ 640 kbps',
                channels: 6,
                isDefault: false,
            },
            { sameFile: true },
        );

        expect(resolved).toBe(1);
    });

    it('falls to default when both languages unknown and sameFile=false (multi-version switch)', () => {
        // Cross-file switch where index 1 in the old file may have been
        // English but index 1 in the new file is unrelated content. We
        // can't safely fall back to index, so go to default.
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 2,
                    isDefault: false,
                },
                {
                    index: 1,
                    codec: 'aac',
                    language: undefined,
                    languageCode: undefined,
                    displayTitle: 'Untitled',
                    channels: 2,
                    isDefault: false,
                },
            ],
            defaultAudioStreamIndex: 0,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(
            mediaSource,
            1,
            {
                index: 1,
                codec: 'ac3',
                language: undefined,
                languageCode: undefined,
                displayTitle: 'Whatever',
                channels: 6,
                isDefault: false,
            },
            // omit options → sameFile defaults to false
        );

        expect(resolved).toBe(0);
    });

    it('falls to default when both languages unknown and sameFile=true but track index removed', () => {
        const mediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'ac3',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 6,
                    isDefault: true,
                },
                // index 1 no longer exists in this source
            ],
            defaultAudioStreamIndex: 0,
        });

        const resolved = resolveAudioTrackIndexForMediaSource(
            mediaSource,
            1,
            {
                index: 1,
                codec: 'ac3',
                language: undefined,
                languageCode: undefined,
                displayTitle: 'AC3 5.1 @ 640 kbps',
                channels: 6,
                isDefault: false,
            },
            { sameFile: true },
        );

        expect(resolved).toBe(0);
    });
});

describe('AUDIO_ONLY_PROFILE', () => {
    it('is a valid quality mode', () => {
        expect(QualityModeSchema.safeParse('audio-only').success).toBe(true);
    });
    it('carries no resolution and 128 kbps display metadata', () => {
        expect(AUDIO_ONLY_PROFILE.width).toBe(0);
        expect(AUDIO_ONLY_PROFILE.height).toBe(0);
        expect(AUDIO_ONLY_PROFILE.maxBitrate).toBe(128_000);
    });
});

describe('setQualityProfile audio-only mode', () => {
    it("sets qualityMode to 'audio-only' when selecting AUDIO_ONLY_PROFILE", () => {
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);
        expect(playerStore.qualityMode).toBe('audio-only');
    });
});

describe('previousQualityProfile', () => {
    it('remembers the profile that preceded audio-only', () => {
        playerStore.setQualityProfile(ORIGINAL_PROFILE);
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);
        expect(playerStore.previousQualityProfile?.mode).toBe('original');
    });
    it('does not overwrite itself on a repeat selection', () => {
        playerStore.setQualityProfile(ORIGINAL_PROFILE);
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);
        expect(playerStore.previousQualityProfile?.mode).toBe('original');

        // isSameQuality() already short-circuits an identical AUDIO_ONLY_PROFILE
        // re-selection before setQualityProfile's stash guard ever runs, so a
        // literal 3rd `setQualityProfile(AUDIO_ONLY_PROFILE)` call wouldn't
        // actually exercise the guard's `currentQualityProfile?.mode !==
        // 'audio-only'` condition. Force qualityMode out of step with
        // currentQualityProfile (as setQualityMode() alone can do in the real
        // store) so isSameQuality returns false and the call reaches the guard
        // while currentQualityProfile.mode is still 'audio-only'.
        playerStore.qualityMode = 'original';
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);
        expect(playerStore.previousQualityProfile?.mode).toBe('original');
    });
});

describe('setQualityProfile: audio-only is never persisted to the synced preference (Task 9)', () => {
    // Quality preferences sync per-user across every device the user owns.
    // Persisting an audio-only selection would follow the user to their TV
    // and, worse, round-trip through loadSavedQualityPreference() as a bogus
    // 1080p @ 128kbps transcode (see playerStore.setQualityProfile).
    const FIXED_4M_PROFILE = DEFAULT_TRANSCODING_PROFILES.find((p) => p.maxBitrate === 4_000_000)!;
    const FIXED_8M_PROFILE = DEFAULT_TRANSCODING_PROFILES.find((p) => p.maxBitrate === 8_000_000)!;

    afterEach(() => {
        // Reset the synced preference (not just the in-memory playerStore
        // fields the file-level afterEach already resets) so these tests
        // don't leak state into each other or into other describe blocks.
        updatePreference('qualityMode', 'original');
        updatePreference('maxBitrateBps', null);
        updatePreference('preferredResolution', null);
    });

    it('selecting audio-only writes nothing to the synced preference', () => {
        playerStore.setQualityProfile(FIXED_4M_PROFILE);
        expect(getPreferences().qualityMode).toBe('fixed');
        expect(getPreferences().maxBitrateBps).toBe(4_000_000);
        expect(getPreferences().preferredResolution).toBe(FIXED_4M_PROFILE.label);

        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);

        // In-memory session state DID switch to audio-only...
        expect(playerStore.qualityMode).toBe('audio-only');
        // ...but the synced preference is untouched.
        const prefs = getPreferences();
        expect(prefs.qualityMode).toBe('fixed');
        expect(prefs.maxBitrateBps).toBe(4_000_000);
        expect(prefs.preferredResolution).toBe(FIXED_4M_PROFILE.label);
    });

    it('a user with fixed @ 4 Mbps saved still has exactly that after an audio-only session', () => {
        playerStore.setQualityProfile(FIXED_4M_PROFILE);
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);

        const prefs = getPreferences();
        expect(prefs.qualityMode).toBe('fixed');
        expect(prefs.maxBitrateBps).toBe(4_000_000);
    });

    it('a user with original saved still has original after an audio-only session', () => {
        playerStore.setQualityProfile(ORIGINAL_PROFILE);
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);

        const prefs = getPreferences();
        expect(prefs.qualityMode).toBe('original');
        expect(prefs.maxBitrateBps).toBeNull();
    });

    it('selecting a normal rung after audio-only persists that new rung correctly', () => {
        playerStore.setQualityProfile(FIXED_4M_PROFILE);
        playerStore.setQualityProfile(AUDIO_ONLY_PROFILE);

        playerStore.setQualityProfile(FIXED_8M_PROFILE);

        expect(playerStore.qualityMode).toBe('fixed');
        const prefs = getPreferences();
        expect(prefs.qualityMode).toBe('fixed');
        expect(prefs.maxBitrateBps).toBe(8_000_000);
        expect(prefs.preferredResolution).toBe(FIXED_8M_PROFILE.label);
    });

    it("loadSavedQualityPreference can never yield an 'audio-only' mode", () => {
        // Defence-in-depth: even if 'audio-only' reaches the synced-preference
        // store's generic setter directly (bypassing setQualityProfile, e.g.
        // via an unsafe cast), the serialiser must not let it out, and the
        // reader must not adopt it as a session mode either.
        const AUDIO_ONLY_MODE = 'audio-only' as unknown as PlaybackPreferences['qualityMode'];
        updatePreference('qualityMode', AUDIO_ONLY_MODE);

        expect(getPreferences().qualityMode).not.toBe('audio-only');

        playerStore.loadSavedQualityPreference();
        expect(playerStore.qualityMode).not.toBe('audio-only');
    });
});

describe('setError clears the in-flight loading indicators', () => {
    // Every `.center-overlay` in PlayerOverlay.svelte is absolutely centered at
    // the same point, so two of them rendering at once physically overlap. A
    // stream teardown (policy block / kick / fatal hls.js error) stalls the
    // video element, so isBuffering is normally still true when the terminal
    // error lands — which drew the spinner and "Buffering" label right through
    // the error card and its Retry button.
    afterEach(() => {
        playerStore.setError(null);
        playerStore.isBuffering = false;
        playerStore.isLoading = false;
        playerStore.isReconnecting = false;
    });

    it('clears isBuffering, isLoading and isReconnecting when an error is set', () => {
        playerStore.isBuffering = true;
        playerStore.isLoading = true;
        playerStore.isReconnecting = true;

        playerStore.setError('Stream limit reached (2 of 2 streams in use).');

        expect(playerStore.error).toBe('Stream limit reached (2 of 2 streams in use).');
        expect(playerStore.isBuffering).toBe(false);
        expect(playerStore.isLoading).toBe(false);
        expect(playerStore.isReconnecting).toBe(false);
    });

    it('does not resurrect buffering state when the error is cleared', () => {
        playerStore.isBuffering = true;
        playerStore.setError('boom');
        playerStore.setError(null);

        expect(playerStore.error).toBeNull();
        expect(playerStore.isBuffering).toBe(false);
    });
});

function makeSource(opts: { audioIndexes: number[]; subtitleIndexes?: number[] }): MediaSourceInfo {
    return createMediaSource({
        audioStreams: opts.audioIndexes.map((index) => ({
            index,
            codec: 'aac',
            displayTitle: `Audio ${index}`,
            channels: 2,
            isDefault: index === opts.audioIndexes[0],
        })),
        defaultAudioStreamIndex: opts.audioIndexes[0],
        subtitleStreams: (opts.subtitleIndexes ?? []).map((index) =>
            createSubtitleTrack({
                index,
                isDefault: index === opts.subtitleIndexes?.[0],
            }),
        ),
        defaultSubtitleStreamIndex: opts.subtitleIndexes?.[0],
    });
}

describe('server track recommendation', () => {
    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = null;
        playerStore.audioSelectionReason = null;
        playerStore.audioSelectionLanguage = null;
    });

    it('applies the server recommendation when present', () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0, 1, 2] });
        playerStore.applyTrackRecommendation({
            audio_track_index: 2,
            reason: { audio: 'original-language', subtitle: 'off' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(2);
        expect(playerStore.audioSelectionReason).toBe('original-language');
    });

    it('resolves locally when the server expressed no opinion', () => {
        // The server omitted recommended_tracks because its preference load failed.
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0, 1, 2] });
        playerStore.applyTrackRecommendation(null);
        expect(playerStore.currentAudioTrackIndex).toBe(0); // file default
    });

    it('honours an explicit "no subtitle track" answer without falling back locally', () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0, 1] });
        playerStore.currentSubtitleTrackIndex = 5;
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'file-default', subtitle: 'none-available' },
        });
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    });

    it('applies both indices when the server resolves a subtitle track too', () => {
        playerStore.currentMediaSource = makeSource({
            audioIndexes: [0, 1],
            subtitleIndexes: [3],
        });
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 3,
            reason: { audio: 'learned', subtitle: 'saved-language' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.currentSubtitleTrackIndex).toBe(3);
    });
});

describe('applyTrackRecommendation: validates server indices against the live media source', () => {
    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = null;
        playerStore.audioSelectionReason = null;
        playerStore.audioSelectionLanguage = null;
    });

    it('falls back to the default audio track when the recommended index does not exist', () => {
        // audioIndexes[0] (0) is the media source's own default.
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0, 1] });
        playerStore.applyTrackRecommendation({
            audio_track_index: 99, // stale/mismatched — absent from this source
            reason: { audio: 'original-language', subtitle: 'off' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(0);
        // The discarded reason must not be attributed to the fallback pick.
        expect(playerStore.audioSelectionReason).toBeNull();
    });

    it('falls back to the default subtitle track when the recommended index does not exist', () => {
        playerStore.currentMediaSource = makeSource({
            audioIndexes: [0],
            subtitleIndexes: [11, 12], // 11 is the media source's own default
        });
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            subtitle_track_index: 99, // stale/mismatched — absent from this source
            reason: { audio: 'file-default', subtitle: 'saved-language' },
        });
        expect(playerStore.currentSubtitleTrackIndex).toBe(11);
    });

    it('still applies a valid audio index alongside a subtitle fallback (independent validation)', () => {
        playerStore.currentMediaSource = makeSource({
            audioIndexes: [0, 1],
            subtitleIndexes: [11],
        });
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 99,
            reason: { audio: 'learned', subtitle: 'saved-language' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.audioSelectionReason).toBe('learned');
        expect(playerStore.currentSubtitleTrackIndex).toBe(11);
    });
});

describe('applyTrackRecommendation: external sidecar subtitles the server could not see', () => {
    // The server resolves recommended_tracks from the PROBE's embedded subtitle
    // streams only — external sidecars live in `external_subtitle_files` and are
    // never handed to buildTrackRecommendation, because the `1000 + i` index
    // space they occupy is a client-side invention (buildLumastraSource) with no
    // representation on the wire. So on a file with English embedded subs and a
    // German .srt sidecar, a viewer whose subtitle language is German gets an
    // omitted `subtitle_track_index` — which the client used to read as the
    // authoritative "resolved: no subtitles".
    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = null;
        playerStore.audioSelectionReason = null;
        playerStore.audioSelectionLanguage = null;
        updatePreference('subtitleLanguage', null);
        updatePreference('subtitlesEnabled', false);
        updatePreference('subtitleTrackHint', null);
    });

    function sourceWithGermanSidecar(): MediaSourceInfo {
        return createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    displayTitle: 'Audio 0',
                    channels: 2,
                    isDefault: true,
                },
                {
                    index: 1,
                    codec: 'aac',
                    displayTitle: 'Audio 1',
                    channels: 2,
                    isDefault: false,
                },
            ],
            defaultAudioStreamIndex: 0,
            subtitleStreams: [
                createSubtitleTrack({ index: 3, language: 'eng', languageCode: 'eng' }),
                createSubtitleTrack({
                    index: 1000,
                    language: 'ger',
                    languageCode: 'ger',
                    displayTitle: 'GER',
                    isExternal: true,
                }),
            ],
            defaultSubtitleStreamIndex: 3,
        });
    }

    it('resolves the subtitle locally and selects the sidecar the server never saw', () => {
        updatePreference('subtitleLanguage', 'deu');
        updatePreference('subtitlesEnabled', true);
        playerStore.currentMediaSource = sourceWithGermanSidecar();

        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            // No subtitle_track_index: no GERMAN track exists among the embedded
            // streams the server could see.
            reason: { audio: 'file-default', subtitle: 'none-available' },
        });

        expect(playerStore.currentSubtitleTrackIndex).toBe(1000);
    });

    it("keeps the server's audio answer while re-resolving only the subtitle half", () => {
        updatePreference('subtitleLanguage', 'deu');
        updatePreference('subtitlesEnabled', true);
        playerStore.currentMediaSource = sourceWithGermanSidecar();

        playerStore.applyTrackRecommendation({
            // Index 1 is NOT what the local resolver would pick (it would take
            // the file default, 0) — so this asserts the fallback is
            // subtitle-only.
            audio_track_index: 1,
            reason: { audio: 'learned', subtitle: 'none-available' },
        });

        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.audioSelectionReason).toBe('learned');
        expect(playerStore.currentSubtitleTrackIndex).toBe(1000);
    });

    it('still honours "no subtitles" when the source carries no external subtitles', () => {
        // The common case, and the contract's intent: without a sidecar the
        // server saw everything there was to see.
        updatePreference('subtitleLanguage', 'deu');
        updatePreference('subtitlesEnabled', true);
        playerStore.currentMediaSource = makeSource({
            audioIndexes: [0, 1],
            subtitleIndexes: [3],
        });
        playerStore.currentSubtitleTrackIndex = 3;

        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'file-default', subtitle: 'none-available' },
        });

        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    });
});

describe('applyTrackRecommendation: forcedSubtitlesEnabled sync', () => {
    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.forcedSubtitlesEnabled = true;
        updatePreference('forcedSubtitlesEnabled', true);
    });

    it('syncs forcedSubtitlesEnabled from the saved preference when applying a server recommendation', () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        updatePreference('forcedSubtitlesEnabled', false);
        playerStore.forcedSubtitlesEnabled = true; // stale from a previous item

        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'file-default', subtitle: 'off' },
        });

        expect(playerStore.forcedSubtitlesEnabled).toBe(false);
    });
});

describe('applyTrackRecommendation: audioSelectionLanguage derivation', async () => {
    afterEach(async () => {
        playerStore.currentMediaSource = null;
        playerStore.audioSelectionReason = null;
        playerStore.audioSelectionLanguage = null;
        playerStore.originalLanguage = null;
        updatePreference('audioLanguage', null);
        updatePreference('lastAudioLanguage', null);
    });

    it("'original-language' reads playerStore.originalLanguage", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        playerStore.originalLanguage = 'jpn';
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'original-language', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBe('ja');
    });

    it("'original-language-untagged' also reads playerStore.originalLanguage", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        playerStore.originalLanguage = 'jpn';
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'original-language-untagged', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBe('ja');
    });

    it("'explicit-default' reads the saved audioLanguage preference, not lastAudioLanguage", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        updatePreference('audioLanguage', 'deu');
        updatePreference('lastAudioLanguage', 'fra');
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'explicit-default', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBe('de');
    });

    it("'explicit-default-untagged' also reads audioLanguage", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        updatePreference('audioLanguage', 'deu');
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'explicit-default-untagged', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBe('de');
    });

    it("'learned' reads lastAudioLanguage, not audioLanguage (the two are easy to transpose)", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        updatePreference('audioLanguage', 'deu');
        updatePreference('lastAudioLanguage', 'fra');
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'learned', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBe('fr');
    });

    it("'file-default' and 'no-match-file-default' carry no language", async () => {
        playerStore.currentMediaSource = makeSource({ audioIndexes: [0] });
        playerStore.originalLanguage = 'jpn';
        updatePreference('audioLanguage', 'deu');

        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'file-default', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBeNull();

        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 0,
            reason: { audio: 'no-match-file-default', subtitle: 'off' },
        });
        expect(playerStore.audioSelectionLanguage).toBeNull();
    });
});

describe('loadSavedTrackPreferences: subtitle resolution goes through the shared resolveTracks', () => {
    // Round-2 refactor: the subtitle half used to be an inline duplicate of
    // the same 4-step priority `resolveTracks` (in $lib/shared/track-selection)
    // implements for the server's recommended_tracks. These tests exercise
    // loadSavedTrackPreferences() directly (nothing else in this file did)
    // to prove the port didn't silently change behaviour.
    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = null;
        playerStore.audioSelectionReason = null;
        playerStore.audioSelectionLanguage = null;
        playerStore.originalLanguage = null;
        playerStore.forcedSubtitlesEnabled = true;
        updatePreference('preferOriginalAudio', false);
        updatePreference('audioLanguage', null);
        updatePreference('lastAudioLanguage', null);
        updatePreference('subtitleLanguage', null);
        updatePreference('subtitlesEnabled', true);
        updatePreference('forcedSubtitlesEnabled', true);
        updatePreference('subtitleTrackHint', null);
    });

    // The commentary/AD filter lives in the shared resolver, so the client gets
    // it only if it actually hands the resolver a `title`. It did not: the
    // client's audioStreams folded the raw title into `displayTitle` and
    // dropped `.title`, so every track looked untitled and nothing was ever
    // filtered. That also opened a server/client divergence the plan's Known
    // Risk did not cover — loadSavedTrackPreferences runs first on mount, and
    // is the whole answer whenever `recommended_tracks` is absent.
    it('does not auto-select a commentary track (client-side resolver)', () => {
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    title: "Director's Commentary",
                    displayTitle: "Director's Commentary",
                    channels: 2,
                    isDefault: true,
                },
                {
                    index: 1,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    title: 'English 5.1',
                    displayTitle: 'English 5.1',
                    channels: 6,
                    isDefault: false,
                },
            ],
            subtitleStreams: [],
        });
        updatePreference('audioLanguage', 'eng');

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentAudioTrackIndex).toBe(1);
    });

    it('still picks a commentary track when it is the only one', () => {
        // Never filter away every candidate — silence is worse.
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    title: 'Commentary',
                    displayTitle: 'Commentary',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [],
        });
        updatePreference('audioLanguage', 'eng');

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentAudioTrackIndex).toBe(0);
    });

    it('matches the saved subtitleTrackHint exactly (lang+forced+codec)', () => {
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [
                createSubtitleTrack({
                    index: 5,
                    language: 'eng',
                    languageCode: 'eng',
                    codec: 'subrip',
                }),
                createSubtitleTrack({
                    index: 6,
                    language: 'deu',
                    languageCode: 'deu',
                    codec: 'ass',
                }),
            ],
        });
        updatePreference('subtitlesEnabled', true);
        updatePreference('subtitleTrackHint', { language: 'deu', isForced: false, codec: 'ass' });

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentSubtitleTrackIndex).toBe(6);
    });

    it('falls back to a forced subtitle matching the resolved audio language', () => {
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'jpn',
                    languageCode: 'jpn',
                    displayTitle: 'Japanese',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [
                createSubtitleTrack({
                    index: 7,
                    language: 'jpn',
                    languageCode: 'jpn',
                    isForced: true,
                    displayTitle: 'Japanese [Forced]',
                }),
            ],
        });
        updatePreference('subtitlesEnabled', true);
        updatePreference('forcedSubtitlesEnabled', true);

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentSubtitleTrackIndex).toBe(7);
    });

    it('honours the title-only forced heuristic (isForced false, "forced" in the display title)', () => {
        // Proves the subtitle candidates built for resolveTracks map `title`
        // from `displayTitle` — mapping the optional raw `.title` field
        // instead (always unset for Lumastra-built subtitle streams) would
        // silently drop this match and fail this test.
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'deu',
                    languageCode: 'deu',
                    displayTitle: 'German',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [
                createSubtitleTrack({
                    index: 9,
                    language: 'deu',
                    languageCode: 'deu',
                    isForced: false,
                    displayTitle: 'German (Forced)',
                }),
            ],
        });
        updatePreference('subtitlesEnabled', true);
        updatePreference('forcedSubtitlesEnabled', true);

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentSubtitleTrackIndex).toBe(9);
    });

    it('matches a saved subtitle language when no hint is set', () => {
        playerStore.currentMediaSource = createMediaSource({
            audioStreams: [
                {
                    index: 0,
                    codec: 'aac',
                    language: 'eng',
                    languageCode: 'eng',
                    displayTitle: 'English',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [
                createSubtitleTrack({ index: 3, language: 'fra', languageCode: 'fra' }),
            ],
        });
        updatePreference('subtitlesEnabled', true);
        updatePreference('forcedSubtitlesEnabled', false);
        updatePreference('subtitleLanguage', 'fra');

        playerStore.loadSavedTrackPreferences();

        expect(playerStore.currentSubtitleTrackIndex).toBe(3);
    });
});

describe('external control (series-marker re-check bridge)', () => {
    it('seeks and reports the session only through a bound, ready player', () => {
        expect(playerStore.seekExternally(10)).toBe(false);
        expect(playerStore.reportedSessionId()).toBeNull();

        const seeks: number[] = [];
        let ready = false;
        const unbind = playerStore.bindExternalControl({
            isReady: () => ready,
            seekTo: (s) => seeks.push(s),
            sessionId: () => 'sess-1',
        });
        expect(playerStore.reportedSessionId()).toBe('sess-1');
        expect(playerStore.seekExternally(10)).toBe(false);
        ready = true;
        expect(playerStore.seekExternally(1320)).toBe(true);
        expect(seeks).toEqual([1320]);

        unbind();
        expect(playerStore.seekExternally(5)).toBe(false);
        expect(playerStore.reportedSessionId()).toBeNull();
    });

    it('a stale unbind does not drop a newer binding', () => {
        const unbindOld = playerStore.bindExternalControl({
            isReady: () => true,
            seekTo: () => {},
            sessionId: () => 'old',
        });
        const unbindNew = playerStore.bindExternalControl({
            isReady: () => true,
            seekTo: () => {},
            sessionId: () => 'new',
        });
        unbindOld();
        expect(playerStore.reportedSessionId()).toBe('new');
        unbindNew();
    });

    it('session-rebuild listeners fire until unsubscribed', () => {
        let calls = 0;
        const unsubscribe = playerStore.onSessionRebuilt(() => calls++);
        playerStore.notifySessionRebuilt();
        expect(calls).toBe(1);
        unsubscribe();
        playerStore.notifySessionRebuilt();
        expect(calls).toBe(1);
    });
});

describe('setAudioTrack: forced subtitles follow the audio language (S10)', () => {
    const audio = (index: number, language: string) => ({
        index,
        codec: 'eac3',
        language,
        languageCode: language,
        displayTitle: language,
        channels: 6,
        isDefault: index === 0,
    });
    const source = () =>
        createMediaSource({
            audioStreams: [audio(0, 'ger'), audio(1, 'eng')],
            subtitleStreams: [
                createSubtitleTrack({
                    index: 10,
                    language: 'ger',
                    languageCode: 'ger',
                    isForced: true,
                    displayTitle: 'GER [Forced]',
                }),
                createSubtitleTrack({ index: 11, language: 'ger', languageCode: 'ger' }),
                createSubtitleTrack({ index: 12, language: 'eng', languageCode: 'eng' }),
            ],
        });

    afterEach(() => {
        playerStore.currentMediaSource = null;
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = null;
        playerStore.subtitlePickedByUser = false;
        playerStore.forcedSubtitlesEnabled = true;
        updatePreference('lastAudioLanguage', null);
        updatePreference('subtitlesEnabled', true);
    });

    it('drops an automatically picked forced track that does not match the new audio', () => {
        playerStore.currentMediaSource = source();
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = 10; // auto: forced-for-audio (German)
        playerStore.subtitlePickedByUser = false;

        playerStore.setAudioTrack(1); // English

        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    });

    it('keeps a forced track the viewer picked by hand', () => {
        playerStore.currentMediaSource = source();
        playerStore.currentAudioTrackIndex = 0;
        playerStore.setSubtitleTrack(10); // explicit

        playerStore.setAudioTrack(1);

        expect(playerStore.currentSubtitleTrackIndex).toBe(10);
    });

    it('keeps a full subtitle track across an audio switch', () => {
        playerStore.currentMediaSource = source();
        playerStore.currentAudioTrackIndex = 0;
        playerStore.currentSubtitleTrackIndex = 12;

        playerStore.setAudioTrack(1);

        expect(playerStore.currentSubtitleTrackIndex).toBe(12);
    });

    it('turns the matching forced track on when switching back', () => {
        playerStore.currentMediaSource = source();
        playerStore.currentAudioTrackIndex = 1;
        playerStore.currentSubtitleTrackIndex = null;

        playerStore.setAudioTrack(0);

        expect(playerStore.currentSubtitleTrackIndex).toBe(10);
        expect(playerStore.subtitlePickedByUser).toBe(false);
    });
});

describe('selected-file timeline', () => {
    afterEach(() => {
        playerStore.mediaSegments = [];
        playerStore.chapters = [];
        playerStore.trickplayVariants = [];
        playerStore.playheadTime = 0;
    });

    it('compares millisecond skip markers against the media playhead in seconds', () => {
        playerStore.mediaSegments = [{ type: 'intro', startMs: 60_000, endMs: 90_000 }];
        playerStore.playheadTime = 59.49;
        expect(playerStore.activeSegment).toBeNull();
        playerStore.playheadTime = 60;
        expect(playerStore.activeSegment).toEqual({
            type: 'intro',
            startMs: 60_000,
            endMs: 90_000,
        });
        playerStore.playheadTime = 90.71;
        expect(playerStore.activeSegment).toBeNull();
    });

    it('clears chapters, skip markers, and manifest variants when the player resets', () => {
        playerStore.chapters = [
            { index: 0, name: 'Opening', startMs: 0, endMs: 90_000, image: null },
        ];
        playerStore.mediaSegments = [{ type: 'outro', startMs: 60_000, endMs: 90_000 }];
        playerStore.trickplayVariants = [{ width: 320, manifestHref: '/ready/manifest' }];
        playerStore.reset();
        expect(playerStore.chapters).toEqual([]);
        expect(playerStore.mediaSegments).toEqual([]);
        expect(playerStore.trickplayVariants).toEqual([]);
    });
});

describe('cross-file audio role and unknown-language identity R03/R04', () => {
    const audio = (index: number, language: string, title: string, isDefault = false) => ({
        index,
        absoluteIndex: index + 1,
        language,
        title,
        displayTitle: title,
        codec: 'aac',
        channels: 2,
        isDefault,
    });
    const source = (audioStreams: MediaSourceInfo['audioStreams']): MediaSourceInfo => ({
        id: 'next',
        name: '',
        path: '',
        container: 'mkv',
        size: 1,
        bitrate: 1,
        supportsDirectPlay: true,
        supportsDirectStream: true,
        supportsTranscoding: true,
        videoStreams: [],
        subtitleStreams: [],
        audioStreams,
    });
    it.each(['Main mix', 'Audio Description', 'Director Commentary'])(
        'preserves the %s role instead of taking the first language match',
        (title) => {
            const previous = audio(2, 'en', title);
            const tracks = [
                audio(0, 'en', 'Director Commentary'),
                audio(1, 'en', 'Audio Description'),
                audio(2, 'en', 'Main mix', true),
            ];
            expect(
                resolveAudioTrackIndexForMediaSource(source(tracks), previous.index, previous, {
                    sameFile: false,
                }),
            ).toBe(title === 'Main mix' ? 2 : title === 'Audio Description' ? 1 : 0);
        },
    );
    it.each(['und', 'mul', 'mis', 'zxx'])(
        'never matches unknown %s tags across different files',
        (language) => {
            const next = source([audio(0, 'en', 'Main mix', true), audio(1, language, 'Unknown')]);
            const previous = audio(1, language, 'Old unknown');
            expect(
                resolveAudioTrackIndexForMediaSource(next, 1, previous, { sameFile: false }),
            ).toBe(0);
            expect(
                resolveAudioTrackIndexForMediaSource(next, 1, previous, { sameFile: true }),
            ).toBe(1);
        },
    );
});
