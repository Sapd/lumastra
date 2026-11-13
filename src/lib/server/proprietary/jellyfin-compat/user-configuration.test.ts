// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildLanguageConfiguration, type UserPlaybackPreferences } from './user-configuration';
import { serializeUser } from './serializers/user';

function prefs(p: Partial<UserPlaybackPreferences>): UserPlaybackPreferences {
    return {
        audio_language: null,
        last_audio_language: null,
        subtitle_language: null,
        subtitles_enabled: true,
        forced_subtitles_enabled: true,
        subtitle_track_hint: null,
        ...p,
    };
}

describe('buildLanguageConfiguration', () => {
    it('no saved preferences: Jellyfin defaults', () => {
        expect(buildLanguageConfiguration(null)).toEqual({
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: '',
            SubtitleMode: 'Default',
        });
    });

    it('maps languages to the ISO 639-2/T codes Jellyfin 10.11+ uses', () => {
        expect(
            buildLanguageConfiguration(prefs({ audio_language: 'de', subtitle_language: 'en' })),
        ).toEqual({
            AudioLanguagePreference: 'deu',
            PlayDefaultAudioTrack: false,
            SubtitleLanguagePreference: 'eng',
            SubtitleMode: 'Always',
        });
    });

    it('a learned audio language is the preference but keeps the default track', () => {
        expect(buildLanguageConfiguration(prefs({ last_audio_language: 'ja' }))).toMatchObject({
            AudioLanguagePreference: 'jpn',
            PlayDefaultAudioTrack: true,
        });
    });

    it('subtitles off: None, or OnlyForced while forced subtitles stay on', () => {
        expect(
            buildLanguageConfiguration(
                prefs({ subtitles_enabled: false, forced_subtitles_enabled: false }),
            ).SubtitleMode,
        ).toBe('None');
        expect(
            buildLanguageConfiguration(
                prefs({ subtitles_enabled: false, forced_subtitles_enabled: true }),
            ).SubtitleMode,
        ).toBe('OnlyForced');
    });

    it('falls back to the remembered non-forced subtitle track language', () => {
        expect(
            buildLanguageConfiguration(
                prefs({ subtitle_track_hint: { language: 'fr', isForced: false, codec: null } }),
            ),
        ).toMatchObject({ SubtitleLanguagePreference: 'fra', SubtitleMode: 'Always' });
        expect(
            buildLanguageConfiguration(
                prefs({ subtitle_track_hint: { language: 'fr', isForced: true, codec: null } }),
            ),
        ).toMatchObject({ SubtitleLanguagePreference: '', SubtitleMode: 'Default' });
    });

    it('ignores values that name no language', () => {
        expect(
            buildLanguageConfiguration(
                prefs({ audio_language: 'original', subtitle_language: 'und' }),
            ),
        ).toEqual({
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: '',
            SubtitleMode: 'Default',
        });
    });
});

describe('serializeUser Configuration', () => {
    const user = { id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff', username: 'u', is_admin: false };

    it('carries the playback preferences', () => {
        const dto = serializeUser(user, prefs({ audio_language: 'de', subtitles_enabled: false }));
        expect(dto.Configuration).toMatchObject({
            AudioLanguagePreference: 'deu',
            PlayDefaultAudioTrack: false,
            SubtitleMode: 'OnlyForced',
            HidePlayedInLatest: true,
        });
    });

    it('without preferences keeps the defaults', () => {
        expect(serializeUser(user).Configuration).toMatchObject({
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: '',
            SubtitleMode: 'Default',
        });
        expect(serializeUser(user).Configuration).not.toHaveProperty('AudioLanguagePreference');
    });
});
