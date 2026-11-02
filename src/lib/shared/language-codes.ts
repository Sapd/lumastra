// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// ============================================
// Language Normalization Utilities
//
// The single language table in the codebase. Both server (HLS manifest
// generation, transcoding, DB rollups) and client (player track pickers,
// language badges) import from here, so a language code means the same
// thing everywhere.
// ============================================

// Map of various language codes/names to normalized ISO 639-1 codes
const LANGUAGE_NORMALIZATION_MAP: Record<string, string> = {
    // German
    ger: 'de',
    deu: 'de',
    german: 'de',
    deutsch: 'de',
    de: 'de',
    // English
    eng: 'en',
    english: 'en',
    en: 'en',
    // French
    fra: 'fr',
    fre: 'fr',
    french: 'fr',
    français: 'fr',
    francais: 'fr',
    fr: 'fr',
    // Spanish
    spa: 'es',
    spanish: 'es',
    español: 'es',
    espanol: 'es',
    es: 'es',
    // Italian
    ita: 'it',
    italian: 'it',
    italiano: 'it',
    it: 'it',
    // Portuguese
    por: 'pt',
    portuguese: 'pt',
    português: 'pt',
    portugues: 'pt',
    pt: 'pt',
    // Russian
    rus: 'ru',
    russian: 'ru',
    русский: 'ru',
    ru: 'ru',
    // Japanese
    jpn: 'ja',
    jap: 'ja',
    japanese: 'ja',
    日本語: 'ja',
    ja: 'ja',
    // Chinese — 'cn' is TMDB's own tag for Chinese-language titles and is NOT
    // ISO 639-1. It reaches us through provider_metadata.original_language
    // (272 titles on prod), where leaving it unmapped meant it never matched a
    // file's chi/zho audio tag.
    chi: 'zh',
    zho: 'zh',
    cn: 'zh',
    chinese: 'zh',
    中文: 'zh',
    zh: 'zh',
    // Korean
    kor: 'ko',
    korean: 'ko',
    한국어: 'ko',
    ko: 'ko',
    // Arabic
    ara: 'ar',
    arabic: 'ar',
    العربية: 'ar',
    ar: 'ar',
    // Dutch
    dut: 'nl',
    nld: 'nl',
    dutch: 'nl',
    nederlands: 'nl',
    nl: 'nl',
    // Polish
    pol: 'pl',
    polish: 'pl',
    polski: 'pl',
    pl: 'pl',
    // Turkish
    tur: 'tr',
    turkish: 'tr',
    türkçe: 'tr',
    turkce: 'tr',
    tr: 'tr',
    // Swedish
    swe: 'sv',
    swedish: 'sv',
    svenska: 'sv',
    sv: 'sv',
    // Norwegian
    nor: 'no',
    nob: 'no',
    nno: 'no',
    norwegian: 'no',
    norsk: 'no',
    no: 'no',
    // Danish
    dan: 'da',
    danish: 'da',
    dansk: 'da',
    da: 'da',
    // Finnish
    fin: 'fi',
    finnish: 'fi',
    suomi: 'fi',
    fi: 'fi',
    // Greek
    gre: 'el',
    ell: 'el',
    greek: 'el',
    ελληνικά: 'el',
    el: 'el',
    // Hebrew
    heb: 'he',
    hebrew: 'he',
    עברית: 'he',
    he: 'he',
    // Hindi
    hin: 'hi',
    hindi: 'hi',
    हिन्दी: 'hi',
    hi: 'hi',
    // Thai
    tha: 'th',
    thai: 'th',
    ไทย: 'th',
    th: 'th',
    // Vietnamese
    vie: 'vi',
    vietnamese: 'vi',
    'tiếng việt': 'vi',
    vi: 'vi',
    // Czech
    cze: 'cs',
    ces: 'cs',
    czech: 'cs',
    čeština: 'cs',
    cestina: 'cs',
    cs: 'cs',
    // Hungarian
    hun: 'hu',
    hungarian: 'hu',
    magyar: 'hu',
    hu: 'hu',
    // Romanian
    rum: 'ro',
    ron: 'ro',
    romanian: 'ro',
    română: 'ro',
    romana: 'ro',
    ro: 'ro',
    // Ukrainian
    ukr: 'uk',
    ukrainian: 'uk',
    українська: 'uk',
    uk: 'uk',
    // Indonesian
    ind: 'id',
    indonesian: 'id',
    'bahasa indonesia': 'id',
    id: 'id',
    // Malay
    may: 'ms',
    msa: 'ms',
    malay: 'ms',
    'bahasa melayu': 'ms',
    ms: 'ms',
    // Below: languages that appear in TMDB `original_language` on prod but had
    // no entry, so a 639-1 preference could never match a 639-2 file tag.
    // Tagalog / Filipino
    tgl: 'tl',
    tagalog: 'tl',
    fil: 'tl',
    filipino: 'tl',
    tl: 'tl',
    // Telugu
    tel: 'te',
    telugu: 'te',
    te: 'te',
    // Tamil
    tam: 'ta',
    tamil: 'ta',
    ta: 'ta',
    // Persian
    per: 'fa',
    fas: 'fa',
    persian: 'fa',
    farsi: 'fa',
    fa: 'fa',
    // Malayalam
    mal: 'ml',
    malayalam: 'ml',
    ml: 'ml',
    // Bengali
    ben: 'bn',
    bengali: 'bn',
    bn: 'bn',
    // Marathi
    mar: 'mr',
    marathi: 'mr',
    mr: 'mr',
    // Kannada
    kan: 'kn',
    kannada: 'kn',
    kn: 'kn',
    // Punjabi
    pan: 'pa',
    punjabi: 'pa',
    pa: 'pa',
    // Gujarati
    guj: 'gu',
    gujarati: 'gu',
    gu: 'gu',
    // Urdu
    urd: 'ur',
    urdu: 'ur',
    ur: 'ur',
    // Icelandic
    ice: 'is',
    isl: 'is',
    icelandic: 'is',
    is: 'is',
    // Estonian
    est: 'et',
    estonian: 'et',
    et: 'et',
    // Latvian
    lav: 'lv',
    latvian: 'lv',
    lv: 'lv',
    // Lithuanian
    lit: 'lt',
    lithuanian: 'lt',
    lt: 'lt',
    // Slovak
    slo: 'sk',
    slk: 'sk',
    slovak: 'sk',
    sk: 'sk',
    // Slovenian
    slv: 'sl',
    slovenian: 'sl',
    sl: 'sl',
    // Croatian
    hrv: 'hr',
    croatian: 'hr',
    hr: 'hr',
    // Serbian
    srp: 'sr',
    serbian: 'sr',
    sr: 'sr',
    // Bulgarian
    bul: 'bg',
    bulgarian: 'bg',
    bg: 'bg',
    // Catalan
    cat: 'ca',
    catalan: 'ca',
    ca: 'ca',
};

/**
 * Normalize a language code/name to a standard ISO 639-1 code.
 * Handles various formats: ISO 639-1 (de), ISO 639-2/B (ger), ISO 639-2/T (deu), full names (German).
 * Returns lowercase normalized code, or the original value lowercased if not recognized.
 */
export function normalizeLanguage(lang: string | undefined | null): string {
    if (!lang) return '';
    const lower = lang.toLowerCase().trim();
    if (Object.hasOwn(LANGUAGE_NORMALIZATION_MAP, lower)) return LANGUAGE_NORMALIZATION_MAP[lower];
    const [base, ...qualifiers] = lower.replace(/_/g, '-').split('-');
    const normalized = Object.hasOwn(LANGUAGE_NORMALIZATION_MAP, base)
        ? LANGUAGE_NORMALIZATION_MAP[base]
        : base;
    return [normalized, ...qualifiers].join('-');
}

/**
 * Check if two language codes/names represent the same language.
 * Uses normalization to handle different formats (ger/deu/German all match).
 */
export function languagesMatch(
    lang1: string | undefined | null,
    lang2: string | undefined | null,
): boolean {
    const normalized1 = normalizeLanguage(lang1);
    const normalized2 = normalizeLanguage(lang2);
    if (isUnknownLanguage(normalized1) || isUnknownLanguage(normalized2)) return false;
    if (normalized1 === normalized2) return true;
    return (
        (!normalized1.includes('-') || !normalized2.includes('-')) &&
        normalized1.split('-')[0] === normalized2.split('-')[0]
    );
}

/** Exact tags outrank compatible base-language matches; unknown tags never match. */
export function languageMatchScore(
    candidate: string | null | undefined,
    preferred: string | null | undefined,
): number {
    if (!languagesMatch(candidate, preferred)) return 0;
    return normalizeLanguage(candidate) === normalizeLanguage(preferred) ? 2 : 1;
}

export function bestLanguageMatch<T>(
    candidates: T[],
    language: string | null | undefined,
    getLanguage: (candidate: T) => string | null | undefined,
): T | undefined {
    let best: T | undefined;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = languageMatchScore(getLanguage(candidate), language);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

/**
 * A language tag carries no useful information when it's absent, empty,
 * or one of the ISO catch-all markers ("und" undetermined, "mis" uncoded,
 * "mul" multiple, "zxx" no linguistic content, "xx" TMDB's own marker for
 * no linguistic content). Treat all of these as "unknown" for selection /
 * matching purposes.
 */
export function isUnknownLanguage(lang: string | undefined | null): boolean {
    const norm = normalizeLanguage(lang).split('-')[0];
    return (
        !norm ||
        norm === 'und' ||
        norm === 'mis' ||
        norm === 'mul' ||
        norm === 'zxx' ||
        norm === 'xx'
    );
}

// ISO 639-1 -> ISO 639-2/B (3-letter, bibliographic form — what ffmpeg emits,
// e.g. 'ger' not 'deu' for German). Built once at module scope and inverted
// for lookups from the 639-1 form produced by normalizeLanguage.
const ISO6391_TO_6392B: Record<string, string> = {
    de: 'ger',
    en: 'eng',
    fr: 'fre',
    es: 'spa',
    it: 'ita',
    pt: 'por',
    ru: 'rus',
    ja: 'jpn',
    zh: 'chi',
    ko: 'kor',
    ar: 'ara',
    nl: 'dut',
    pl: 'pol',
    tr: 'tur',
    sv: 'swe',
    no: 'nor',
    da: 'dan',
    fi: 'fin',
    el: 'gre',
    he: 'heb',
    hi: 'hin',
    th: 'tha',
    vi: 'vie',
    cs: 'cze',
    hu: 'hun',
    ro: 'rum',
    uk: 'ukr',
    id: 'ind',
    ms: 'may',
    tl: 'tgl',
    te: 'tel',
    ta: 'tam',
    fa: 'per',
    ml: 'mal',
    bn: 'ben',
    mr: 'mar',
    kn: 'kan',
    pa: 'pan',
    gu: 'guj',
    ur: 'urd',
    is: 'ice',
    et: 'est',
    lv: 'lav',
    lt: 'lit',
    sk: 'slo',
    sl: 'slv',
    hr: 'hrv',
    sr: 'srp',
    bg: 'bul',
    ca: 'cat',
};

/**
 * Convert a language code/name to ISO 639-2/B (3-letter) for HLS manifests,
 * which need that form for the `LANGUAGE` attribute. Returns null for tags
 * that name no language, and passes through an unmapped 3-letter tag
 * unchanged (it's already in some 639-2 form we don't have a 639-1 mapping
 * for) rather than guessing.
 */
export function toIso6392B(lang: string | null | undefined): string | null {
    if (isUnknownLanguage(lang)) return null;
    const normalized = normalizeLanguage(lang).split('-')[0];
    return Object.hasOwn(ISO6391_TO_6392B, normalized)
        ? ISO6391_TO_6392B[normalized]
        : normalized.length === 3
          ? normalized
          : null;
}

// ISO 639-2/B -> ISO 639-2/T where the two differ (the terminological form,
// e.g. 'deu' for German). Every other code is the same in both.
const ISO6392B_TO_6392T: Record<string, string> = {
    alb: 'sqi',
    arm: 'hye',
    baq: 'eus',
    bur: 'mya',
    chi: 'zho',
    cze: 'ces',
    dut: 'nld',
    fre: 'fra',
    geo: 'kat',
    ger: 'deu',
    gre: 'ell',
    ice: 'isl',
    mac: 'mkd',
    mao: 'mri',
    may: 'msa',
    per: 'fas',
    rum: 'ron',
    slo: 'slk',
    tib: 'bod',
    wel: 'cym',
};

/**
 * Convert a language code/name to ISO 639-2/T (3-letter, terminological form:
 * 'deu', 'fra'), the form Jellyfin 10.11+ uses for its culture codes and user
 * language preferences. Null for tags that name no language.
 */
export function toIso6392T(lang: string | null | undefined): string | null {
    const b = toIso6392B(lang);
    return b ? (Object.hasOwn(ISO6392B_TO_6392T, b) ? ISO6392B_TO_6392T[b] : b) : null;
}

/**
 * A language's name in the reader's own language — "Japanisch" for a German
 * viewer, "Japanese" for an English one.
 *
 * `Intl.DisplayNames` carries the full CLDR set and is already localized, so
 * it covers every language in {@link LANGUAGE_NORMALIZATION_MAP} without a
 * hand-maintained name table.
 *
 * Returns '' for tags that name no language (absent, `und`, `mis`, `mul`,
 * `zxx`, and TMDB's `xx`) so callers can omit the phrase rather than print a
 * placeholder, and falls back to the uppercased code only when the tag is
 * genuinely unknown (not a 2-letter ISO 639-1 code after normalization).
 */
export function localizedLanguageName(code: string | null | undefined, locale: string): string {
    const raw = code?.trim().toLowerCase() ?? '';
    if (isUnknownLanguage(raw)) return '';

    // An unmapped 3+-letter tag isn't truncated to 2 letters (slicing 'est'
    // would land on Spanish's 'es'), so render such a tag as itself: the
    // caller interpolates this mid-sentence, and returning '' would read as
    // "your default audio language ()."
    const normalized = normalizeLanguage(raw);
    if (normalized.length !== 2) return raw.toUpperCase();

    try {
        const name = new Intl.DisplayNames([locale], { type: 'language' }).of(normalized);
        if (name && name.toLowerCase() !== normalized.toLowerCase()) return name;
    } catch {
        // Unsupported locale or malformed tag — fall through to the code.
    }
    return normalized.toUpperCase();
}
