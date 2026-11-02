// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    normalizeLanguage,
    languagesMatch,
    isUnknownLanguage,
    bestLanguageMatch,
    languageMatchScore,
} from './language-codes';
import type { SubtitleTrackHint } from '$lib/schemas/user';

/**
 * A track candidate, deliberately narrower than both `AudioStreamInfo` and the
 * `lumastra-info` track shape, so the same resolver accepts DB rows
 * server-side and player streams client-side without either importing the
 * other's types.
 */
export interface TrackCandidate {
    index: number;
    id?: string;
    fileId?: string;
    language?: string | null;
    isDefault?: boolean;
    isForced?: boolean;
    codec?: string | null;
    /** Needed by the commentary/audio-description filter in Task 5. */
    title?: string | null;
}

/**
 * Why the player ended up on a given audio track. Surfaced in the track picker
 * so an automatic pick is never silent — a viewer who keeps re-selecting the
 * same language should be able to see which preference is fighting them.
 */
export type AudioSelectionReason =
    /** The title's original production language (TMDB `original_language`). */
    | 'original-language'
    /** An untagged track guessed to be the title's original language. */
    | 'original-language-untagged'
    /** The explicit "default audio language" from Settings. */
    | 'explicit-default'
    /** An untagged track guessed to be the explicit default language. */
    | 'explicit-default-untagged'
    /** The language learned from the viewer's last in-player pick. */
    | 'learned'
    /** The viewer expressed no audio preference — the file's own default track. */
    | 'file-default'
    /** The viewer HAS preferences and this file satisfies none of them. */
    | 'no-match-file-default';

export interface AudioSelection {
    index: number;
    reason: AudioSelectionReason;
    /**
     * Normalized language behind the pick. For the two `*-untagged` reasons this
     * is an INFERENCE about a track that carries no tag of its own — the forced-
     * subtitle matcher needs it precisely because the track cannot supply it.
     * Null for both file-default reasons.
     */
    language: string | null;
}

export interface AudioLanguagePreferences {
    /** Prefer the title's original production language over everything below. */
    preferOriginalAudio: boolean;
    /** Explicit Settings default. */
    audioLanguage: string | null;
    /** Learned from the viewer's last in-player pick. */
    lastAudioLanguage: string | null;
}

/**
 * Patterns marking an audio track as commentary or audio description — a track
 * a viewer may deliberately choose but that must never be chosen FOR them.
 *
 * Deliberately anchored. The predicate this replaces tested
 * `title.includes('ad ')`, which flags any title containing "…ad " — "Road
 * Movie Mix", "Bad Boys", "Broadway Cast Recording". That was survivable while
 * the filter only ran on hover-previews; it is not now that every playback path
 * uses it. `\bad\b` still catches the real cases ("AD", "(AD)", "AD 2.0")
 * because punctuation and spaces are word boundaries.
 *
 * The longer words stay unanchored on purpose: German compounds them
 * ("Audiobeschreibung"), and none is short enough to collide by accident.
 */
const COMMENTARY_OR_AD_PATTERNS: readonly RegExp[] = [
    // English
    /\bcomment/i, // Commentary, Director's Commentary, Commentaries
    /descripti/i, // Audio Description, Descriptive Audio
    /\bad\b/i, // AD, (AD), AD 2.0 — NOT Bad Boys / Road Movie
    // German. This library is German-primary, so these are the titles most
    // likely to appear on a real commentary track here. `\bcomment` cannot
    // match "Kommentar" and `descripti` cannot match "Deskription", so an
    // English-only predicate missed the population it most needed to catch.
    /kommentar/i, // Kommentar, Audiokommentar, Regiekommentar
    /beschreibung/i, // incl. the compound Audiobeschreibung
    /deskription/i, // Audiodeskription
    /h(ö|oe)rfilm/i, // Hörfilm — the standard German term for an AD track.
    // ASCII form included because some taggers transliterate umlauts.
    // NOT /hörspiel/: an audio drama is content, not a description track.
];

/**
 * Whether a track's title marks it as commentary or audio description.
 *
 * A missing title is NOT evidence of anything — plenty of perfectly ordinary
 * tracks carry no `tags.title` at all, so an absent title has to read as "not
 * commentary" or the filter would reject most of a normal library.
 */
export function audioTrackRole(
    title: string | null | undefined,
): 'main' | 'commentary' | 'description' {
    if (!isCommentaryOrADTrack(title)) return 'main';
    return /comment|kommentar/i.test(title ?? '') ? 'commentary' : 'description';
}

export function isCommentaryOrADTrack(title: string | null | undefined): boolean {
    if (!title?.trim()) return false;
    return COMMENTARY_OR_AD_PATTERNS.some((pattern) => pattern.test(title));
}

/**
 * Drop commentary/AD tracks from the candidate pool — unless that would empty
 * it. Auto-starting a viewer on a director's commentary is a bug; leaving them
 * with no audio at all is a worse one, so an all-commentary file (or one whose
 * titles merely look like commentary) keeps every track.
 */
function selectableTracks(tracks: TrackCandidate[]): TrackCandidate[] {
    const kept = tracks.filter((t) => !isCommentaryOrADTrack(t.title));
    return kept.length > 0 ? kept : tracks;
}

/** A stored preference only counts when it actually names a language. */
function meaningfulLanguage(value: string | null | undefined): string | null {
    if (!value?.trim()) return null;
    if (isUnknownLanguage(value)) return null;
    return normalizeLanguage(value);
}

/**
 * Resolve which audio track to start on.
 *
 * Commentary and audio-description tracks are excluded from every pass (see
 * `selectableTracks`) — including from the file-default fall-through, since a
 * file may flag one as its default.
 *
 * Three passes, in order:
 *
 *   A. Exact tagged match, preferences ranked: original language → explicit
 *      Settings default → learned language.
 *   B. Failing that, an untagged track guessed to BE a preferred language.
 *   C. Failing that, the file's own default track.
 *
 * **Why matching comes before guessing.** An earlier version ran the untagged
 * guess inside the explicit tier, so it fired before the learned tier and could
 * not fall through. That let an inference outrank evidence: a file of
 * `[ger(default), jpn, untagged]` for a viewer whose default is English and
 * whose learned language is Japanese picked the untagged track over the tagged
 * Japanese one. Ranking whole passes rather than interleaving them keeps the
 * preference order intact while never letting a guess beat a real tag.
 *
 * **Why the guess is scoped.** A file with a tagged default plus an untagged
 * alternate is almost always a localized disc whose untagged track is the other
 * language, so a stated want — "I want English", or "this title was made in
 * English" — may claim it. A *learned* language may not: it carries no
 * cross-title intent, and would override the file default onto what could be a
 * commentary track.
 *
 * **Why a guess that changes nothing is not reported.** 31k files on prod are a
 * single untagged audio stream. Pass B would "guess" the only track there and
 * the picker would explain a choice that never existed, so a guess landing on
 * the file default is downgraded to a plain fall-through.
 */
export function resolvePreferredAudioTrack(
    audioStreams: TrackCandidate[],
    prefs: AudioLanguagePreferences,
    originalLanguage: string | null | undefined,
    fileDefaultIndex: number,
): AudioSelection {
    const original = prefs.preferOriginalAudio ? meaningfulLanguage(originalLanguage) : null;
    const explicit = meaningfulLanguage(prefs.audioLanguage);
    const learned = meaningfulLanguage(prefs.lastAudioLanguage);

    // Every pass below picks from the commentary-free pool. The filter is not
    // optional: a commentary track should never be auto-selected on any client.
    const candidates = selectableTracks(audioStreams);

    // The file's own default may itself be a commentary track — some discs flag
    // one — and the caller computed `fileDefaultIndex` without knowing that. If
    // it points outside the pool, re-derive the fall-through from the pool.
    const defaultIndex = candidates.some((t) => t.index === fileDefaultIndex)
        ? fileDefaultIndex
        : (candidates.find((t) => t.isDefault)?.index ?? candidates[0]?.index ?? fileDefaultIndex);

    // Pass A — exact tagged match, most specific preference first.
    const ranked: Array<[string | null, AudioSelectionReason]> = [
        [original, 'original-language'],
        [explicit, 'explicit-default'],
        [learned, 'learned'],
    ];
    for (const [language, reason] of ranked) {
        if (!language) continue;
        const match = bestLanguageMatch(candidates, language, (t) => t.language);
        if (match) return { index: match.index, reason, language };
    }

    // Pass C's payload, needed by pass B to tell a real guess from a no-op.
    const expressedAPreference = Boolean(original || explicit || learned);
    const fallback: AudioSelection = {
        index: defaultIndex,
        reason: expressedAPreference ? 'no-match-file-default' : 'file-default',
        language: null,
    };

    // Pass B — untagged guess, for stated wants only. Prefer a non-default
    // untagged track: the default is usually the file's source-region language,
    // so a non-default untagged track is more likely "the other one".
    const untagged = candidates.filter((t) => isUnknownLanguage(t.language));
    if (untagged.length > 0) {
        const guessable: Array<[string | null, AudioSelectionReason]> = [
            [original, 'original-language-untagged'],
            [explicit, 'explicit-default-untagged'],
        ];
        for (const [language, reason] of guessable) {
            if (!language) continue;
            const candidate = untagged.find((t) => !t.isDefault) ?? untagged[0];
            // A "guess" that lands on the track we would have played anyway
            // explains nothing; report it as the fall-through it is.
            if (candidate.index === defaultIndex) break;
            return { index: candidate.index, reason, language };
        }
    }

    return fallback;
}

/**
 * The language to offer as a one-tap "make this my default", or null when the
 * shortcut should not appear at all.
 *
 * Null in three distinct cases, each for its own reason:
 *
 *   - `preferOriginalAudio` is on. It outranks the explicit default, so writing
 *     one would leave the viewer with a button that silently changed nothing —
 *     a new version of the very trap this shortcut exists to fix.
 *   - The track carries no usable language tag. There is nothing to store.
 *   - The explicit default already names this language, so there is no change
 *     to offer.
 */
export function resolvePromotableAudioLanguage(
    track: TrackCandidate | undefined,
    prefs: Pick<AudioLanguagePreferences, 'preferOriginalAudio' | 'audioLanguage'>,
): string | null {
    if (prefs.preferOriginalAudio) return null;
    if (!track) return null;

    const language = track.language;
    if (isUnknownLanguage(language)) return null;

    const normalized = normalizeLanguage(language);
    if (normalizeLanguage(prefs.audioLanguage) === normalized) return null;

    return normalized;
}

export interface LanguagePreferences {
    preferOriginalAudio: boolean;
    audioLanguage: string | null;
    lastAudioLanguage: string | null;
    subtitleLanguage: string | null;
    subtitlesEnabled: boolean;
    forcedSubtitlesEnabled: boolean;
    subtitleTrackHint: SubtitleTrackHint | null;
}

/** Safe automatic defaults when no saved preferences are available. */
export const DEFAULT_LANGUAGE_PREFERENCES: Readonly<LanguagePreferences> = {
    preferOriginalAudio: false,
    audioLanguage: null,
    lastAudioLanguage: null,
    subtitleLanguage: null,
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: true,
    subtitleTrackHint: null,
};

export interface TrackResolution {
    audio: AudioSelection;
    subtitle: { index: number | null; reason: SubtitleSelectionReason };
}

export type SubtitleSelectionReason =
    'off' | 'hint-exact' | 'hint-role' | 'saved-language' | 'forced-for-audio' | 'none-available';

/**
 * Whether a subtitle track counts as "forced". Some files carry "forced" in
 * the stream's title metadata but never set the container's forced bit —
 * mirrors `isForcedSubtitle()` in playerStore.svelte.ts / TrackSelector.svelte,
 * which the same files rely on.
 */
export function isTrackForced(t: TrackCandidate): boolean {
    if (t.isForced) return true;
    const title = t.title?.toLowerCase() || '';
    return title.includes('forced');
}

/** Prefer a scoped identity, then the closest edition among same-language, same-role tracks. */
export function matchSubtitleHint(
    tracks: TrackCandidate[],
    hint: SubtitleTrackHint,
): TrackCandidate | undefined {
    const stable =
        hint.fileId && hint.trackId
            ? tracks.find((track) => track.fileId === hint.fileId && track.id === hint.trackId)
            : undefined;
    if (stable) return stable;
    if (isUnknownLanguage(hint.language)) return undefined;
    const candidates = tracks.filter(
        (track) =>
            languagesMatch(track.language, hint.language) && isTrackForced(track) === hint.isForced,
    );
    const normalizeTitle = (title: string): string =>
        title
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    const accessible = (title: string): boolean =>
        /\b(sdh|cc|closed captions?|hearing impaired)\b/i.test(title);
    const edition = (title: string): string =>
        /\b(commentary|kommentar)\b/i.test(title)
            ? 'commentary'
            : /\b(signs?|songs?)\b/i.test(title)
              ? 'partial'
              : 'full';
    const score = (track: TrackCandidate): number => {
        let value = languageMatchScore(track.language, hint.language) * 64;
        if (hint.title !== undefined) {
            if (normalizeTitle(track.title ?? '') === normalizeTitle(hint.title)) value += 8;
            if (accessible(track.title ?? '') === accessible(hint.title)) value += 4;
            if (edition(track.title ?? '') === edition(hint.title)) value += 16;
        }
        if (hint.codec === null || track.codec?.toLowerCase() === hint.codec.toLowerCase())
            value += 2;
        return value;
    };
    return candidates.reduce<TrackCandidate | undefined>(
        (best, track) => (!best || score(track) > score(best) ? track : best),
        undefined,
    );
}

/**
 * Resolve both the audio and subtitle track to start on, in one pass — the
 * subtitle resolution depends on which audio track was picked, specifically
 * for the "forced subtitle matching the audio language" fallback.
 */
export function resolveTracks(
    audio: TrackCandidate[],
    subtitles: TrackCandidate[],
    prefs: LanguagePreferences,
    originalLanguage: string | null | undefined,
    fileDefaultAudioIndex: number,
    selectedAudioIndex?: number,
): TrackResolution {
    const audioSelection = resolvePreferredAudioTrack(
        audio,
        {
            preferOriginalAudio: prefs.preferOriginalAudio,
            audioLanguage: prefs.audioLanguage,
            lastAudioLanguage: prefs.lastAudioLanguage,
        },
        originalLanguage,
        fileDefaultAudioIndex,
    );

    // An explicit override keeps inference only when it names the identity that
    // inference explains. Resolve against the complete pool before locking it.
    if (
        selectedAudioIndex !== undefined &&
        selectedAudioIndex !== audioSelection.index &&
        audio.some((track) => track.index === selectedAudioIndex)
    ) {
        audioSelection.index = selectedAudioIndex;
        audioSelection.reason = 'file-default';
        audioSelection.language = null;
    }

    // Forced subtitle matching the chosen audio track's language. Takes the
    // chosen audio language as a parameter — the resolver's INFERENCE when
    // the track's own tag is unknown — rather than reading the track tag
    // directly, so a forced subtitle can still be found on exactly the files
    // where the track carries no tag of its own.
    const chosenAudioLanguage = (): string | null | undefined => {
        const audioTrack = audio.find((t) => t.index === audioSelection.index);
        if (!audioTrack) return undefined;
        const trackLang = audioTrack.language;
        return isUnknownLanguage(trackLang) ? (audioSelection.language ?? trackLang) : trackLang;
    };
    const pickAudioForcedDefault = (): number | null => {
        const audioTrack = audio.find((t) => t.index === audioSelection.index);
        if (!audioTrack) return null;
        const audioLang = chosenAudioLanguage();
        const forcedSub = bestLanguageMatch(
            subtitles.filter(isTrackForced),
            audioLang,
            (sub) => sub.language,
        );
        return forcedSub?.index ?? null;
    };

    const forcedSubtitlesEnabled = prefs.forcedSubtitlesEnabled;
    const subtitlesOff = !prefs.subtitlesEnabled;
    const savedSubtitleLang = prefs.subtitleLanguage;
    const hint = prefs.subtitleTrackHint;

    let subtitleIndex: number | null = null;
    let reason: SubtitleSelectionReason = 'none-available';

    if (subtitlesOff && !forcedSubtitlesEnabled) {
        subtitleIndex = null;
        reason = 'off';
    } else if (subtitlesOff && forcedSubtitlesEnabled) {
        subtitleIndex = pickAudioForcedDefault();
        reason = subtitleIndex !== null ? 'forced-for-audio' : 'none-available';
    } else {
        // 4-step match priority for on-state:
        //   (1) hint.language + hint.isForced + hint.codec (exact identity)
        //   (2) hint.language + hint.isForced (same role, any codec)
        //   (3) savedSubtitleLang + non-forced (legacy single-field path)
        //   (4) forcedSubtitlesEnabled + audio-language default
        //
        // A FORCED hint only applies while its language is the audio being
        // played. Forced subtitles translate the bits of a dub that are not in
        // its language (signs, a foreign-language scene) — they belong to one
        // audio track, not to the viewer. Windows e2e 2026-09-27 (S10): the
        // hint "German forced" was persisted while watching the German dub,
        // the next session started on English audio (learned language) and
        // still showed "GER [Forced]". A mismatched forced hint falls through
        // to (4), which picks the forced track for the audio actually chosen.
        const hintApplies =
            !!hint &&
            (!!hint.language || !!(hint.fileId && hint.trackId)) &&
            (!hint.isForced ||
                (forcedSubtitlesEnabled && languagesMatch(hint.language, chosenAudioLanguage())));
        if (hint && hintApplies) {
            const match = matchSubtitleHint(subtitles, hint);
            if (match) {
                subtitleIndex = match.index;
                reason =
                    hint.codec === null || match.codec?.toLowerCase() === hint.codec.toLowerCase()
                        ? 'hint-exact'
                        : 'hint-role';
            }
        }

        if (
            subtitleIndex === null &&
            savedSubtitleLang &&
            !isUnknownLanguage(savedSubtitleLang) &&
            !hint?.isForced
        ) {
            const matchingSub = bestLanguageMatch(
                subtitles.filter((t) => !isTrackForced(t)),
                savedSubtitleLang,
                (t) => t.language,
            );
            if (matchingSub) {
                subtitleIndex = matchingSub.index;
                reason = 'saved-language';
            }
        }

        if (subtitleIndex === null && forcedSubtitlesEnabled) {
            subtitleIndex = pickAudioForcedDefault();
            if (subtitleIndex !== null) {
                reason = 'forced-for-audio';
            }
        }
    }

    return {
        audio: audioSelection,
        subtitle: { index: subtitleIndex, reason },
    };
}
