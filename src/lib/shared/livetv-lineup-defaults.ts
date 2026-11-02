// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configure Lineup defaults: which of a provider's countries to pre-select so
 * an admin gets a sensible channel list with one click. Countries come from the
 * admin's browser languages ("de-DE, en" → Germany, Austria, Switzerland, UK,
 * US, ...), limited to what the provider actually carries.
 *
 * Country codes follow `channel-country.ts` (XMLTV style, `uk` for Britain).
 */

/** Countries where a language is a main broadcast language. */
const LANGUAGE_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
    de: ['de', 'at', 'ch'],
    en: ['uk', 'us', 'ca', 'ie', 'au', 'nz'],
    fr: ['fr', 'be', 'ch', 'ca', 'lu'],
    it: ['it', 'ch'],
    es: ['es', 'mx'],
    pt: ['pt', 'br'],
    nl: ['nl', 'be'],
    sv: ['se'],
    da: ['dk'],
    nb: ['no'],
    nn: ['no'],
    no: ['no'],
    fi: ['fi'],
    cs: ['cz'],
    el: ['gr'],
    sl: ['si'],
    sr: ['rs', 'ba', 'me'],
    hr: ['hr', 'ba'],
    bs: ['ba'],
    sq: ['al'],
    uk: ['ua'],
    pl: ['pl'],
    tr: ['tr'],
    ro: ['ro'],
    hu: ['hu'],
    bg: ['bg'],
    sk: ['sk'],
    ru: ['ru'],
    ar: ['arab'],
    ku: ['kurd'],
};

/** Codes never pre-selected: an admin opts into these on purpose. */
const NEVER_DEFAULT = new Set(['adult', 'religious']);

/**
 * Countries to pre-select for these browser languages, in the given order,
 * kept only when the provider has channels for them. Empty when nothing
 * matches: the dialog then keeps every country.
 */
export function defaultLineupCountries(
    languages: readonly string[],
    available: readonly string[],
): string[] {
    const have = new Set(available);
    const picked: string[] = [];
    const add = (code: string): void => {
        if (have.has(code) && !NEVER_DEFAULT.has(code) && !picked.includes(code)) {
            picked.push(code);
        }
    };
    for (const tag of languages) {
        const [lang, region] = tag.toLowerCase().split(/[-_]/);
        if (region) add(region === 'gb' ? 'uk' : region);
        // Language codes are not country codes ("ca" is Catalan, not Canada):
        // only listed languages pick countries.
        for (const code of LANGUAGE_COUNTRIES[lang] ?? []) add(code);
    }
    return picked;
}

/** The ISO 3166 code `Intl.DisplayNames` understands for a lineup country code. */
export function displayRegionCode(code: string): string | null {
    if (code === 'uk') return 'GB';
    return /^[a-z]{2}$/.test(code) ? code.toUpperCase() : null;
}
