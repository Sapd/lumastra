// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derive the stored title of a provider-less ("personal") episode from its
 * file name.
 *
 * The scanner used to title-case the whole basename, so a release like
 * `Show (2023) - S03E09 - 033 - Real Title [WEBDL 720p][8bit]-Erai-raws.mkv`
 * became the episode's permanent title and leaked verbatim into the
 * new-episode notification. Release-style names are now reduced to the real
 * episode title when one follows the SxxEyy token, else to `Episode N` —
 * which `push-content-text.ts` renders like any provider placeholder.
 * Plain personal-video names (`summer-holiday_2019.mp4`) keep the legacy
 * title-casing.
 */

const SE_RE = /[Ss]\d{1,4}[Ee]\d{1,4}(?:-?[Ee]\d{1,4})*/;

/** A single technical/quality token; the title ends at the first one. */
const TECH_TOKEN_RE =
    /^(?:\d{3,4}p|4K|UHD|HDR(?:10)?|DV|SDR|WEB(?:-?DL|-?Rip)?|WEBDL|BluRay|BDRip|BRRip|DVDRip|HDTV|SDTV|REMUX|x26[45]|[Hh]\.?26[45]|HEVC|AVC|AV1|XviD|AAC(?:2\.0)?|DDP?(?:5\.1|2\.0)?|E?AC3|DTS(?:-HD)?|TrueHD|Atmos|FLAC|Opus|MP3|\d{1,2}bit|Hi10P?|DSNP|NF|AMZN|ATVP|HMAX|CR|iTunes|REPACK|PROPER|COMPLETE|MULTi|DL|Dual[- ]Audio|German|English|JA|JPN|ENG|GER)$/i;

const BRACKET_RE = /\[[^\]]*\]|\{[^}]*\}/g;

/** A word that is (or glues together) technical tokens: `720p`, `WEBDL-1080p`. */
function isTechWord(word: string): boolean {
    const w = word.replace(/[(),]/g, '');
    return (
        TECH_TOKEN_RE.test(w) ||
        (w.includes('-') && w.split('-').some((p) => TECH_TOKEN_RE.test(p)))
    );
}

/** A `[...]` / `(...)` tag holding at least one technical token. */
function isTechTag(tag: string): boolean {
    return tag
        .slice(1, -1)
        .split(/[\s._+-]+/)
        .some((w) => TECH_TOKEN_RE.test(w) || /^(?:BDRip|BD|Multi)$/i.test(w));
}

/** True when a string carries release-name markers (SxxEyy, [tags], quality tokens). */
export function looksLikeReleaseName(name: string): boolean {
    if (SE_RE.test(name) || /\[[^\]]*\]/.test(name)) return true;
    return name
        .split(/[\s._]+/)
        .some((t) => /\d{3,4}p$/i.test(t) || /^(?:WEB-?DL|x26[45]|HEVC|BluRay|HDTV)$/i.test(t));
}

/**
 * True when a STORED title is a release name rather than a real episode
 * title. Stricter than {@link looksLikeReleaseName}: genuine titles carry
 * brackets too (`flowers for m[A]chine`, `The Edible Arrangement [450th
 * episode]`), so a bracket only counts when it holds a technical tag.
 */
export function isReleaseStyleTitle(title: string): boolean {
    if (SE_RE.test(title)) return true;
    const tagged = title.match(/\[[^\]]*\]|\([^)]*\)/g) ?? [];
    if (tagged.some(isTechTag)) return true;
    return title
        .split(/[\s._-]+/)
        .some(
            (t) => /^\d{3,4}p$/i.test(t) || /^(?:WEB-?DL|x26[45]|HEVC|BluRay|HDTV|AVC)$/i.test(t),
        );
}

/** A trailing ` - 07` after the series name: a bare absolute episode number. */
const BARE_ABSOLUTE_NUMBER_RE = /\s-\s*0*(\d{1,4})$/;

function legacyTitle(base: string): string {
    return base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanTitleAfterSe(input: string): string | null {
    let rest = input;
    // Drop a trailing release group glued to the last tag (`]-Erai-raws`,
    // `x264-GRP`), then every [tag]/{tag}.
    // Everything from the first technical [tag] on is tags + release group,
    // whether the group is glued (`]-Erai-raws`) or space-separated (`] Grp`).
    const firstTechTag = [...rest.matchAll(/\[[^\]]*\]/g)].find((m) => isTechTag(m[0]));
    if (firstTechTag?.index !== undefined) rest = rest.slice(0, firstTechTag.index);

    let s = rest
        .replace(/\]-[\w.-]+[[\]]*$/, ']')
        .replace(BRACKET_RE, ' ')
        // Unbalanced leftovers (`...]-GHOST][`) must not survive into a title.
        .replace(/[[\]{}]/g, ' ');
    s = s.replace(/-[A-Za-z0-9]+$/, (m, offset: number) =>
        /[\s.]/.test(s[offset - 1] ?? ' ') ? '' : m,
    );

    // Dotted scene style (no spaces): dots and underscores are word separators.
    const dotted = !/\s/.test(s.trim());
    if (dotted) s = s.replace(/[._]/g, ' ');

    // Cut at the first technical token.
    const words = s.split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    for (const w of words) {
        if (isTechWord(w)) break;
        kept.push(w);
    }

    const segments = kept
        .join(' ')
        .split(/\s+-\s+|^-\s*|\s*-$/)
        .map((seg) => seg.replace(/\(\s*\)/g, '').trim())
        // Absolute episode numbers (`033`) are a segment of their own.
        .filter((seg) => seg.length > 0 && !/^\d+$/.test(seg))
        // So is a trailing source or language tag (`The Red Codebook - DVD`). Only
        // whole segments after the first go: `DVD` inside a title ("The DVD
        // Commentary") and a title that is one such word ("Audio") stay.
        .filter((seg, i) => i === 0 || !isLanguageOrReleaseOnly(seg));

    const title = segments.join(' - ').trim();
    // Sonarr names not-yet-titled episodes `TBA` / `TBD`.
    return title.length > 0 && !/^TB[AD]$/i.test(title) ? title : null;
}

/** Language and release/source words a name carries besides the technical tokens. */
const LANGUAGE_WORD_RE =
    /^(?:JAP|JPN|JA|JP|DEU|DE|EN|Deutsch|Japanese|Dubbed|Dub|Subbed|Sub|Subs|Multi|MultiSub|Dual|Audio|OmU|OV|Bluray|BD|Web|Rip|Remux|DVD|DVD5|DVD9|VHS|PDTV|HDRip|TVRip)$/i;

/** True for a segment made only of language and release tokens (`GER-JAP`, `German DL`). */
function isLanguageOrReleaseOnly(segment: string): boolean {
    const tokens = segment.split(/[\s._()[\]{}+,-]+/).filter((t) => t.length > 0);
    return (
        tokens.length > 0 && tokens.every((t) => TECH_TOKEN_RE.test(t) || LANGUAGE_WORD_RE.test(t))
    );
}

function normalizeForCompare(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The title segments a release name carries after its SxxEyy token, split on
 * ` - `, with absolute numbers, tags and `TBA` removed. Empty when the name has
 * no SxxEyy token or no title.
 *
 * Release names often put something other than an episode title there: the
 * series name again (`S01E0422 - ONE PIECE [GER-JAP]`) or language and release
 * words that the technical-token cut did not catch (`GER-JAP`, `Dual`). Those
 * segments are dropped, so the file counts as untitled instead of carrying a
 * "title" no episode name can match. With `seriesTitle`, a segment that equals
 * or contains the series title (compared without case, accents and punctuation,
 * and without a trailing `(2004)`) is dropped as well.
 */
export function releaseTitleSegments(
    fileName: string,
    opts: { seriesTitle?: string } = {},
): string[] {
    const base = fileName.replace(/\.[A-Za-z0-9]{2,4}$/, '');
    const se = SE_RE.exec(base);
    if (!se) return [];
    const title = cleanTitleAfterSe(base.slice(se.index + se[0].length));
    if (!title) return [];
    const series = normalizeForCompare((opts.seriesTitle ?? '').replace(/\(\s*\d{4}\s*\)/g, ''));
    return title
        .split(' - ')
        .filter((seg) => seg.length > 0)
        .filter((seg) => !isLanguageOrReleaseOnly(seg))
        .filter((seg) => series.length < 3 || !normalizeForCompare(seg).includes(series));
}

/**
 * Title for a personal episode created from `fileName` (basename, extension
 * allowed). Never empty and never carries `[`/`]`.
 */
export function episodeTitleFromFileName(fileName: string, episodeNumber: number): string {
    const base = fileName.replace(/\.[A-Za-z0-9]{2,4}$/, '');
    const fallback = `Episode ${episodeNumber}`;

    if (!looksLikeReleaseName(base)) {
        // Absolute-numbered file with no title (`Series (2031) - 07`): what
        // precedes the number is the series name, so the episode's own number
        // is the only name it has.
        const bare = BARE_ABSOLUTE_NUMBER_RE.exec(base);
        if (bare && Number(bare[1]) === episodeNumber) return fallback;

        const t = legacyTitle(base).trim();
        return t.length > 0 ? t : fallback;
    }

    const se = SE_RE.exec(base);
    // No SxxEyy (fansub `[Grp] Show - 09 [720p]`): what remains is the series
    // name, not an episode title.
    if (!se) return fallback;

    return cleanTitleAfterSe(base.slice(se.index + se[0].length)) ?? fallback;
}

/**
 * Re-derive a clean title for an episode whose STORED title is a release name.
 * Prefers the current file's name; when that yields only `Episode N`, tries
 * the stored title itself (the old scanner turned ` - ` into three spaces), so
 * a title the file name no longer carries is not thrown away.
 */
export function rederiveEpisodeTitle(
    storedTitle: string,
    fileName: string,
    episodeNumber: number,
): string {
    const fromFile = episodeTitleFromFileName(fileName, episodeNumber);
    const fallback = `Episode ${episodeNumber}`;
    if (fromFile !== fallback) return fromFile;
    const fromTitle = episodeTitleFromFileName(
        `${storedTitle.replace(/ {3}/g, ' - ')}.mkv`,
        episodeNumber,
    );
    return isReleaseStyleTitle(fromTitle) ? fallback : fromTitle;
}
