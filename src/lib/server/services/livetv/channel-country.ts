// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Country and 24/7 detection from channel and section labels.
 *
 * Many providers carry no tvg-id (a bare `type=` playlist) or none with a
 * country suffix, but tag every channel or section with a country prefix:
 * "US: VDD", "|BG| bTV", "[DE] Nordwelle", "✦●✦ RO • GENERAL ✦●✦". This reads
 * that prefix so the lineup setup can filter by country.
 *
 * Codes match the tvg-id suffixes `extractCountryCode` produces (lowercase,
 * XMLTV style: `uk`, not `gb`), so both sources land in one vocabulary. A few
 * providers tag by language or bouquet rather than country ("AR:" Arabic,
 * "EXY:" Ex-Yugoslavia, "KU|" Kurdish); those get a region code longer than two
 * letters (`arab`, `exyu`, `kurd`) so an admin can drop them like a country.
 * Religious and adult channels get `religious` and `adult` the same way: they
 * are the groups admins most often want gone, whatever the country.
 */

/**
 * Provider prefix -> country or region code. Only unambiguous tokens: "EN",
 * "TOD" and similar tags that say nothing about a country are left out on
 * purpose. "AR" is Arabic and "CR" Christian in every provider list seen so
 * far, never Argentina or Costa Rica.
 */
const PREFIX_TO_COUNTRY: Readonly<Record<string, string>> = {
    DE: 'de',
    GER: 'de',
    AT: 'at',
    AUT: 'at',
    CH: 'ch',
    SUI: 'ch',
    UK: 'uk',
    GB: 'uk',
    US: 'us',
    USA: 'us',
    CA: 'ca',
    FR: 'fr',
    IT: 'it',
    ES: 'es',
    PT: 'pt',
    PRT: 'pt',
    NL: 'nl',
    BE: 'be',
    LU: 'lu',
    DK: 'dk',
    SE: 'se',
    NO: 'no',
    FI: 'fi',
    PL: 'pl',
    CZ: 'cz',
    SK: 'sk',
    HU: 'hu',
    RO: 'ro',
    BG: 'bg',
    GR: 'gr',
    TR: 'tr',
    AL: 'al',
    HR: 'hr',
    SRB: 'rs',
    RS: 'rs',
    BIH: 'ba',
    BA: 'ba',
    MKD: 'mk',
    MNE: 'me',
    SLO: 'si',
    SI: 'si',
    RU: 'ru',
    UA: 'ua',
    IE: 'ie',
    IN: 'in',
    AU: 'au',
    NZ: 'nz',
    BR: 'br',
    MX: 'mx',
    EGY: 'eg',
    MA: 'ma',
    DZ: 'dz',
    TUN: 'tn',
    KSA: 'sa',
    UAE: 'ae',
    IRAQ: 'iq',
    JOR: 'jo',
    KUW: 'kw',
    LEB: 'lb',
    LBY: 'ly',
    SYR: 'sy',
    QATAR: 'qa',
    OMAN: 'om',
    BAHR: 'bh',
    YEMEN: 'ye',
    SUDAN: 'sd',
    PALES: 'ps',
    AZE: 'az',
    THAI: 'th',
    AR: 'arab',
    ISLAM: 'religious',
    CR: 'religious',
    EXY: 'exyu',
    EXYU: 'exyu',
    KU: 'kurd',
};

/** Whole words that name a country in a section header ("AUSTRIA RAW", "SWISS"). */
const SECTION_WORD_TO_COUNTRY: Readonly<Record<string, string>> = {
    GERMANY: 'de',
    DEUTSCHLAND: 'de',
    AUSTRIA: 'at',
    ÖSTERREICH: 'at',
    SWISS: 'ch',
    SCHWEIZ: 'ch',
    SWITZERLAND: 'ch',
    ITALY: 'it',
    ITALIA: 'it',
    SPAIN: 'es',
    FRANCE: 'fr',
    PORTUGAL: 'pt',
    POLAND: 'pl',
    TURKEY: 'tr',
    TÜRKIYE: 'tr',
    ROMANIA: 'ro',
    GREECE: 'gr',
    NETHERLANDS: 'nl',
    BELGIUM: 'be',
    KURDISH: 'kurd',
    ARABIC: 'arab',
    RELIGIOUS: 'religious',
    CHRISTIAN: 'religious',
    ISLAMIC: 'religious',
};

/**
 * A leading tag followed by a real separator: "US:", "UK |", "DE •", "|BG|",
 * "[DE]", "(AT)", "AR_NS:", "AR-KIDS:" (the part before `_`/`-` counts), "FR- ".
 * A hyphen without a space after it does not: "HR-Kanal" and "N-Kanal" are
 * channel names, not tags.
 * Leading decoration ("✦●✦ ") is skipped.
 */
const PREFIX_RE =
    /^[^\p{L}\p{N}]*?(?:[|[(]\s*(\p{Lu}{2,5})\s*[|\])]|(\p{Lu}{2,5})(?:[_-]\p{Lu}{1,6})?\s*(?:[:|•]|-\s))/u;

/** A country written out before a spaced hyphen: "Spain- MOVISTAR 5", "Portugal - Sport 2". */
const NAMED_PREFIX_RE = /^[^\p{L}\p{N}]*?(\p{Lu}\p{L}{2,11})\s?-\s/u;

/** A trailing bracketed tag: "BEIN SPORT 3 (AR)", "Sport Klub 8 [HR]". */
const SUFFIX_RE = /[([]\s*(\p{Lu}{2,3})\s*[)\]]\s*$/u;

/** Section headers are short labels, so a plain space after the tag is enough ("DE Kinder"). */
const SECTION_PREFIX_RE = /^[^\p{L}\p{N}]*?(\p{Lu}{2,5})\s/u;

/**
 * Tags that start ordinary section titles when followed by a plain space
 * ("NO LIMIT", "IN CONCERT", "ME TIME"): the space-only form needs a tag from
 * the table above and not one of these; with a real separator ("NO:") they count.
 */
const AMBIGUOUS_SPACE_TAGS = new Set(['NO', 'IN', 'ME', 'SI']);

const WORD_RE = /\p{L}+/gu;

/** Longest label the detectors look at. */
export const MAX_LABEL = 256;

/**
 * Two-letter tags that are ISO regions but, as a channel prefix, mean something
 * else: "TV", "FM" (radio), "SD" (quality), "PM"/"AM".
 */
const NOT_A_COUNTRY_TAG = new Set(['TV', 'FM', 'AM', 'PM', 'SD']);

let regionNames: Intl.DisplayNames | null | undefined;

/**
 * Any other ISO 3166 region code counts too, so a provider's tags work without
 * being listed above. `Intl.DisplayNames` echoes a code it does not know.
 */
function isoRegion(token: string): string | undefined {
    if (token.length !== 2 || NOT_A_COUNTRY_TAG.has(token)) return undefined;
    if (regionNames === undefined) {
        try {
            regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
        } catch {
            regionNames = null;
        }
    }
    return regionNames?.of(token) ? token.toLowerCase() : undefined;
}

function tagToCountry(token: string): string | undefined {
    return PREFIX_TO_COUNTRY[token] ?? isoRegion(token);
}

/** Country code of a channel name's leading tag, or undefined when it has none. */
export function countryFromLabel(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const match = PREFIX_RE.exec(label);
    if (match) return tagToCountry(match[1] ?? match[2]);
    const named = NAMED_PREFIX_RE.exec(label);
    return named ? SECTION_WORD_TO_COUNTRY[named[1].toUpperCase()] : undefined;
}

/** Country code of a name's trailing bracketed tag ("… (AR)"), or undefined. */
export function countryFromSuffix(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const match = SUFFIX_RE.exec(label);
    return match && !QUALITY_TAG.has(match[1]) ? tagToCountry(match[1]) : undefined;
}

/** Bracketed tags at the end of a name that are feed words, not countries. */
const QUALITY_TAG = new Set(['HD', 'SD', 'FHD', 'UHD', 'TV', 'FM', 'AM', 'PM', 'ALT', 'WEB']);

/**
 * The name without its leading country tag ("AT: TORQ HD" -> "TORQ HD"), or
 * undefined when it has none. Only a tag that resolves to a country counts.
 */
export function stripCountryTag(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const match = PREFIX_RE.exec(label);
    let tagLength: number | undefined;
    if (match) {
        if (tagToCountry(match[1] ?? match[2])) tagLength = match[0].length;
    } else {
        const named = NAMED_PREFIX_RE.exec(label);
        if (named && SECTION_WORD_TO_COUNTRY[named[1].toUpperCase()]) {
            tagLength = named[0].length;
        }
    }
    if (tagLength === undefined) return undefined;
    // A bare tag ("DE:") is no name.
    return label.slice(tagLength).trim() || undefined;
}

/**
 * ccTLDs that ids use as words or generic domains (".tv", ".co", ".io"),
 * never meaning the country.
 */
const GUIDE_ID_NOT_COUNTRY = new Set(['CO', 'IO', 'ME', 'TO', 'CC', 'WS', 'AI', 'LY', 'EU', 'GG']);

/**
 * Country code of a guide (XMLTV) channel id's suffix: "TORQ.uk" -> "uk",
 * "KWF.de" -> "de". Same vocabulary as the label tags ("gb" -> "uk"); a suffix
 * that is no country (".tv", ".co") gives undefined.
 */
export function countryFromGuideId(id: string | undefined): string | undefined {
    if (!id) return undefined;
    // "KWF.de@SD": iptv-org style ids carry a feed after "@".
    const match = /\.([a-z]{2})(?:@[\w-]+)?$/i.exec(id);
    if (!match) return undefined;
    const tag = match[1].toUpperCase();
    return GUIDE_ID_NOT_COUNTRY.has(tag) ? undefined : tagToCountry(tag);
}

/**
 * A playlist's raw tvg-id suffix ("gb", "tv") as a lineup country: the label
 * vocabulary ("gb" -> "uk"), or undefined when the suffix is no country (".tv").
 */
export function countryFromTvgSuffix(code: string | undefined): string | undefined {
    if (!code) return undefined;
    return code.length === 2 ? countryFromGuideId(`x.${code.toLowerCase()}`) : code;
}

/**
 * Country code of a section header ("✦●✦ DE • Local RAW ✦●✦" after
 * `separatorLabel`, or a group-title): the leading tag, then a country named
 * anywhere in it ("SPORT AUSTRIA RAW").
 */
export function countryFromSection(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const tagged = countryFromLabel(label);
    if (tagged) return tagged;
    const lead = SECTION_PREFIX_RE.exec(label);
    if (lead && !AMBIGUOUS_SPACE_TAGS.has(lead[1]) && PREFIX_TO_COUNTRY[lead[1]]) {
        return PREFIX_TO_COUNTRY[lead[1]];
    }
    for (const word of label.toUpperCase().match(WORD_RE) ?? []) {
        const country = SECTION_WORD_TO_COUNTRY[word];
        if (country) return country;
    }
    return undefined;
}

/**
 * A 24/7 loop channel: one show or one theme around the clock ("24/7 • Seabright",
 * "7/24 | PARADE MÜZİK 1", "24-7 Hafenbande"). Matches the tag at the start of the
 * name only, after decoration, so a name that merely mentions 24/7 later stays
 * ("Orb 24/7 News", "[Not 24/7]").
 */
const LOOP_RE = /^[^\p{L}\p{N}]*(?:24\s?[/x-]\s?7|7\s?\/\s?24)(?!\d)/iu;

/** One episode on repeat ("Max der Maurer S2 E5"): not live either. */
const EPISODE_RE = /(?:^|[^\p{L}\p{N}])S\d{1,2}\s?E\d{1,3}(?![\p{L}\p{N}])/u;

export function isLoopChannel(label: string | undefined): boolean {
    return label ? LOOP_RE.test(label) || EPISODE_RE.test(label) : false;
}

/**
 * Adult content by name or section: "xXx • German Mix", "+18 • Adult 1",
 * "PORNDECK: …", sections "ADULT XXX" / "StreamTV Porn". "Adult" counts at the
 * end of a label or before a number, a symbol, "XXX", "TV" or "channel"; before
 * another word it is part of a programme name and stays out.
 */
const ADULT_RE =
    /(?:^|[^\p{L}\p{N}])(?:x{3}|porn\p{L}*|adults?(?=\s*(?:$|[^\p{L}\s]|\p{N}|xxx|tv\b|channels?|only|content|movies?|films?|entertainment))|adult[eo]s?|eroti[ck]\p{L}*|для взрослых|18\+|\+\s?18)(?![\p{L}\p{N}])/iu;

export function isAdultLabel(label: string | undefined): boolean {
    return label ? ADULT_RE.test(label) : false;
}

/**
 * Religious broadcasting by keyword, whatever the country tag ("ISLAM: SAUDI
 * QURAN", "TR: DINI …", "CR: CHRISTIAN", "Heavenly TV" stays: no keyword).
 */
const RELIGIOUS_RE =
    /(?:^|[^\p{L}\p{N}])(?:islam\p{L}*|quran|coran|kuran|sunnah|gospel|christ(?:ian|lich)\p{L}*|bible|bibel|church|kirche|catholic|katholisch\p{L}*|evangel(?:ical|isch\p{L}*|ium|ico|ique)?|relig\p{L}*|iglesia|chiesa|igreja|d[iİı]n[iİı])(?![\p{L}\p{N}])/iu;

export function isReligiousLabel(label: string | undefined): boolean {
    return label ? RELIGIOUS_RE.test(label) : false;
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const UKRAINIAN_RE = /[іїєґІЇЄҐ]/u;
const SERBIAN_RE = /[ђјљњћџЂЈЉЊЋЏ]/u;
const MACEDONIAN_RE = /[ѓќѕЃЌЅ]/u;
const RUSSIAN_ONLY_RE = /[ыэёЫЭЁ]/u;

/**
 * A section written in Cyrillic ("Основные", "Детские") is a Russian-language
 * block even when its channels carry Latin names ("Wanderer Channel HD");
 * Ukrainian, Serbian or Macedonian letters, or Bulgarian spelling, say otherwise.
 */
function countryFromScript(section: string | undefined): string | undefined {
    if (!section || !CYRILLIC_RE.test(section)) return undefined;
    if (UKRAINIAN_RE.test(section)) return 'ua';
    if (SERBIAN_RE.test(section)) return 'rs';
    if (MACEDONIAN_RE.test(section)) return 'mk';
    // Bulgarian has no letters of its own but uses ъ in the middle of words a
    // lot and never ы/э/ё; anything else is read as Russian.
    if (!RUSSIAN_ONLY_RE.test(section) && /ъ/iu.test(section)) return 'bg';
    return 'ru';
}

/** Regions whose channels may also carry their member countries' own tags. */
const REGION_MEMBERS: Readonly<Record<string, readonly string[]>> = {
    exyu: ['rs', 'hr', 'ba', 'mk', 'me', 'si'],
    arab: [
        'eg',
        'iq',
        'ma',
        'dz',
        'tn',
        'sa',
        'ae',
        'jo',
        'kw',
        'lb',
        'ly',
        'sy',
        'qa',
        'om',
        'bh',
        'ye',
        'sd',
        'ps',
    ],
};

/** The codes to keep for a selection: a region keeps its member countries too. */
export function expandRegions(codes: readonly string[]): Set<string> {
    const out = new Set(codes);
    for (const code of codes) for (const member of REGION_MEMBERS[code] ?? []) out.add(member);
    return out;
}

/**
 * The region a channel belongs to for lineup filtering: adult, then religious
 * (either is that whatever its country), then the playlist's own country code
 * (tvg-id), the channel name's tag, the section or group it sits in, and the
 * section's script.
 */
export function detectChannelRegion(
    name: string,
    section: string | undefined,
    tvgCountry: string | undefined,
): string | undefined {
    // Labels are short; a hostile playlist must not feed megabyte names to the
    // Unicode regexes below.
    name = name.slice(0, MAX_LABEL);
    section = section?.slice(0, MAX_LABEL);
    if (isAdultLabel(name) || isAdultLabel(section)) return 'adult';
    if (isReligiousLabel(name) || isReligiousLabel(section)) return 'religious';
    // The name's own tag is the provider's deliberate label; tvg-ids are reused
    // loosely across countries ("UK: Comedy Central" carrying a ".ch" id).
    return (
        countryFromLabel(name) ??
        countryFromSuffix(name) ??
        countryFromTvgSuffix(tvgCountry) ??
        countryFromSection(section) ??
        countryFromScript(section)
    );
}
