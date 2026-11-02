// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Pure helpers behind the cloud-parity brief 06 endpoints. Route behaviour is
// covered in src/routes/(proprietary)/j/misc-client.integration.test.ts.

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildItemImageInfos } from './item-images';
import { likesFromRating, parseLikes } from './user-rating';
import type { RequestEvent } from '@sveltejs/kit';
import { quickConnectAuthorizeRateLimitKey } from './quick-connect-authorize';
import {
    preferencesFromUserConfiguration,
    reportedPlaybackConfiguration,
} from './user-configuration';
import { decodeUploadedImage } from './user-avatar';
import { isOtherUser } from './self-user';
import { parseYear, serializeYear, yearItemId } from './years';
import { AUTH_PROVIDERS, PASSWORD_RESET_PROVIDERS } from './auth-providers';
import { serializeUser } from './serializers/user';

describe('buildItemImageInfos', () => {
    it('lists single images unindexed first, backdrops indexed from 0', () => {
        expect(
            buildItemImageInfos({
                ImageTags: { Primary: 'p', Logo: 'l' },
                BackdropImageTags: ['b0', 'b1'],
                ImageBlurHashes: { Primary: { p: 'LKO2?U%2Tw=w' } },
            }),
        ).toEqual([
            {
                ImageType: 'Primary',
                ImageIndex: null,
                ImageTag: 'p',
                BlurHash: 'LKO2?U%2Tw=w',
                Size: 0,
            },
            { ImageType: 'Logo', ImageIndex: null, ImageTag: 'l', Size: 0 },
            { ImageType: 'Backdrop', ImageIndex: 0, ImageTag: 'b0', Size: 0 },
            { ImageType: 'Backdrop', ImageIndex: 1, ImageTag: 'b1', Size: 0 },
        ]);
    });

    it('is empty for an item without images', () => {
        expect(buildItemImageInfos({})).toEqual([]);
    });
});

describe('likes', () => {
    it('parses likes case-insensitively, anything else is null', () => {
        expect(parseLikes('true')).toBe(true);
        expect(parseLikes('False')).toBe(false);
        expect(parseLikes('1')).toBeNull();
        expect(parseLikes(null)).toBeNull();
    });

    it('maps a rating to Likes at 6.5, as Jellyfin does', () => {
        expect(likesFromRating(null)).toBeNull();
        expect(likesFromRating(8)).toBe(true);
        expect(likesFromRating(10)).toBe(true);
        expect(likesFromRating(5)).toBe(false);
        expect(likesFromRating(2)).toBe(false);
    });
});

describe('quickConnectAuthorizeRateLimitKey', () => {
    it('is one per-user bucket, whatever address the request comes from', () => {
        const ev = (username: string | undefined, ip: string): RequestEvent =>
            ({
                locals: username ? { user: { username } } : {},
                request: new Request('http://localhost/j/QuickConnect/Authorize', {
                    method: 'POST',
                }),
                url: new URL('http://localhost/j/QuickConnect/Authorize'),
                getClientAddress: () => ip,
            }) as unknown as RequestEvent;
        expect(quickConnectAuthorizeRateLimitKey(ev('alice', '10.0.0.1'))).toBe(
            'qc:authorize:alice',
        );
        expect(quickConnectAuthorizeRateLimitKey(ev('alice', '10.0.0.2'))).toBe(
            'qc:authorize:alice',
        );
    });
});

describe('preferencesFromUserConfiguration', () => {
    it('maps languages to ISO 639-1 and subtitle modes to the two switches', () => {
        expect(
            preferencesFromUserConfiguration({
                AudioLanguagePreference: 'ger',
                subtitleLanguagePreference: 'fra',
                SubtitleMode: 'None',
                EnableNextEpisodeAutoPlay: true,
            }),
        ).toEqual({
            audioLanguage: 'de',
            subtitleLanguage: 'fr',
            subtitlesEnabled: false,
            forcedSubtitlesEnabled: false,
            autoplayNextEpisode: true,
        });
        expect(preferencesFromUserConfiguration({ SubtitleMode: 'OnlyForced' })).toEqual({
            subtitlesEnabled: false,
            forcedSubtitlesEnabled: true,
        });
        expect(preferencesFromUserConfiguration({ SubtitleMode: 'Always' })).toEqual({
            subtitlesEnabled: true,
        });
    });

    it('clears a language on "" or null and ignores everything else', () => {
        expect(
            preferencesFromUserConfiguration({
                AudioLanguagePreference: '',
                SubtitleLanguagePreference: null,
                SubtitleMode: 'Bogus',
                OrderedViews: ['x'],
                HidePlayedInLatest: false,
            }),
        ).toEqual({ audioLanguage: null, subtitleLanguage: null });
        expect(preferencesFromUserConfiguration([])).toEqual({});
        expect(preferencesFromUserConfiguration('x')).toEqual({});
    });

    it('skips fields the app merely echoes back from /Users/Me', () => {
        // An app POSTs the whole configuration it read: unchanged defaults are no change.
        const defaults = reportedPlaybackConfiguration(null);
        expect(
            preferencesFromUserConfiguration({ ...defaults, OrderedViews: [] }, defaults),
        ).toEqual({});
        // Stored values echoed in another case are no change either; a real change is.
        expect(
            preferencesFromUserConfiguration(
                {
                    AudioLanguagePreference: 'DEU',
                    SubtitleLanguagePreference: 'fra',
                    SubtitleMode: 'OnlyForced',
                    EnableNextEpisodeAutoPlay: false,
                },
                {
                    AudioLanguagePreference: 'ger',
                    SubtitleLanguagePreference: 'eng',
                    SubtitleMode: 'OnlyForced',
                    EnableNextEpisodeAutoPlay: true,
                },
            ),
        ).toEqual({ subtitleLanguage: 'fr', autoplayNextEpisode: false });
        // null clears only when something is set.
        expect(
            preferencesFromUserConfiguration(
                { AudioLanguagePreference: null },
                { AudioLanguagePreference: '' },
            ),
        ).toEqual({});
    });
});

describe('decodeUploadedImage', () => {
    it('accepts raw bytes, base64 and a data URL; rejects anything else', async () => {
        const png = await sharp({
            create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
        })
            .png()
            .toBuffer();
        expect(decodeUploadedImage(new Uint8Array(png))).toEqual(png);
        const b64 = png.toString('base64');
        expect(decodeUploadedImage(Buffer.from(b64))).toEqual(png);
        expect(decodeUploadedImage(Buffer.from(`data:image/png;base64,${b64}\n`))).toEqual(png);
        expect(decodeUploadedImage(Buffer.from('hello'))).toBeNull();
        expect(
            decodeUploadedImage(Buffer.from(Buffer.from('plain text').toString('base64'))),
        ).toBeNull();
    });
});

describe('isOtherUser', () => {
    const self = '0f8fad5b-d9cb-469f-a165-70867728950e';
    it('treats absent, dashed and dashless forms of the caller as self', () => {
        expect(isOtherUser(null, self)).toBe(false);
        expect(isOtherUser('', self)).toBe(false);
        expect(isOtherUser(self.toUpperCase(), self)).toBe(false);
        expect(isOtherUser(self.replace(/-/g, ''), self)).toBe(false);
        expect(isOtherUser('11111111111111111111111111111111', self)).toBe(true);
    });
});

describe('years', () => {
    it('parses whole positive years only', () => {
        expect(parseYear('2020')).toBe(2020);
        expect(parseYear('0')).toBeNull();
        expect(parseYear('20x0')).toBeNull();
        expect(parseYear('99999')).toBeNull();
        expect(parseYear(undefined)).toBeNull();
    });

    it('serializes a stable Year item', () => {
        expect(yearItemId(2020)).toBe(yearItemId(2020));
        expect(yearItemId(2020)).not.toBe(yearItemId(2021));
        expect(serializeYear(2020, 3)).toMatchObject({
            Name: '2020',
            Type: 'Year',
            MediaType: 'Unknown',
            ProductionYear: 2020,
            ChildCount: 3,
        });
    });
});

describe('auth providers', () => {
    it('match the provider ids the user policy reports', () => {
        const { Policy } = serializeUser({ id: 'u', username: 'u', is_admin: false });
        expect(AUTH_PROVIDERS.map((p) => p.Id)).toEqual([Policy.AuthenticationProviderId]);
        expect(PASSWORD_RESET_PROVIDERS.map((p) => p.Id)).toEqual([Policy.PasswordResetProviderId]);
    });
});

describe('serializeUser configuration', () => {
    it('reports the stored playback preferences, autoplay included', () => {
        const dto = serializeUser(
            { id: 'u', username: 'u', is_admin: false },
            {
                audio_language: 'de',
                last_audio_language: null,
                subtitle_language: null,
                subtitles_enabled: false,
                forced_subtitles_enabled: false,
                subtitle_track_hint: null,
                autoplay_next_episode: false,
            },
        );
        expect(dto.Configuration).toMatchObject({
            AudioLanguagePreference: 'deu',
            SubtitleMode: 'None',
            PlayDefaultAudioTrack: false,
            EnableNextEpisodeAutoPlay: false,
        });
        expect(
            serializeUser({ id: 'u', username: 'u', is_admin: false }).Configuration,
        ).toMatchObject({ EnableNextEpisodeAutoPlay: true, SubtitleMode: 'Default' });
    });
});
