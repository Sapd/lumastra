// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Map certification strings from the national rating systems to a numeric
 * minimum age.
 *
 * Covered: German FSK, US MPAA and TV Parental Guidelines, UK BBFC, Australian
 * classification, Dutch Kijkwijzer, French CNC, Spanish ICAA, plus the generic
 * `12+` / `+12` / bare-number forms and the `Country:Rating` prefixes that NFO
 * files and Jellyfin/Kodi emit (`Germany:FSK 12`, `DE:12`, `Rated PG-13`).
 *
 * Priority: exact match in the lookup table (spaces, underscores and hyphens
 * ignored, so `FSK-12`, `TV-MA` and `TVMA` are one key) → number patterns → null.
 * `NR` / `Unrated` map to null on purpose: "no rating" must stay NULL, never 0.
 */
const CERTIFICATION_MAP: Record<string, number> = {
    // MPAA (US movies)
    G: 0,
    PG: 8,
    PG13: 13,
    R: 17,
    NC17: 18,
    // US TV Parental Guidelines
    TVY: 0,
    TVY7: 7,
    TVY7FV: 7,
    TVG: 0,
    TVPG: 10,
    TV14: 14,
    TVMA: 18,
    // UK BBFC
    U: 0,
    UC: 0,
    R18: 18,
    // Australia
    E: 0, // Exempt
    M: 15, // Recommended for mature audiences (advisory, not a restriction)
    X18: 18,
    X: 18,
    XXX: 18,
    // Netherlands (Kijkwijzer), France (CNC), Spain (ICAA), Germany: "all ages" forms
    AL: 0,
    TP: 0,
    TOUSPUBLICS: 0,
    APTA: 0,
    TODOSLOSPUBLICOS: 0,
    TODOSLOSPÚBLICOS: 0,
    OA: 0,
    FSKOA: 0,
    FSK0: 0,
    // German "not suitable for minors" (BPjM list / no youth release): treated as 18
    BPJM: 18,
    BPJMRESTRICTED: 18,
    KEINEJUGENDFREIGABE: 18,
    // Unrated markers → null (handled separately)
    NR: -1,
    NOTRATED: -1,
    UNRATED: -1,
    UNRATEDMOVIE: -1,
    NA: -1,
    'N/A': -1,
    NONE: -1,
};

// Patterns with embedded numbers, tried against the original (trimmed) string.
const NUMERIC_PATTERNS = [
    /^FSK[\s:_-]*(?:AB\s*)?(\d{1,2})\+?(?:\s*JAHRE[N]?)?$/i, // FSK 12, FSK-12, FSK12, FSK ab 12
    /^AB\s*(\d{1,2})(?:\s*JAHRE[N]?)?$/i, // ab 12, ab 12 Jahren
    /^[-+]?(\d{1,2})A?\+?$/, // 12, 12A, 12+, +12, -12 (FR), bare numbers
    /^MA\s*(\d{1,2})\+?$/i, // MA15+, MA 15+ (Australia)
    /^[RX]\s*(\d{1,2})\+?$/i, // R18+, R18, X18+ (Australia / BBFC)
    /^PG[\s-]?(\d{1,2})$/i, // PG-13, PG 13
    /^NC[\s-]?(\d{1,2})$/i, // NC-17
    /^TV[\s-]?(\d{2})$/i, // TV-14, TV14
    /^(?:KIJKWIJZER|NICAM)[\s:_-]*(\d{1,2})\+?$/i, // Kijkwijzer 12
    /^(?:DE|NL|FR|ES|GB|UK|AU|US)[\s_-]+(\d{1,2})\+?$/i, // DE-12, NL 16
    // No greedy fallback — unrecognized strings return null (unrated).
    // This prevents false positives like "Season 2" → age 2.
];

/** Country names and codes that may prefix a rating ("Germany:FSK 12", "DE:12"), mapped to the code. */
export const COUNTRY_PREFIXES: Record<string, string> = {
    de: 'DE',
    ger: 'DE',
    germany: 'DE',
    deutschland: 'DE',
    us: 'US',
    usa: 'US',
    'united states': 'US',
    america: 'US',
    gb: 'GB',
    uk: 'GB',
    'united kingdom': 'GB',
    'great britain': 'GB',
    england: 'GB',
    au: 'AU',
    australia: 'AU',
    nl: 'NL',
    netherlands: 'NL',
    'the netherlands': 'NL',
    holland: 'NL',
    fr: 'FR',
    france: 'FR',
    es: 'ES',
    spain: 'ES',
    spanien: 'ES',
};

/** Rating-system names that may prefix a value ("FSK: 12", "MPAA: R"). */
export const SYSTEM_PREFIXES = new Set([
    'fsk',
    'mpaa',
    'mpa',
    'bbfc',
    'acb',
    'classification',
    'kijkwijzer',
    'nicam',
    'cnc',
    'icaa',
    'rated',
    'rating',
    'certification',
    'tv',
]);

/**
 * `Germany:FSK 12`, `DE:12`, `Rated PG-13` -> the rating part. Only known
 * countries and rating-system names count as a prefix: "Sweden:15" or "Taiwan:R"
 * are other countries' systems and must not be read as ours.
 */
function stripPrefix(value: string): string {
    let result = value.trim();
    result = result.replace(/^rated\s+/i, '');
    const m = result.match(/^([A-Za-z][A-Za-z .]*?)\s*:\s*(?=\S)/);
    if (m) {
        const prefix = m[1]!.trim().toLowerCase();
        if (COUNTRY_PREFIXES[prefix] !== undefined || SYSTEM_PREFIXES.has(prefix)) {
            result = result.slice(m[0].length);
        }
    }
    return result.trim();
}

function normalizeKey(value: string): string {
    return value.toUpperCase().replace(/[\s_.-]+/g, '');
}

function fromNumber(match: RegExpMatchArray | null): number | null {
    if (!match?.[1]) return null;
    const age = parseInt(match[1], 10);
    return Number.isFinite(age) && age >= 0 && age <= 21 ? age : null;
}

/**
 * Convert a certification string to a numeric minimum age.
 *
 * @returns The minimum age as an integer, or null if unrated/unparseable.
 */
export function certificationToAge(certification: string | null | undefined): number | null {
    if (!certification) return null;

    const trimmed = certification.trim();
    if (!trimmed) return null;

    // Try the string as given first (a bare "Germany: 12" must not lose data),
    // then with the "Country:" / "Rated " prefix removed.
    const candidates = [trimmed];
    const stripped = stripPrefix(trimmed);
    if (stripped && stripped !== trimmed) candidates.push(stripped);

    for (const candidate of candidates) {
        const exact = CERTIFICATION_MAP[normalizeKey(candidate)];
        if (exact !== undefined) {
            return exact === -1 ? null : exact;
        }
        for (const pattern of NUMERIC_PATTERNS) {
            const age = fromNumber(candidate.match(pattern));
            if (age !== null) return age;
        }
    }

    return null;
}

/** True for an explicit "no rating" marker (NR, Unrated, N/A, ...), as opposed to a rating we cannot read. */
export function isUnratedCertification(certification: string | null | undefined): boolean {
    if (!certification) return true;
    const trimmed = certification.trim();
    if (!trimmed) return true;
    for (const candidate of [trimmed, stripPrefix(trimmed)]) {
        if (CERTIFICATION_MAP[normalizeKey(candidate)] === -1) return true;
    }
    return false;
}
