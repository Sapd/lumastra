// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import TrackSelector from './TrackSelector.svelte';
import { PlayerStore, playerStore } from './playerStore.svelte';
import {
    getPreferences,
    updatePreferences,
    playbackPreferences,
    selectionPreferenceSnapshot,
} from './preferences-sync.svelte';
import { playbackPreferencesSchema, subtitleTrackHintSchema } from '$lib/schemas/user';
import { analyzeSubtitleStream } from './subtitle-utils';
import type { MediaSourceInfo, SubtitleStreamInfo } from '$lib/types/playback';

const api = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue({ data: {}, error: null }) }));
vi.mock('$lib/api/user', () => ({
    updatePlaybackPreferences: api.update,
    getPlaybackPreferences: vi.fn().mockResolvedValue({ data: null, error: null }),
}));
const initial = getPreferences();
function subtitle(
    index: number,
    title: string,
    codec = 'subrip',
    language = 'eng',
): SubtitleStreamInfo {
    return {
        id: `stable-${index}`,
        index,
        title,
        displayTitle: title,
        codec,
        language,
        isDefault: false,
        isForced: false,
        isExternal: false,
        isTextSubtitleStream: true,
        supportsExternalStream: true,
    };
}
function source(id = 'file-1'): MediaSourceInfo {
    return {
        id,
        name: 'Test',
        path: '/test',
        container: 'mkv',
        size: 1,
        bitrate: 1,
        supportsDirectPlay: true,
        supportsDirectStream: true,
        supportsTranscoding: true,
        videoStreams: [],
        defaultAudioStreamIndex: 0,
        audioStreams: [
            {
                index: 0,
                language: 'eng',
                codec: 'aac',
                channels: 2,
                displayTitle: 'English',
                isDefault: true,
            },
            {
                index: 1,
                language: 'deu',
                codec: 'aac',
                channels: 2,
                displayTitle: 'German',
                isDefault: false,
            },
        ],
        subtitleStreams: [
            subtitle(2, 'English'),
            subtitle(3, 'English SDH'),
            subtitle(4, 'English Forced'),
            subtitle(5, 'German Forced', 'subrip', 'deu'),
        ],
    };
}
beforeEach(async () => {
    updatePreferences({
        ...initial,
        subtitlesEnabled: true,
        forcedSubtitlesEnabled: true,
        subtitleTrackHint: null,
        subtitleLanguage: null,
    });
    await playbackPreferences.forceSyncToServer();
    api.update.mockClear();
    playerStore.currentMediaSource = source();
    playerStore.currentAudioTrackIndex = 0;
    playerStore.currentSubtitleTrackIndex = null;
    playerStore.subtitlePickedByUser = false;
    playerStore.forcedSubtitlesEnabled = true;
});
afterEach(() => {
    cleanup();
    playerStore.reset();
});

describe('subtitle preference and source boundaries B1/B4/B6–B9/G3', () => {
    it('automatic forced toggles preserve the independent full-caption preference and disabling is durable', () => {
        updatePreferences({
            subtitleLanguage: 'eng',
            subtitleTrackHint: {
                language: 'eng',
                isForced: false,
                codec: 'subrip',
                title: 'English SDH',
            },
        });
        playerStore.setForcedSubtitlesEnabled(true);
        expect(playerStore.currentSubtitleTrackIndex).toBe(4);
        expect(getPreferences().subtitleTrackHint?.title).toBe('English SDH');
        playerStore.setForcedSubtitlesEnabled(false);
        const fresh = new PlayerStore();
        fresh.currentMediaSource = source();
        fresh.loadSavedTrackPreferences();
        expect(fresh.currentSubtitleTrackIndex).toBe(3);
    });
    it('real forced toggle persists its independent role, and disabling remains Off on fresh playback', async () => {
        const { getByRole } = render(TrackSelector);
        const toggle = getByRole('button', { name: /Forced subtitles/i });
        await fireEvent.click(toggle);
        await fireEvent.click(toggle);
        expect(playerStore.currentSubtitleTrackIndex).toBe(4);
        await playbackPreferences.forceSyncToServer();
        const { writeOrder, ...savedToggle } = playbackPreferencesSchema.parse(
            api.update.mock.calls.at(-1)![0],
        );
        expect(savedToggle).toEqual({ forcedSubtitlesEnabled: true });
        expect(Object.keys(writeOrder!.fields)).toEqual(['forcedSubtitlesEnabled']);
        const fresh = new PlayerStore();
        fresh.currentMediaSource = source();
        fresh.loadSavedTrackPreferences();
        expect(fresh.currentSubtitleTrackIndex).toBe(4);
        await fireEvent.click(toggle);
        await playbackPreferences.forceSyncToServer();
        fresh.loadSavedTrackPreferences();
        expect(fresh.currentSubtitleTrackIndex).toBeNull();
    });
    it('version switching re-resolves automatic forced subtitles for newly resolved audio while preserving manual picks', () => {
        playerStore.currentAudioTrackIndex = 1;
        playerStore.currentSubtitleTrackIndex = 5;
        const next = source('file-2');
        next.audioStreams = [next.audioStreams[0]];
        playerStore.updateCurrentMediaSource(next);
        expect(playerStore.currentAudioTrackIndex).toBe(0);
        expect(playerStore.currentSubtitleTrackIndex).toBe(4);
        playerStore.currentMediaSource = source();
        playerStore.currentAudioTrackIndex = 1;
        playerStore.setSubtitleTrack(5);
        playerStore.updateCurrentMediaSource(next);
        expect(playerStore.currentSubtitleTrackIndex).toBe(5);
    });
    it('chooses a preferred sidecar over a nonempty embedded fallback using the server-adopted audio', async () => {
        const sidecar = subtitle(1000, 'German SDH', 'subrip', 'deu');
        sidecar.isExternal = true;
        playerStore.currentMediaSource!.subtitleStreams.push(sidecar);
        updatePreferences({ subtitleLanguage: 'deu' });
        await playbackPreferences.forceSyncToServer();
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 4,
            reason: { audio: 'file-default', subtitle: 'forced-for-audio' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.currentSubtitleTrackIndex).toBe(1000);
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            reason: { audio: 'file-default', subtitle: 'off' },
        });
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    });
    it('retains the server-inferred language of adopted untagged audio when sidecars require local subtitle resolution', async () => {
        updatePreferences({
            audioLanguage: 'deu',
            subtitleLanguage: null,
            subtitleTrackHint: null,
        });
        await playbackPreferences.forceSyncToServer();
        playerStore.currentMediaSource!.audioStreams[1].language = undefined;
        playerStore.currentMediaSource!.subtitleStreams.push({
            ...subtitle(1000, 'English Sidecar'),
            isExternal: true,
        });
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 5,
            reason: { audio: 'explicit-default-untagged', subtitle: 'forced-for-audio' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.audioSelectionLanguage).toBe('de');
        expect(playerStore.currentSubtitleTrackIndex).toBe(5);
        playerStore.setForcedSubtitlesEnabled(false);
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
        playerStore.setForcedSubtitlesEnabled(true);
        expect(playerStore.currentSubtitleTrackIndex).toBe(5);
    });
    it('dirty local subtitle preferences beat an old recommendation without replacing clean server audio', () => {
        updatePreferences({
            subtitleLanguage: 'eng',
            subtitlesEnabled: true,
            subtitleTrackHint: {
                language: 'eng',
                isForced: false,
                codec: 'subrip',
                title: 'English SDH',
            },
        });
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 4,
            reason: { audio: 'file-default', subtitle: 'forced-for-audio' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.currentSubtitleTrackIndex).toBe(3);
    });
    it('a dirty-at-request snapshot remains stale after the save finishes before response adoption', async () => {
        updatePreferences({
            subtitleLanguage: 'eng',
            subtitleTrackHint: {
                language: 'eng',
                isForced: false,
                codec: 'subrip',
                title: 'English SDH',
            },
        });
        const preferenceSnapshot = selectionPreferenceSnapshot();
        await playbackPreferences.forceSyncToServer();
        expect(selectionPreferenceSnapshot().subtitleDirty).toBe(false);
        playerStore.applyTrackRecommendation({
            preferenceSnapshot,
            audio_track_index: 1,
            subtitle_track_index: 4,
            reason: { audio: 'file-default', subtitle: 'forced-for-audio' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.currentSubtitleTrackIndex).toBe(3);
    });
    it('dirty local audio preferences replace server audio before forced matching', () => {
        updatePreferences({ audioLanguage: 'eng' });
        playerStore.applyTrackRecommendation({
            audio_track_index: 1,
            subtitle_track_index: 5,
            reason: { audio: 'file-default', subtitle: 'forced-for-audio' },
        });
        expect(playerStore.currentAudioTrackIndex).toBe(0);
        expect(playerStore.currentSubtitleTrackIndex).toBe(4);
    });
    it('different files preserve the closest codec and SDH edition rather than the first language match', () => {
        playerStore.currentMediaSource!.subtitleStreams.push(subtitle(6, 'English SDH', 'ass'));
        playerStore.setSubtitleTrack(6);
        const next = source('file-2');
        next.subtitleStreams.unshift(subtitle(9, 'English SDH', 'ass'));
        playerStore.updateCurrentMediaSource(next);
        expect(playerStore.currentSubtitleTrackIndex).toBe(9);
    });
    it('does not adopt a forced file default when a selected edition is absent and forced captions are disabled', () => {
        playerStore.setSubtitleTrack(3);
        playerStore.setForcedSubtitlesEnabled(false);
        const next = source('file-2');
        next.subtitleStreams = [subtitle(9, 'German Forced', 'subrip', 'deu')];
        next.defaultSubtitleStreamIndex = 9;
        playerStore.updateCurrentMediaSource(next);
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    });
    it.each([
        { index: 3, title: 'English SDH', codec: 'subrip' },
        { index: 6, title: 'English SDH ASS', codec: 'ass' },
    ])(
        'round-trips a real menu pick $title through persistence schema into a fresh playback, then Off clears it',
        async ({ index, title, codec }) => {
            if (index === 6)
                playerStore.currentMediaSource!.subtitleStreams.push(subtitle(6, title, codec));
            const { container } = render(TrackSelector);
            const selected = container.querySelector<HTMLButtonElement>(
                `.subtitle-list button[aria-label*="${title}"]`,
            );
            expect(selected).not.toBeNull();
            await fireEvent.click(selected!);
            await playbackPreferences.forceSyncToServer();
            const persisted = playbackPreferencesSchema.parse(api.update.mock.calls.at(-1)![0]);
            expect(persisted.forcedSubtitlesEnabled).toBe(true);
            expect(persisted.subtitleTrackHint).toEqual({
                language: 'en',
                isForced: false,
                codec,
                title,
                fileId: 'file-1',
                trackId: `stable-${index}`,
            });
            expect(
                subtitleTrackHintSchema.parse({ language: 'en', isForced: false, codec: 'subrip' }),
            ).toEqual({ language: 'en', isForced: false, codec: 'subrip' });
            updatePreferences({
                subtitleLanguage: persisted.subtitleLanguage,
                subtitleTrackHint: persisted.subtitleTrackHint,
                subtitlesEnabled: persisted.subtitlesEnabled,
                forcedSubtitlesEnabled: persisted.forcedSubtitlesEnabled,
            });
            const fresh = new PlayerStore();
            fresh.currentMediaSource = source();
            if (index === 6)
                fresh.currentMediaSource.subtitleStreams.push(subtitle(6, title, codec));
            fresh.loadSavedTrackPreferences();
            expect(fresh.currentSubtitleTrackIndex).toBe(index);
            const off = container.querySelector<HTMLButtonElement>('.subtitle-list button');
            await fireEvent.click(off!);
            await playbackPreferences.forceSyncToServer();
            const disabled = playbackPreferencesSchema.parse(api.update.mock.calls.at(-1)![0]);
            expect(disabled).toMatchObject({
                subtitlesEnabled: false,
                subtitleLanguage: null,
                subtitleTrackHint: null,
            });
            // Forced matching remains independent (P1); disable its separate toggle for a wholly-off fresh playback.
            updatePreferences({
                subtitleLanguage: disabled.subtitleLanguage,
                subtitleTrackHint: disabled.subtitleTrackHint,
                subtitlesEnabled: disabled.subtitlesEnabled,
                forcedSubtitlesEnabled: false,
            });
            fresh.loadSavedTrackPreferences();
            expect(fresh.currentSubtitleTrackIndex).toBeNull();
        },
    );
});

it.each(['pgs', 'ass', 'vobsub', 'subrip'])(
    'started Encode owns %s even with a client resource present (B10)',
    (codec) => {
        expect(
            analyzeSubtitleStream({
                ...subtitle(1, 'English', codec),
                deliveryMethod: 'Encode',
                hrefs: { raw: '/raw' },
            }),
        ).toMatchObject({
            renderMethod: 'burn-in',
            requiresBurnIn: true,
            canRenderClientSide: false,
        });
    },
);

it('real audio menu saves learned language, retains the explicit default, and restores it for a fresh player', async () => {
    updatePreferences({ preferOriginalAudio: false, audioLanguage: 'fr', lastAudioLanguage: null });
    await playbackPreferences.forceSyncToServer();
    api.update.mockClear();
    const unknown = {
        ...source().audioStreams[0],
        index: 2,
        language: 'und',
        displayTitle: 'Unknown mix',
    };
    playerStore.currentMediaSource!.audioStreams.push(unknown);
    const { container } = render(TrackSelector);
    const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.audio-section button'),
    );
    const german = buttons.find((button) => button.textContent?.includes('German'))!;
    expect(german).toBeDefined();
    await fireEvent.click(german);
    await playbackPreferences.forceSyncToServer();
    expect(api.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ lastAudioLanguage: 'de' }),
        { keepalive: true },
    );
    expect(getPreferences().audioLanguage).toBe('fr');
    const unknownButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.audio-section button'),
    ).find((button) => button.textContent?.includes('Unknown mix'))!;
    await fireEvent.click(unknownButton);
    await playbackPreferences.forceSyncToServer();
    expect(getPreferences().lastAudioLanguage).toBe('de');
    expect(api.update).toHaveBeenCalledTimes(1);
    const fresh = new PlayerStore();
    fresh.currentMediaSource = source();
    fresh.loadSavedTrackPreferences();
    expect(fresh.currentAudioTrackIndex).toBe(1);
});

it('unsupported Drop sidecars cannot be selected, auto matched, or offered by the real menu', async () => {
    const unavailable = {
        ...subtitle(20, 'Unavailable bitmap', 'pgs', 'eng'),
        isExternal: true,
        isForced: true,
        isTextSubtitleStream: false,
        supportsExternalStream: false,
        deliveryMethod: 'Drop' as const,
        isDefault: true,
    };
    playerStore.currentMediaSource!.subtitleStreams = [unavailable];
    playerStore.currentMediaSource!.defaultSubtitleStreamIndex = 20;
    updatePreferences({
        subtitleLanguage: 'en',
        subtitleTrackHint: { language: 'en', isForced: true, codec: 'pgs' },
    });
    playerStore.loadSavedTrackPreferences();
    expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    playerStore.setSubtitleTrack(20);
    expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    playerStore.setAudioTrack(0);
    playerStore.setForcedSubtitlesEnabled(true);
    expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    const { queryByRole } = render(TrackSelector);
    expect(queryByRole('button', { name: /Unavailable bitmap/ })).toBeNull();
    expect(
        analyzeSubtitleStream({ ...unavailable, codec: 'dvb_subtitle', deliveryMethod: undefined })
            .renderMethod,
    ).toBe('burn-in');
});

it('retains inference and reason on same-file audio adoption, clears them when identity changes', () => {
    const selected = playerStore.currentMediaSource!.audioStreams[1];
    selected.absoluteIndex = 4;
    selected.language = undefined;
    playerStore.currentAudioTrackIndex = 1;
    playerStore.audioSelectionLanguage = 'de';
    playerStore.audioSelectionReason = 'explicit-default-untagged';
    const refreshed = source();
    refreshed.audioStreams[1] = { ...selected, index: 9 };
    playerStore.updateCurrentMediaSource(refreshed);
    expect(playerStore.currentAudioTrackIndex).toBe(9);
    expect(playerStore.audioSelectionLanguage).toBe('de');
    expect(playerStore.audioSelectionReason).toBe('explicit-default-untagged');
    playerStore.setForcedSubtitlesEnabled(false);
    playerStore.setForcedSubtitlesEnabled(true);
    expect(playerStore.currentSubtitleTrackIndex).toBe(5);
    playerStore.updateCurrentMediaSource(source('another-file'));
    expect(playerStore.audioSelectionLanguage).toBeNull();
});

it('the real make-default shortcut saves a qualified language over a base default and selects that rendition on next playback', async () => {
    updatePreferences({ audioLanguage: 'en', preferOriginalAudio: false, lastAudioLanguage: null });
    const media = source();
    media.audioStreams = media.audioStreams.map((track, i) => ({
        ...track,
        language: i === 0 ? 'en' : 'en-US',
        displayTitle: i === 0 ? 'English' : 'US mix',
    }));
    playerStore.currentMediaSource = media;
    playerStore.setAudioTrack(1);
    await playbackPreferences.forceSyncToServer();
    const { container } = render(TrackSelector);
    const shortcut = container.querySelector<HTMLButtonElement>('.audio-note-action');
    expect(shortcut).not.toBeNull();
    await fireEvent.click(shortcut!);
    await playbackPreferences.forceSyncToServer();
    expect(api.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ audioLanguage: 'en-us' }),
        { keepalive: true },
    );
    expect(JSON.parse(localStorage.getItem('playerPreferences')!).audioLanguage).toBe('en-us');
    const next = new PlayerStore();
    next.currentMediaSource = media;
    next.loadSavedTrackPreferences();
    expect(next.currentAudioTrackIndex).toBe(1);
});
