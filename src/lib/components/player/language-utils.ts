// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export { normalizeLanguage, languagesMatch, isUnknownLanguage } from '$lib/shared/language-codes';

import {
    isUnknownLanguage,
    localizedLanguageName,
    normalizeLanguage,
} from '$lib/shared/language-codes';
import * as m from '$lib/paraglide/messages';

/**
 * Human language name for a track tag, in the UI locale ("German" /
 * "Deutsch" for `ger`), or '' when the tag carries no language.
 *
 * The track menu showed raw ISO 639-2 codes — GER, BAQ, NOB, FIL (Windows e2e
 * 2026-09-27, polish). `localizedLanguageName` covers every tag the shared
 * normalization table maps to ISO 639-1; for the rest (e.g. `baq`, which the
 * table lacks) Intl.DisplayNames is asked with the raw 3-letter tag, which it
 * understands too, before falling back to the upper-cased code.
 */
export function trackLanguageName(code: string | null | undefined, locale: string): string {
    const name = localizedLanguageName(code, locale);
    const raw = code?.trim() ?? '';
    if (!name || name !== raw.toUpperCase()) return name;
    try {
        const viaIntl = new Intl.DisplayNames([locale], { type: 'language' }).of(raw.toLowerCase());
        if (viaIntl && viaIntl.toLowerCase() !== raw.toLowerCase()) return viaIntl;
    } catch {
        // Not a well-formed BCP 47 tag — keep the code.
    }
    return name;
}

export interface SubtitleLabelInput {
    language?: string | null;
    /** The stream's own title metadata, e.g. "Forced", "SDH", "Signs & Songs". */
    title?: string | null;
    forced?: boolean;
    /** Hearing-impaired flag (external sidecars carry it; embedded tracks only by title). */
    hearingImpaired?: boolean;
}

/**
 * The words a title may consist of without adding anything the label does not
 * already say: the language itself, the forced/SDH markers, and filler.
 */
function isRedundantTitle(
    title: string,
    language: string | null | undefined,
    name: string,
): boolean {
    const noise = new Set(['forced', 'sdh', 'full', 'subtitles', 'subs', 'sub', 'default']);
    const lang = (language ?? '').toLowerCase();
    const langNames = new Set([lang, normalizeLanguage(language), name.toLowerCase()]);
    try {
        const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(
            normalizeLanguage(language) || lang,
        );
        if (english) langNames.add(english.toLowerCase());
    } catch {
        // ignore — the other spellings still apply
    }
    const words = title
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    return words.every((w) => noise.has(w) || langNames.has(w));
}

/**
 * Display title for a subtitle track: "German (Forced)", "English (SDH)",
 * "Japanese — Signs & Songs".
 *
 * Two German SRT tracks, one forced, used to both read "GER SRT" (polish item
 * of the same e2e). The forced/SDH qualifiers make them distinguishable, and a
 * meaningful stream title is kept. The raw title is kept verbatim (not
 * translated) because code downstream reads it: the forced heuristic looks for
 * "forced" and the SDH badge for "SDH" in the display title.
 */
export function buildSubtitleDisplayTitle(track: SubtitleLabelInput, locale: string): string {
    const name = trackLanguageName(track.language, locale) || m.player_track_unknown_language();
    const title = track.title?.trim() ?? '';
    const titleSaysSdh = /\bsdh\b/i.test(title);
    const qualifiers: string[] = [];
    if (track.forced) qualifiers.push(m.player_track_forced_suffix());
    if (track.hearingImpaired && !titleSaysSdh) qualifiers.push('SDH');
    let label = qualifiers.length > 0 ? `${name} (${qualifiers.join(', ')})` : name;
    if (title && !isRedundantTitle(title, track.language, name)) {
        label += ` — ${title}`;
    } else if (title && (titleSaysSdh || (/\bforced\b/i.test(title) && !track.forced))) {
        // Redundant for a reader, but the SDH badge and the title-based forced
        // heuristic read these words from the display title — keep them.
        label += ` — ${title}`;
    }
    return label;
}

/** Accessible name for an audio track button ("Audio track: German 5.1"). */
export function audioTrackAccessibleName(languageLabel: string, channels?: string): string {
    return m.player_audio_track_aria({
        label: channels ? `${languageLabel} ${channels}` : languageLabel,
    });
}

/** Accessible name for a subtitle track button ("Subtitles: German (Forced)"). */
export function subtitleTrackAccessibleName(displayTitle: string): string {
    return m.player_subtitle_track_aria({ label: displayTitle });
}

export interface SubtitleChipInput {
    index: number;
    /** The track's display title ("Deutsch (Erzwungen)", "English (SDH)"). */
    label: string;
    /** Short codec type ("SRT", "PGS") or null. */
    codecType: string | null;
}

/**
 * One distinct label per subtitle chip, for both the visible text and the
 * accessible name.
 *
 * Files with dozens of tracks often carry several untitled tracks of one
 * language, which all read "Deutsch" — screen readers announced
 * "Untertitel: Deutsch" twice and sighted users saw identical chips (Windows
 * e2e 2026-09-27 follow-up). Colliding labels get the codec type appended,
 * and whatever still collides a 1-based track number within its group.
 * Labels that are already unique are returned unchanged.
 */
export function distinctSubtitleChipLabels(tracks: SubtitleChipInput[]): Map<number, string> {
    const countBy = (labels: Map<number, string>): Map<string, number> => {
        const counts = new Map<string, number>();
        for (const l of labels.values()) counts.set(l, (counts.get(l) ?? 0) + 1);
        return counts;
    };
    const labels = new Map(tracks.map((t) => [t.index, t.label]));
    let counts = countBy(labels);
    for (const t of tracks) {
        if ((counts.get(t.label) ?? 0) > 1 && t.codecType) {
            labels.set(t.index, `${t.label} · ${t.codecType}`);
        }
    }
    counts = countBy(labels);
    const seen = new Map<string, number>();
    for (const t of tracks) {
        const label = labels.get(t.index) ?? t.label;
        if ((counts.get(label) ?? 0) > 1) {
            const n = (seen.get(label) ?? 0) + 1;
            seen.set(label, n);
            labels.set(t.index, `${label} · ${m.player_subtitle_track_ordinal({ n: String(n) })}`);
        }
    }
    return labels;
}

/**
 * Build a short language-style label for an audio track, suitable for the
 * track-picker chip. Falls back gracefully when the file lacks proper
 * language metadata:
 *
 *   1. Prefer `track.language` (e.g. "GER", "ENG").
 *   2. Treat ISO 639 "und"/"mis"/"mul"/"zxx" (and TMDB's "xx") as missing —
 *      they're technically valid but carry no useful information in a UI chip.
 *      The list is `isUnknownLanguage`'s; keep them in step.
 *   3. Otherwise use the first 3 alphanumeric chars of `displayTitle` —
 *      *unless* the title begins with the codec name. Files with
 *      title="AC3 5.1 @ 640 kbps" must not display "AC3" as if it were a
 *      language (it's just the codec, indistinguishable from other AC3
 *      tracks).
 *   4. Final fallback is "UNK".
 */
export function formatAudioTrackLabel(track: {
    language?: string;
    displayTitle?: string;
    codec?: string;
}): string {
    // Same set isUnknownLanguage() treats as carrying no information — keep the
    // two in step so a tag never shows as a language in one place and counts as
    // absent in the other.
    let lang = isUnknownLanguage(track.language) ? '' : (track.language?.toUpperCase() ?? '');

    if (!lang && track.displayTitle && track.codec && track.codec.length > 0) {
        const codecUpper = track.codec.toUpperCase();
        const titleClean = track.displayTitle.toUpperCase().replace(/^[^A-Z0-9]+/, '');
        if (titleClean && !titleClean.startsWith(codecUpper)) {
            lang = titleClean.slice(0, 3);
        }
    }

    return lang || 'UNK';
}
