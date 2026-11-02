// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { normalizeLanguage, isUnknownLanguage } from './language-codes';
import type { AudioStreamInfo } from '$lib/types/playback';
import {
    isCommentaryOrADTrack,
    resolvePreferredAudioTrack,
    resolvePromotableAudioLanguage,
    resolveTracks,
} from './track-selection';

function track(
    index: number,
    language: string | undefined,
    isDefault = false,
    title?: string,
): AudioStreamInfo {
    return {
        index,
        codec: 'eac3',
        language,
        displayTitle: title ?? language ?? 'Unknown',
        channels: 2,
        isDefault,
    };
}

/** Fire Force S03: German default, Japanese original, English dub. */
const FIRE_FORCE_S3 = [track(1, 'ger', true), track(2, 'jpn'), track(3, 'eng')];

/** Fire Force S01: no English dub at all. */
const FIRE_FORCE_S1 = [track(1, 'ger', true), track(2, 'jpn')];

const NO_PREFS = {
    preferOriginalAudio: false,
    audioLanguage: null,
    lastAudioLanguage: null,
};

describe('resolvePreferredAudioTrack', () => {
    it('falls back to the file default when no preference is set', () => {
        const result = resolvePreferredAudioTrack(FIRE_FORCE_S3, NO_PREFS, null, 1);
        expect(result).toEqual({ index: 1, reason: 'file-default', language: null });
    });

    it('matches the explicit Settings default language', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { ...NO_PREFS, audioLanguage: 'en' },
            null,
            1,
        );
        expect(result).toEqual({ index: 3, reason: 'explicit-default', language: 'en' });
    });

    it('matches the learned language when no explicit default is set', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { ...NO_PREFS, lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'learned', language: 'ja' });
    });

    it('lets the explicit default win over the learned language', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { ...NO_PREFS, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 3, reason: 'explicit-default', language: 'en' });
    });

    it('treats a whitespace-only explicit default as unset', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { ...NO_PREFS, audioLanguage: '   ', lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'learned', language: 'ja' });
    });

    // ---- Tier 0: prefer the title's original production language ----

    it('prefers the original production language over the explicit default', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { preferOriginalAudio: true, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            'ja',
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'original-language', language: 'ja' });
    });

    it('ignores the original language when the toggle is off', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: null },
            'ja',
            1,
        );
        expect(result).toEqual({ index: 3, reason: 'explicit-default', language: 'en' });
    });

    it('falls back to the explicit default when the original language has no track', () => {
        // A German-original show with only German + English audio: original 'de'
        // is present, but for a Korean-original title with no Korean track the
        // user's explicit English default should still apply.
        const streams = [track(1, 'ger', true), track(2, 'eng')];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: true, audioLanguage: 'en', lastAudioLanguage: null },
            'ko',
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'explicit-default', language: 'en' });
    });

    it('normalizes ISO 639-2 track tags against ISO 639-1 preferences', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { preferOriginalAudio: true, audioLanguage: null, lastAudioLanguage: null },
            'ja',
            1,
        );
        expect(result.index).toBe(2);
    });

    // ---- The bug: explicit default with no matching track stranded the user ----

    it('falls through to the learned language when the explicit default has no track', () => {
        // When the explicit English default has no matching dub, the learned
        // Japanese preference must still apply. Previously this fell straight
        // to the German file default.
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S1,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'learned', language: 'ja' });
    });

    it('falls through to the file default when neither preferred language has a track', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S1,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: 'ko' },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'no-match-file-default', language: null });
    });

    // ---- Untagged-track guessing stays scoped to the explicit default ----

    it('guesses an untagged track for the explicit default when nothing is tagged', () => {
        // German BD: tagged German default + untagged English alternate. No
        // tagged track matches any preference, so the explicit 'en' may claim
        // the untagged one.
        const streams = [track(1, 'ger', true), track(2, undefined)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: 'fr' },
            null,
            1,
        );
        expect(result).toEqual({
            index: 2,
            reason: 'explicit-default-untagged',
            language: 'en',
        });
    });

    it('lets an exact tagged match from ANY tier beat the untagged guess', () => {
        // The guess is an inference; a tagged track matching the learned
        // language is evidence. Evidence wins, even from a lower tier.
        const streams = [track(1, 'ger', true), track(2, 'jpn'), track(3, undefined)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 2, reason: 'learned', language: 'ja' });
    });

    it('lets prefer-original reach the untagged guess too', () => {
        // A US film on a German disc: tagged German default + untagged track,
        // original language English, no explicit default. The untagged track is
        // overwhelmingly the original, and refusing to guess handed the viewer
        // the German dub.
        const streams = [track(1, 'ger', true), track(2, undefined)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: true, audioLanguage: null, lastAudioLanguage: null },
            'en',
            1,
        );
        expect(result).toEqual({
            index: 2,
            reason: 'original-language-untagged',
            language: 'en',
        });
    });

    it('does not report a guess when the file offers only one track', () => {
        // 31k files on prod are a single untagged audio stream. There is no
        // choice to explain, so claiming a preference made one is pure noise.
        const streams = [track(1, undefined, true)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'de', lastAudioLanguage: null },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'no-match-file-default', language: null });
    });

    it('reports that preferences existed but matched nothing', () => {
        // Distinct from having no preferences at all: this viewer asked for
        // something and did not get it, which is exactly the case that used to
        // pass silently.
        const streams = [track(1, 'ger', true), track(2, 'fre')];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'no-match-file-default', language: null });
    });

    it('reports a plain file default when the viewer expressed no preference', () => {
        const streams = [track(1, 'ger', true), track(2, 'fre')];
        const result = resolvePreferredAudioTrack(streams, NO_PREFS, null, 1);
        expect(result).toEqual({ index: 1, reason: 'file-default', language: null });
    });

    it('ignores a meaningless language stored as a preference', () => {
        // 'und' is free-text-typeable and 510 audio streams on prod are tagged
        // 'und'; treating it as a real preference matches an arbitrary track.
        const streams = [track(1, 'ger', true), track(2, 'und')];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'und', lastAudioLanguage: null },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'file-default', language: null });
    });

    it('never guesses an untagged track for the learned language', () => {
        const streams = [track(1, 'ger', true), track(2, undefined)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: null, lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'no-match-file-default', language: null });
    });

    it('never guesses an untagged track for the learned language alone', () => {
        // A learned language carries no cross-title intent, so it may not claim
        // what could be a commentary track.
        const streams = [track(1, 'ger', true), track(2, undefined), track(3, 'fre')];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: null, lastAudioLanguage: 'ja' },
            null,
            1,
        );
        expect(result).toEqual({ index: 1, reason: 'no-match-file-default', language: null });
    });

    it('prefers a non-default untagged track when guessing', () => {
        const streams = [track(1, undefined, true), track(2, undefined)];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: null },
            null,
            1,
        );
        expect(result.index).toBe(2);
    });

    it('treats und/mul tags as untagged', () => {
        const streams = [track(1, 'ger', true), track(2, 'und')];
        const result = resolvePreferredAudioTrack(
            streams,
            { preferOriginalAudio: false, audioLanguage: 'en', lastAudioLanguage: null },
            null,
            1,
        );
        expect(result.index).toBe(2);
    });

    it('ignores an empty original language', () => {
        const result = resolvePreferredAudioTrack(
            FIRE_FORCE_S3,
            { preferOriginalAudio: true, audioLanguage: 'en', lastAudioLanguage: null },
            '',
            1,
        );
        expect(result).toEqual({ index: 3, reason: 'explicit-default', language: 'en' });
    });

    it('returns the file default for an empty stream list', () => {
        const result = resolvePreferredAudioTrack(
            [],
            { preferOriginalAudio: true, audioLanguage: 'en', lastAudioLanguage: 'ja' },
            'ja',
            0,
        );
        expect(result).toEqual({ index: 0, reason: 'no-match-file-default', language: null });
    });
});

describe('resolvePromotableAudioLanguage', () => {
    const OFF = { preferOriginalAudio: false, audioLanguage: null };

    it('offers the current track language when no default is set', () => {
        expect(resolvePromotableAudioLanguage(track(2, 'jpn'), OFF)).toBe('ja');
    });

    it('normalizes the track tag to ISO 639-1', () => {
        expect(resolvePromotableAudioLanguage(track(3, 'eng'), OFF)).toBe('en');
    });

    it('declines when the track already matches the explicit default', () => {
        expect(
            resolvePromotableAudioLanguage(track(3, 'eng'), {
                preferOriginalAudio: false,
                audioLanguage: 'en',
            }),
        ).toBeNull();
    });

    it('offers a language that differs from the explicit default', () => {
        expect(
            resolvePromotableAudioLanguage(track(2, 'jpn'), {
                preferOriginalAudio: false,
                audioLanguage: 'en',
            }),
        ).toBe('ja');
    });

    it('declines while prefer-original is on, since it would not take effect', () => {
        expect(
            resolvePromotableAudioLanguage(track(2, 'jpn'), {
                preferOriginalAudio: true,
                audioLanguage: 'en',
            }),
        ).toBeNull();
    });

    it('declines for an untagged track, which cannot be stored as a language', () => {
        expect(resolvePromotableAudioLanguage(track(2, undefined), OFF)).toBeNull();
        expect(resolvePromotableAudioLanguage(track(2, 'und'), OFF)).toBeNull();
        expect(resolvePromotableAudioLanguage(track(2, 'mul'), OFF)).toBeNull();
    });

    it('declines when there is no current track', () => {
        expect(resolvePromotableAudioLanguage(undefined, OFF)).toBeNull();
    });
});

const SUBS = [
    { index: 4, language: 'ger', isForced: false, codec: 'subrip' },
    { index: 5, language: 'ger', isForced: true, codec: 'subrip' },
    { index: 8, language: 'eng', isForced: false, codec: 'subrip' },
];
const SUB_PREFS = {
    preferOriginalAudio: false,
    audioLanguage: null,
    lastAudioLanguage: null,
    subtitleLanguage: null,
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: true,
    subtitleTrackHint: null,
};

describe('resolveTracks — subtitles', () => {
    it.each(['', 'und', 'mul', 'zxx'])(
        'restores an untagged subtitle (%s) by same-file identity without matching other files',
        (language) => {
            const prefs = {
                ...SUB_PREFS,
                subtitleTrackHint: {
                    language,
                    isForced: false,
                    codec: 'subrip',
                    fileId: 'file',
                    trackId: 'chosen',
                },
            };
            const subtitles = [
                { index: 4, id: 'chosen', fileId: 'file', language, codec: 'subrip' },
            ];
            expect(resolveTracks(FIRE_FORCE_S3, subtitles, prefs, null, 1).subtitle.index).toBe(4);
            expect(
                resolveTracks(
                    FIRE_FORCE_S3,
                    subtitles.map((track) => ({ ...track, fileId: 'other' })),
                    prefs,
                    null,
                    1,
                ).subtitle.index,
            ).toBeNull();
        },
    );
    it.each(['Commentary', 'Signs and Songs'])(
        'preserves full-caption semantics over an earlier %s edition',
        (title) => {
            const subtitles = [
                { index: 1, language: 'eng', codec: 'subrip', title },
                { index: 2, language: 'eng', codec: 'subrip', title: 'Complete English' },
            ];
            expect(
                resolveTracks(
                    [{ index: 0, language: 'eng' }],
                    subtitles,
                    {
                        ...SUB_PREFS,
                        subtitleTrackHint: {
                            language: 'eng',
                            isForced: false,
                            codec: 'subrip',
                            title: 'English Full',
                        },
                    },
                    null,
                    0,
                ).subtitle.index,
            ).toBe(2);
        },
    );
    it('prefers the exact hint over a bare language match', () => {
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            {
                ...SUB_PREFS,
                subtitleLanguage: 'de',
                subtitleTrackHint: { language: 'de', isForced: true, codec: 'subrip' },
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 5, reason: 'hint-exact' });
    });

    it('ignores a forced hint whose language is not the chosen audio (S10)', () => {
        // Windows e2e 2026-09-27: "German forced" was remembered from the German
        // dub; the next session started on English (learned) and still showed
        // GER [Forced]. A forced track belongs to its audio language.
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            {
                ...SUB_PREFS,
                lastAudioLanguage: 'en',
                subtitleTrackHint: { language: 'de', isForced: true, codec: 'subrip' },
            },
            null,
            1,
        );
        expect(r.audio.index).toBe(3);
        // No English forced track in SUBS -> nothing, not the German one.
        expect(r.subtitle).toEqual({ index: null, reason: 'none-available' });
    });

    it('a mismatched forced hint falls through to the forced track of the chosen audio', () => {
        const subs = [...SUBS, { index: 9, language: 'eng', isForced: true, codec: 'subrip' }];
        const r = resolveTracks(
            FIRE_FORCE_S3,
            subs,
            {
                ...SUB_PREFS,
                lastAudioLanguage: 'en',
                subtitleTrackHint: { language: 'de', isForced: true, codec: 'subrip' },
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 9, reason: 'forced-for-audio' });
    });

    it('keeps a NON-forced hint regardless of the audio language', () => {
        // Full subtitles are a viewer choice, not tied to the dub.
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            {
                ...SUB_PREFS,
                lastAudioLanguage: 'en',
                subtitleTrackHint: { language: 'de', isForced: false, codec: 'subrip' },
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 4, reason: 'hint-exact' });
    });

    it('matches the saved language, skipping forced tracks', () => {
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            { ...SUB_PREFS, subtitleLanguage: 'de' },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 4, reason: 'saved-language' });
    });

    it('falls back to a forced subtitle in the chosen audio language', () => {
        const r = resolveTracks(FIRE_FORCE_S3, SUBS, SUB_PREFS, null, 1);
        expect(r.subtitle).toEqual({ index: 5, reason: 'forced-for-audio' });
    });

    it('uses the resolver INFERENCE when the audio track carries no tag', () => {
        // The untagged guess concluded this track is German; the forced matcher
        // must use that, not the track's absent tag.
        const audio = [{ index: 1, language: 'fre', isDefault: true }, { index: 2 }];
        const r = resolveTracks(audio, SUBS, { ...SUB_PREFS, audioLanguage: 'de' }, null, 1);
        expect(r.audio.reason).toBe('explicit-default-untagged');
        expect(r.subtitle).toEqual({ index: 5, reason: 'forced-for-audio' });
    });

    it('returns off when subtitles are disabled and forced are too', () => {
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            {
                ...SUB_PREFS,
                subtitlesEnabled: false,
                forcedSubtitlesEnabled: false,
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: null, reason: 'off' });
    });

    it('finds a forced subtitle when subtitles are off but forced remain enabled, ignoring a saved language that would otherwise match', () => {
        // subtitleLanguage: 'en' WOULD match SUBS[2] (eng, non-forced) under the
        // on-state cascade — this pins the off-branch to still return the
        // forced German track, so a merge that let the "subtitles off" state
        // fall into the on-state matching logic would be caught here.
        const r = resolveTracks(
            FIRE_FORCE_S3,
            SUBS,
            {
                ...SUB_PREFS,
                subtitlesEnabled: false,
                forcedSubtitlesEnabled: true,
                subtitleLanguage: 'en',
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 5, reason: 'forced-for-audio' });
    });

    it('falls back to hint-role when no codec-exact candidate is present', () => {
        // The hint asks for German forced subrip, but the file only has German
        // forced ass. Same role (language + forced), different codec: role
        // match, not exact.
        const subs = [{ index: 4, language: 'ger', isForced: true, codec: 'ass' }];
        const r = resolveTracks(
            FIRE_FORCE_S3,
            subs,
            {
                ...SUB_PREFS,
                subtitleTrackHint: { language: 'de', isForced: true, codec: 'subrip' },
            },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: 4, reason: 'hint-role' });
    });

    it('treats a title-tagged forced subtitle as forced for the audio-language fallback', () => {
        // Some files carry "forced" in the display title but never set the
        // container's forced bit. The bare isForced flag misses this track
        // entirely, silently reporting no forced subtitle where one exists.
        const subs = [
            {
                index: 6,
                language: 'ger',
                isForced: false,
                codec: 'subrip',
                title: 'German (Forced)',
            },
            { index: 7, language: 'eng', isForced: false, codec: 'subrip' },
        ];
        const r = resolveTracks(FIRE_FORCE_S3, subs, SUB_PREFS, null, 1);
        expect(r.subtitle).toEqual({ index: 6, reason: 'forced-for-audio' });
    });

    it('excludes a title-tagged forced subtitle from the saved-language match', () => {
        // The same title-tagged track must not qualify as a regular
        // saved-language subtitle either — a viewer wanting full translation
        // must not be silently handed forced-only captions.
        const subs = [
            {
                index: 6,
                language: 'ger',
                isForced: false,
                codec: 'subrip',
                title: 'German (Forced)',
            },
        ];
        const r = resolveTracks(
            FIRE_FORCE_S3,
            subs,
            { ...SUB_PREFS, subtitleLanguage: 'de', forcedSubtitlesEnabled: false },
            null,
            1,
        );
        expect(r.subtitle).toEqual({ index: null, reason: 'none-available' });
    });
});

// ============================================================================
// Commentary / audio-description filtering
// ============================================================================

/** Like `track()` above, but sets the metadata `title` the filter reads. */
function titled(
    index: number,
    language: string | undefined,
    title: string,
    isDefault = false,
): AudioStreamInfo {
    return { ...track(index, language, isDefault), title };
}

describe('isCommentaryOrADTrack', () => {
    it.each([
        'Commentary',
        "Director's Commentary",
        'Audio Commentary with Cast',
        'Audio Description',
        'Descriptive Audio',
        'English Descriptive Audio',
        'Audiobeschreibung',
        'Beschreibung für Sehbehinderte',
        'AD',
        '(AD)',
        'AD 2.0',
        'English (AD)',
        // German. This is a German-primary library, so these are the titles most
        // likely to actually appear on a commentary track here — and the ones the
        // English-only predicate silently missed.
        'Kommentar',
        'Audiokommentar',
        'Regiekommentar mit dem Regisseur',
        'Audiodeskription',
        'Hörfilm',
        'Hörfilmfassung',
        'Hoerfilm', // ASCII transliteration, as some taggers emit
    ])('flags %j', (title) => {
        expect(isCommentaryOrADTrack(title)).toBe(true);
    });

    // The old predicate tested `title.includes('ad ')`, which matches any title
    // with an "…ad " in it. Contained to hover-previews before; this task puts
    // the filter on every playback path, so the false positives had to go.
    it.each([
        'Road Movie Mix',
        'Bad Boys',
        'Bad Audio Take',
        'Broadway Cast Recording',
        'Deadpool',
        'German 5.1',
        'English AAC Stereo',
        'Deutsch 5.1',
        'Originalfassung',
        'Hörspiel', // an audio DRAMA is content, not a description track
    ])('does not flag %j', (title) => {
        expect(isCommentaryOrADTrack(title)).toBe(false);
    });

    it('treats a missing or blank title as no evidence, not as commentary', () => {
        expect(isCommentaryOrADTrack(undefined)).toBe(false);
        expect(isCommentaryOrADTrack(null)).toBe(false);
        expect(isCommentaryOrADTrack('')).toBe(false);
        expect(isCommentaryOrADTrack('   ')).toBe(false);
    });
});

describe('resolvePreferredAudioTrack — commentary filtering', () => {
    const WANTS_ENGLISH = {
        preferOriginalAudio: false,
        audioLanguage: 'eng',
        lastAudioLanguage: null,
    };

    it('skips an English commentary track in favour of the real English track', () => {
        const tracks = [
            track(1, 'ger', true),
            titled(2, 'eng', "Director's Commentary"),
            titled(3, 'eng', 'English 5.1'),
        ];
        expect(resolvePreferredAudioTrack(tracks, WANTS_ENGLISH, null, 1).index).toBe(3);
    });

    it('never returns a commentary track as the file default when a real one exists', () => {
        // The file itself flags the commentary track as default — some discs do.
        const tracks = [titled(1, 'ger', 'Audiokommentar', true), titled(2, 'ger', 'German 5.1')];
        expect(resolvePreferredAudioTrack(tracks, NO_PREFS, null, 1).index).toBe(2);
    });

    it('returns a commentary track rather than nothing when every track is one', () => {
        // Filtering away ALL candidates would leave the player with no audio.
        // A commentary track beats silence.
        const tracks = [
            titled(1, 'eng', 'Commentary', true),
            titled(2, 'eng', 'Audio Description'),
        ];
        const result = resolvePreferredAudioTrack(tracks, WANTS_ENGLISH, null, 1);
        expect(result.index).toBe(1);
    });

    it('does not let a commentary track win the untagged guess', () => {
        const tracks = [track(1, 'ger', true), titled(2, undefined, 'Commentary')];
        // The only untagged track is commentary, so the guess must not fire.
        const result = resolvePreferredAudioTrack(tracks, WANTS_ENGLISH, null, 1);
        expect(result.index).toBe(1);
        expect(result.reason).toBe('no-match-file-default');
    });
});

describe('subtitle review regressions B1–B3/B8–B9', () => {
    const audio = [{ index: 0, language: 'eng', isDefault: true }];
    const subtitles = [
        { index: 1, language: 'eng', codec: 'subrip', title: 'English Forced', isForced: false },
        { index: 2, language: 'eng', codec: 'subrip', title: 'English', isForced: false },
        { index: 3, language: 'eng', codec: 'subrip', title: 'English SDH', isForced: false },
        { index: 4, language: 'deu', codec: 'subrip', title: 'German', isForced: false },
    ];
    it('does not restore legacy forced hints or turn them into full captions when forced is disabled', () => {
        const result = resolveTracks(
            audio,
            subtitles,
            {
                ...SUB_PREFS,
                forcedSubtitlesEnabled: false,
                subtitleLanguage: 'eng',
                subtitleTrackHint: { language: 'eng', isForced: true, codec: 'subrip' },
            },
            null,
            0,
        );
        expect(result.subtitle.index).toBeNull();
    });
    it.each([false, true])('uses title-only forced metadata for saved role %s', (isForced) => {
        const result = resolveTracks(
            audio,
            subtitles,
            { ...SUB_PREFS, subtitleTrackHint: { language: 'eng', isForced, codec: 'subrip' } },
            null,
            0,
        );
        expect(result.subtitle.index).toBe(isForced ? 1 : 2);
    });
    it('does not turn an old automatic forced language into full captions after an audio change', () => {
        const result = resolveTracks(
            audio,
            subtitles,
            {
                ...SUB_PREFS,
                subtitleLanguage: 'deu',
                subtitleTrackHint: { language: 'deu', isForced: true, codec: 'subrip' },
            },
            null,
            0,
        );
        expect(result.subtitle.index).toBe(1);
    });
    it('remembers the SDH edition and ignores an identity scoped to another file', () => {
        const result = resolveTracks(
            audio,
            subtitles.map((sub) => ({ ...sub, id: `track-${sub.index}`, fileId: 'new-file' })),
            {
                ...SUB_PREFS,
                subtitleTrackHint: {
                    language: 'eng',
                    isForced: false,
                    codec: 'subrip',
                    title: 'English SDH',
                    fileId: 'old-file',
                    trackId: 'track-2',
                },
            },
            null,
            0,
        );
        expect(result.subtitle.index).toBe(3);
    });
    it('prefers stable same-file identity even for indistinguishable titles', () => {
        const result = resolveTracks(
            audio,
            subtitles.map((sub) => ({
                ...sub,
                title: 'English',
                id: `track-${sub.index}`,
                fileId: 'file',
            })),
            {
                ...SUB_PREFS,
                subtitleTrackHint: {
                    language: 'eng',
                    isForced: false,
                    codec: 'subrip',
                    title: 'English',
                    fileId: 'file',
                    trackId: 'track-3',
                },
            },
            null,
            0,
        );
        expect(result.subtitle.index).toBe(3);
    });
});

it('prefers exact qualified audio, forced and hint candidates over compatible base tags', () => {
    const prefs = {
        preferOriginalAudio: false,
        audioLanguage: 'en-US',
        lastAudioLanguage: null,
        subtitleLanguage: 'en-US',
        subtitlesEnabled: true,
        forcedSubtitlesEnabled: true,
        subtitleTrackHint: null,
    };
    const audio = [track(0, 'en', true), track(1, 'en-US')];
    expect(resolvePreferredAudioTrack(audio, prefs, null, 0).index).toBe(1);
    const subs = [
        { index: 2, language: 'en', isForced: true },
        { index: 3, language: 'en-US', isForced: true },
        { index: 4, language: 'en' },
        { index: 5, language: 'en-US' },
    ];
    expect(
        resolveTracks(audio, subs, { ...prefs, subtitlesEnabled: false }, null, 0).subtitle.index,
    ).toBe(3);
    expect(resolveTracks(audio, subs, prefs, null, 0).subtitle.index).toBe(5);
    expect(
        resolveTracks(
            audio,
            subs,
            { ...prefs, subtitleTrackHint: { language: 'en-US', isForced: true, codec: null } },
            null,
            0,
        ).subtitle.index,
    ).toBe(3);
    expect(
        resolvePreferredAudioTrack(
            [track(0, 'de', true), track(1, 'en-US')],
            { ...prefs, audioLanguage: 'en' },
            null,
            0,
        ).index,
    ).toBe(1);
});

it.each(['constructor', '__proto__', 'constructor-US', '__proto__-US'])(
    'resolves accepted persisted language values %s without inherited lookup crashes',
    (language) => {
        const prefs = {
            ...SUB_PREFS,
            audioLanguage: language,
            lastAudioLanguage: language,
            subtitleLanguage: language,
            subtitleTrackHint: { language, isForced: false, codec: null },
        };
        const result = resolveTracks(
            [track(0, 'en', true), track(1, language)],
            [{ index: 7, language }],
            prefs,
            null,
            0,
        );
        const unknown = isUnknownLanguage(language);
        expect(result.audio.index).toBe(unknown ? 0 : 1);
        expect(result.subtitle.index).toBe(unknown ? null : 7);
        expect(resolvePromotableAudioLanguage({ index: 1, language }, NO_PREFS)).toBe(
            unknown ? null : normalizeLanguage(language),
        );
    },
);

it('offers an exact qualified-language default even when a different base-language track satisfies the current default', () => {
    expect(
        resolvePromotableAudioLanguage(
            { index: 1, language: 'en-US' },
            { preferOriginalAudio: false, audioLanguage: 'en' },
        ),
    ).toBe('en-us');
    expect(
        resolvePromotableAudioLanguage(
            { index: 1, language: 'ENG_US' },
            { preferOriginalAudio: false, audioLanguage: 'en-US' },
        ),
    ).toBeNull();
});
