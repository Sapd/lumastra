// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import { normalizedSimilarity } from '$lib/server/utils/string-similarity.js';
import type { ProcessedChannel } from './auto-processor.js';
import { countryFromGuideId, countryFromLabel, stripCountryTag } from './channel-country.js';
import type { XmltvChannel, XmltvImportResult, XmltvProgram } from './xmltv-parser.js';

const logger = Logger.for('EpgMatcher');

// ── Types ──────────────────────────────────────────────────────────────

/** Which signal contributed to a match */
export type EpgMatchSignal =
    | 'tvg_id_exact'
    | 'tvg_id_partial'
    | 'tvg_name_match'
    | 'name_exact'
    | 'name_fuzzy'
    | 'group_title'
    | 'backup_propagation';

/** Individual channel match with confidence */
export interface EpgMatch {
    /** Index into the ProcessedChannel[] array */
    channelIndex: number;
    /** M3U channel name (for display) */
    channelName: string;
    /** M3U tvg-id (if any) */
    tvgId: string | undefined;
    /** Matched XMLTV channel ID */
    epgChannelId: string;
    /** XMLTV channel display name (for admin verification) */
    epgDisplayName: string;
    /** Match confidence 0-1 */
    confidence: number;
    /** Which signals contributed to this match */
    signals: EpgMatchSignal[];
}

/** Channel that couldn't be matched */
export interface UnmatchedChannel {
    /** Index into the ProcessedChannel[] array */
    channelIndex: number;
    /** M3U channel name */
    channelName: string;
    /** M3U tvg-id (if any) */
    tvgId: string | undefined;
    /** Best candidate XMLTV channel (if any), with score */
    bestCandidate: { epgChannelId: string; displayName: string; score: number } | undefined;
    /** Why it wasn't matched */
    reason: string;
}

/** Complete matching output */
export interface EpgMatchResult {
    /** Successfully matched channels */
    matches: EpgMatch[];
    /** Channels that could not be matched */
    unmatched: UnmatchedChannel[];
    /** Statistics */
    stats: {
        totalChannels: number;
        matched: number;
        unmatched: number;
        /** Breakdown by signal type */
        bySignal: Record<EpgMatchSignal, number>;
        /** Average confidence of matched channels */
        averageConfidence: number;
    };
    /** Warnings for admin review */
    warnings: Array<{ channel: string; message: string }>;
}

// ── Name Normalization ─────────────────────────────────────────────────

/**
 * Normalize a channel name for comparison.
 * Strips quality suffixes, special characters, and normalizes German umlauts.
 */
function normalizeName(name: string): string {
    let normalized = name.toLowerCase().trim();
    // Strip quality suffixes
    normalized = normalized.replace(
        /\b(?:full\s+hd|fullhd|1080p|2160p|720p|480p|576p|uhd|fhd|4k|hd|sd)\b/g,
        '',
    );
    // Strip special characters: *, ¹, ², ³, etc.
    normalized = normalized.replace(/[*¹²³⁴⁵⁶⁷⁸⁹⁰]/g, '');
    // Strip trailing numbers that are backup indicators (not channel numbers)
    // Keep "ZAVO 1" but strip trailing standalone numbers after cleanup
    // Normalize German umlauts to ASCII
    normalized = normalized
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ä/g, 'ae')
        .replace(/ß/g, 'ss');
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
}

/**
 * Compare two names with German umlaut awareness.
 * Tries both original and umlaut-normalized forms, returns the best score.
 */
function compareNames(a: string, b: string): number {
    const normA = normalizeName(a);
    const normB = normalizeName(b);

    // Try exact match on normalized forms
    if (normA === normB) return 1.0;

    // Use Levenshtein similarity on normalized forms
    const score = normalizedSimilarity(normA, normB);

    // Also try with umlauts expanded in one direction only
    // (e.g., "ö" in a vs "oe" in b — already handled by normalizeName)
    return score;
}

// ── Signal 1: tvg-id Matching ──────────────────────────────────────────

interface TvgIdMatchResult {
    epgChannel: XmltvChannel;
    confidence: number;
    signal: EpgMatchSignal;
}

/**
 * Try to match a channel by tvg-id.
 * Exact match → 1.0 confidence. Partial (case-insensitive, whitespace-stripped) → 0.95.
 */
function matchByTvgId(
    tvgId: string | undefined,
    xmltvIdMap: Map<string, XmltvChannel>,
    xmltvNormalizedIdMap: Map<string, XmltvChannel>,
    xmltvSuffixStrippedIdMap: Map<string, XmltvChannel>,
): TvgIdMatchResult | undefined {
    if (!tvgId) return undefined;

    // Exact match
    const exact = xmltvIdMap.get(tvgId);
    if (exact) {
        return { epgChannel: exact, confidence: 1.0, signal: 'tvg_id_exact' };
    }

    // Partial match: case-insensitive, whitespace-stripped
    const normalized = tvgId.toLowerCase().replace(/\s+/g, '');
    const partial = xmltvNormalizedIdMap.get(normalized);
    if (partial) {
        return {
            epgChannel: partial,
            confidence: 0.95,
            signal: 'tvg_id_partial',
        };
    }

    // Try stripping common suffixes (.de, .at, .ch) from both sides
    const suffixStripped = stripIdSuffix(normalized);
    const stripped =
        suffixStripped.length > 0 ? xmltvSuffixStrippedIdMap.get(suffixStripped) : undefined;
    if (stripped) {
        return {
            epgChannel: stripped,
            confidence: 0.95,
            signal: 'tvg_id_partial',
        };
    }

    return undefined;
}

function stripIdSuffix(normalizedId: string): string {
    return normalizedId.replace(/\.(de|at|ch|us|uk)$/, '');
}

/**
 * Suffix-stripped id → the FIRST channel (in normalized-map order) with that
 * stripped id, i.e. the channel the old per-channel scan returned.
 */
function buildSuffixStrippedIdMap(
    xmltvNormalizedIdMap: Map<string, XmltvChannel>,
): Map<string, XmltvChannel> {
    const map = new Map<string, XmltvChannel>();
    for (const [normId, channel] of xmltvNormalizedIdMap) {
        const key = stripIdSuffix(normId);
        if (!map.has(key)) map.set(key, channel);
    }
    return map;
}

// ── Signal 2: Name-based Fuzzy Matching ────────────────────────────────

interface NameMatchResult {
    epgChannel: XmltvChannel;
    confidence: number;
    signal: EpgMatchSignal;
}

interface NameCandidate {
    channel: XmltvChannel;
    /** Name similarity 0-1 (before country adjustments). */
    score: number;
    usedTvgName: boolean;
}

/**
 * Best candidate among one set of guide names: baseName and tvgName against
 * display names and ids. `strip` turns a channel name into the form the set's
 * keys were built from (the country subsets drop the country tag).
 */
function bestNameCandidate(
    channel: ProcessedChannel,
    subset: NameSubset,
    index: NameIndex,
    strip: (name: string) => string,
    displayNameOf: (ch: XmltvChannel) => string,
): NameCandidate | undefined {
    let bestScore = 0;
    let bestChannel: XmltvChannel | undefined;
    let usedTvgName = false;

    const baseName = strip(channel.baseName);

    // Compare baseName against display names
    const baseNameResult = findBestNameMatch(baseName, subset.displayNames, index);
    if (baseNameResult.score > bestScore) {
        bestScore = baseNameResult.score;
        bestChannel = baseNameResult.channel;
    }

    // Compare baseName against XMLTV IDs (some are human-readable like "Nordwelle.de")
    const baseNameIdResult = findBestNameMatch(baseName, subset.ids, index);
    if (baseNameIdResult.score > bestScore) {
        bestScore = baseNameIdResult.score;
        bestChannel = baseNameIdResult.channel;
    }

    // Compare tvgName if available (often closer to XMLTV displayName)
    const tvgName = channel.original.tvgName ? strip(channel.original.tvgName) : undefined;
    if (tvgName) {
        const tvgNameResult = findBestNameMatch(tvgName, subset.displayNames, index);
        if (tvgNameResult.score > bestScore) {
            bestScore = tvgNameResult.score;
            bestChannel = tvgNameResult.channel;
            usedTvgName = true;
        }

        const tvgNameIdResult = findBestNameMatch(tvgName, subset.ids, index);
        if (tvgNameIdResult.score > bestScore) {
            bestScore = tvgNameIdResult.score;
            bestChannel = tvgNameIdResult.channel;
            usedTvgName = true;
        }
    }

    if (!bestChannel) return undefined;

    // Use the best score from findBestNameMatch (already normalized + compared).
    // Also check displayName comparison to catch cases where the match was found
    // via XMLTV ID but displayName comparison gives a better score.
    const displayNameScore = compareNames(
        usedTvgName ? tvgName! : baseName,
        displayNameOf(bestChannel),
    );
    return { channel: bestChannel, score: Math.max(bestScore, displayNameScore), usedTvgName };
}

/** Confidence for a name similarity, or undefined below MIN_NAME_SCORE. */
function nameMatchFromCandidate(candidate: NameCandidate | undefined): NameMatchResult | undefined {
    if (!candidate) return undefined;
    const { channel: epgChannel, score: normalizedBest, usedTvgName } = candidate;

    if (normalizedBest >= 1.0) {
        // Exact normalized match
        return {
            epgChannel,
            confidence: 0.9,
            signal: usedTvgName ? 'tvg_name_match' : 'name_exact',
        };
    } else if (normalizedBest >= 0.8) {
        // High similarity
        return {
            epgChannel,
            confidence: 0.7 + normalizedBest * 0.2,
            signal: usedTvgName ? 'tvg_name_match' : 'name_fuzzy',
        };
    } else if (normalizedBest >= 0.6) {
        // Medium similarity
        return {
            epgChannel,
            confidence: 0.5 + normalizedBest * 0.2,
            signal: usedTvgName ? 'tvg_name_match' : 'name_fuzzy',
        };
    }

    return undefined;
}

const identity = (name: string): string => name;
const displayNameOf = (ch: XmltvChannel): string => ch.displayName;
const strippedDisplayNameOf = (ch: XmltvChannel): string => stripTag(ch.displayName);

/**
 * Try to match a channel by name similarity.
 * Compares baseName and tvgName against XMLTV displayNames and IDs. With
 * country info (CountryIndex) the guide entry of the channel's own country
 * wins over a same-named entry of another country.
 */
function matchByName(channel: ProcessedChannel, index: NameIndex): NameMatchResult | undefined {
    if (index.channels.length === 0) return undefined;

    const overall = bestNameCandidate(channel, index, index, identity, displayNameOf);
    const countries = index.countries;
    if (!countries) return nameMatchFromCandidate(overall);

    const country = channelCountry(channel);
    // In order of preference on a tie: own country, untagged, any entry.
    const candidates: NameCandidate[] = [];
    const own = country ? countries.byCountry.get(country) : undefined;
    if (own) {
        const c = bestNameCandidate(channel, own, index, stripTag, strippedDisplayNameOf);
        if (c) candidates.push(c);
    }
    if (overall && countries.entryCountry.get(overall.channel) !== undefined) {
        // The overall best is tagged: find the best untagged entry too (an
        // untagged overall best already is the untagged subset's best).
        const c = bestNameCandidate(channel, countries.untagged, index, identity, displayNameOf);
        if (c) candidates.push(c);
    }
    if (overall) candidates.push(overall);

    let best: NameCandidate | undefined;
    let bestAdjusted = -Infinity;
    for (const c of candidates) {
        if (c.score < MIN_NAME_SCORE) continue;
        const entry = effectiveEntryCountry(countries, country, c.channel);
        const adjusted =
            country && entry && country !== entry
                ? c.score - COUNTRY_MISMATCH_SELECTION_PENALTY
                : c.score;
        if (adjusted > bestAdjusted) {
            bestAdjusted = adjusted;
            best = c;
        }
    }

    const result = nameMatchFromCandidate(best);
    if (!result) return undefined;
    const entry = effectiveEntryCountry(countries, country, result.epgChannel);
    // No bonus for the own country: it would lift a fuzzy match over an exact
    // one in conflicts and in choosing a backup group's primary. claimRank
    // settles ties instead.
    if (country && entry && country !== entry) result.confidence -= COUNTRY_MISMATCH_PENALTY;
    return result;
}

// ── Country awareness ──────────────────────────────────────────────────
//
// Big provider guides list one station per country under nearly the same
// name ("TORQ SD", "AT: TORQ HD", "IT: TORQ HD", "torq.it"). By name alone
// whichever channel comes first claims an entry, and a station's own country
// can end up with no guide at all. When the channels carry a country
// (livetv_channels.country_code) and the guide tags its entries (id suffix
// ".at" or a display-name tag "AT:"), the matcher prefers the entry of the
// channel's country, then an untagged entry for an untagged channel, and
// settles claims on one entry the same way. Without countries on both sides
// nothing changes.

/** Confidence taken from a name match whose guide entry has another country. */
const COUNTRY_MISMATCH_PENALTY = 0.1;

/**
 * Similarity taken from a candidate of another country when choosing between
 * candidates. The own country and untagged entries only win ties (the order
 * matchByName tries them in): a fuzzy own-country name must not beat an exact
 * untagged one.
 */
const COUNTRY_MISMATCH_SELECTION_PENALTY = 0.15;

/**
 * Who keeps a guide entry that several channels claim with equal confidence:
 * an explicit tvg-id match, then the channel of the entry's country, then an
 * untagged channel on an untagged entry.
 */
function claimRank(
    channel: string | undefined,
    entry: string | undefined,
    byTvgId: boolean,
): number {
    if (byTvgId) return 4;
    if (entry !== undefined) {
        if (channel === entry) return 3;
        return channel === undefined ? 0 : -1;
    }
    return channel === undefined ? 2 : 1;
}

/**
 * The entry's country as far as it counts against this channel. A country
 * read from the id suffix alone helps the channel of that country but never
 * counts against another one: providers borrow ids ("ORX: CAGE NETWORK"
 * under "cagenetwork.ca", "Brisa" under "brisa.es"). A name tag does.
 */
function effectiveEntryCountry(
    countries: CountryIndex,
    channel: string | undefined,
    entry: XmltvChannel,
): string | undefined {
    const country = countries.entryCountry.get(entry);
    if (country === undefined || country === channel || countries.labelTagged.has(entry)) {
        return country;
    }
    return undefined;
}

/** Region codes that are no country (channel-country.ts): no guide tags them. */
const NON_COUNTRY_REGIONS = new Set(['adult', 'religious']);

const regionCache = new Map<string, string | undefined>();

/**
 * Country the channel is matched as: its stored region, normalised to the
 * guide vocabulary (a raw tvg-id suffix "gb" is "uk", ".tv" is none); for an
 * adult or religious channel the name's tag.
 */
function channelCountry(channel: ProcessedChannel): string | undefined {
    const region = channel.region ?? channel.original.countryCode;
    if (!region) return undefined;
    if (NON_COUNTRY_REGIONS.has(region)) return countryFromLabel(channel.original.name);
    if (!regionCache.has(region)) {
        const code = region.toLowerCase();
        regionCache.set(region, code.length === 2 ? countryFromGuideId(`x.${code}`) : code);
    }
    return regionCache.get(region);
}

function stripTag(name: string): string {
    return stripCountryTag(name) ?? name;
}

/**
 * What all names of one station share: the first word without country tag
 * and quality ("kwf_neo" and "kwfneo" are one word) and the numbers in the
 * name ("Sport 1" and "Sport 2" are two channels, "Sport 1 (Alt 2)" is not).
 */
function stationSignature(displayName: string): string {
    const key = similarityKey(stripTag(displayName));
    const word = (key.split(' ')[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '');
    if (!word) return '';
    // "(Alt 2)" marks another feed of the same channel; "+1" stays apart.
    const numbers = key.replace(/\([^)]*\)/g, '').match(/\d+/g) ?? [];
    return `${word}|${numbers.join(',')}`;
}

/**
 * Ids listed more than once whose names all share one station signature: one
 * station under several names. An id whose names differ ("BKL 12", "BKL 13",
 * "LIVE EVENT 05") is a provider's placeholder, not a station.
 */
function stationIdsWithSeveralNames(xmltvChannels: XmltvChannel[]): Set<string> {
    const signature = new Map<string, string | null>();
    const repeated = new Set<string>();
    for (const ch of xmltvChannels) {
        const sig = stationSignature(ch.displayName);
        const seen = signature.get(ch.id);
        if (seen === undefined) {
            signature.set(ch.id, sig || null);
            continue;
        }
        repeated.add(ch.id);
        if (seen !== sig) signature.set(ch.id, null);
    }
    return new Set([...repeated].filter((id) => signature.get(id)));
}

interface NameSubset {
    displayNames: NameCandidates;
    ids: NameCandidates;
}

interface CountryIndex {
    entryCountry: Map<XmltvChannel, string | undefined>;
    /** Entries whose country comes from a name tag, not just the id suffix. */
    labelTagged: Set<XmltvChannel>;
    /** Entries of one country, display names keyed without their country tag. */
    byCountry: Map<string, NameSubset>;
    untagged: NameSubset;
}

/**
 * Undefined when no guide entry carries a country: matching stays name-only.
 * An entry's country is its display-name tag first: provider guides name
 * entries like their own playlist ("RO: ONDA 3 HD") but often borrow
 * another country's id for them ("onda3.es"), so the id suffix only counts
 * for an untagged name.
 */
function buildCountryIndex(xmltvChannels: XmltvChannel[]): CountryIndex | undefined {
    const entryCountry = new Map<XmltvChannel, string | undefined>();
    const labelTagged = new Set<XmltvChannel>();
    const tagged = new Map<string, number[]>();
    const untagged: number[] = [];
    xmltvChannels.forEach((ch, i) => {
        const label = countryFromLabel(ch.displayName);
        if (label) labelTagged.add(ch);
        const country = label ?? countryFromGuideId(ch.id);
        entryCountry.set(ch, country);
        if (country === undefined) {
            untagged.push(i);
            return;
        }
        const list = tagged.get(country);
        if (list) list.push(i);
        else tagged.set(country, [i]);
    });
    if (tagged.size === 0) return undefined;

    const subset = (indices: number[], display: (ch: XmltvChannel) => string): NameSubset => ({
        displayNames: buildNameCandidates(
            indices.map((i) => display(xmltvChannels[i])),
            indices,
        ),
        // Ids keep their suffix: "TORQ.uk" is no exact match for "UK: TORQ".
        ids: buildNameCandidates(
            indices.map((i) => xmltvChannels[i].id),
            indices,
        ),
    });
    const byCountry = new Map<string, NameSubset>();
    for (const [country, indices] of tagged) {
        byCountry.set(country, subset(indices, strippedDisplayNameOf));
    }
    return {
        entryCountry,
        labelTagged,
        byCountry,
        untagged: subset(untagged, displayNameOf),
    };
}

/** Lowest name similarity that counts as a candidate at all. */
const MIN_NAME_SCORE = 0.6;

/**
 * One list of EPG names, normalized once per match run. Before this every
 * channel re-normalized every EPG name (six regex passes each) and compared
 * against all of them: 12,600 channels against a 6,000-channel guide blocked
 * the worker's event loop for minutes and the liveness probe killed it.
 */
interface NameCandidates {
    /**
     * Distinct keys (normalizeName() then the lower/trim normalizedSimilarity
     * applies), each with the index of its first occurrence, in index order.
     * A later duplicate scores the same and can never strictly beat the first.
     */
    keys: string[];
    keyIndex: number[];
    /** key → first index holding it (the index a full scan would pick for 1.0). */
    firstIndexOfKey: Map<string, number>;
    memo: Map<string, { score: number; channel: XmltvChannel | undefined }>;
}

interface NameIndex {
    channels: XmltvChannel[];
    displayNames: NameCandidates;
    ids: NameCandidates;
    /** Set only when both the channels and the guide carry countries. */
    countries?: CountryIndex;
}

function similarityKey(name: string): string {
    return normalizeName(name).toLowerCase().trim();
}

/** `indices[n]` is the guide index of `names[n]` (a subset); default: n. */
function buildNameCandidates(names: string[], indices?: number[]): NameCandidates {
    const keys: string[] = [];
    const keyIndex: number[] = [];
    const firstIndexOfKey = new Map<string, number>();
    names.forEach((name, n) => {
        const i = indices ? indices[n] : n;
        const key = similarityKey(name);
        if (firstIndexOfKey.has(key)) return;
        firstIndexOfKey.set(key, i);
        keys.push(key);
        keyIndex.push(i);
    });
    return { keys, keyIndex, firstIndexOfKey, memo: new Map() };
}

function buildNameIndex(xmltvChannels: XmltvChannel[], withCountries = false): NameIndex {
    return {
        channels: xmltvChannels,
        displayNames: buildNameCandidates(xmltvChannels.map((ch) => ch.displayName)),
        ids: buildNameCandidates(xmltvChannels.map((ch) => ch.id)),
        countries: withCountries ? buildCountryIndex(xmltvChannels) : undefined,
    };
}

/**
 * Best candidate for `query`: the FIRST candidate with the highest similarity,
 * provided that similarity is at least MIN_NAME_SCORE. Same answer as scoring
 * every candidate with normalizedSimilarity(); it only skips candidates that
 * provably cannot beat the best so far, and caches per query (the HD/FHD/SD
 * variants of a channel share one normalized name).
 */
function findBestNameMatch(
    query: string,
    candidates: NameCandidates,
    index: NameIndex,
): { score: number; channel: XmltvChannel | undefined } {
    const q = similarityKey(query);
    const cached = candidates.memo.get(q);
    if (cached) return cached;

    let result: { score: number; channel: XmltvChannel | undefined } = {
        score: 0,
        channel: undefined,
    };
    const exact = candidates.firstIndexOfKey.get(q);
    if (exact !== undefined) {
        // 1.0 is the maximum, and the map holds the first index reaching it.
        result = { score: 1, channel: index.channels[exact] };
    } else if (q.length > 0) {
        let bestIndex = -1;
        let bestScore = -1;
        const keys = candidates.keys;
        for (let i = 0; i < keys.length; i++) {
            const c = keys[i];
            const maxLen = Math.max(q.length, c.length);
            if (maxLen === 0) continue;
            const floor = Math.max(bestScore, MIN_NAME_SCORE);
            // The edit distance is at least the length difference.
            if (1 - Math.abs(q.length - c.length) / maxLen < floor) continue;
            // One edit of slack keeps the bound safe against float rounding;
            // the exact score check below decides.
            const maxDist = Math.floor(maxLen * (1 - floor)) + 1;
            const dist = boundedLevenshtein(q, c, maxDist);
            if (dist > maxDist) continue;
            const score = 1 - dist / maxLen;
            if (score >= MIN_NAME_SCORE && score > bestScore) {
                bestScore = score;
                bestIndex = candidates.keyIndex[i];
            }
        }
        if (bestIndex >= 0) result = { score: bestScore, channel: index.channels[bestIndex] };
    }
    candidates.memo.set(q, result);
    return result;
}

let levPrev = new Int32Array(64);
let levCurr = new Int32Array(64);

/**
 * Levenshtein distance, exact when it is <= maxDist; otherwise some value
 * greater than maxDist (stops once a whole row exceeds it).
 */
function boundedLevenshtein(a: string, b: string, maxDist: number): number {
    if (a.length < b.length) {
        const t = a;
        a = b;
        b = t;
    }
    const m = a.length;
    const n = b.length;
    if (m - n > maxDist) return maxDist + 1;
    if (n === 0) return m;
    if (levPrev.length < n + 1) {
        levPrev = new Int32Array(n + 1);
        levCurr = new Int32Array(n + 1);
    }
    let prev = levPrev;
    let curr = levCurr;
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = i;
        const ai = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
            const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > maxDist) return maxDist + 1;
        const t = prev;
        prev = curr;
        curr = t;
    }
    return prev[n];
}

// ── Signal 3: Group-Title Cross-Referencing ────────────────────────────

/**
 * Build a map from XMLTV channel ID → set of genre categories from its programs.
 */
function buildCategoryHints(programs: XmltvProgram[]): Map<string, Set<string>> {
    const hints = new Map<string, Set<string>>();
    for (const program of programs) {
        if (program.genres.length === 0) continue;
        const existing = hints.get(program.channelId) ?? new Set<string>();
        for (const genre of program.genres) {
            existing.add(genre.toLowerCase());
        }
        hints.set(program.channelId, existing);
    }
    return hints;
}

/**
 * Check if a channel's category matches the XMLTV channel's program genres.
 * Returns true if there's a category overlap, enabling a confidence boost.
 */
function hasCategoryMatch(
    channelCategory: string,
    epgChannelId: string,
    categoryHints: Map<string, Set<string>>,
): boolean {
    const genres = categoryHints.get(epgChannelId);
    if (!genres || genres.size === 0) return false;

    const normalizedCategory = channelCategory.toLowerCase();
    // Direct match
    if (genres.has(normalizedCategory)) return true;

    // Fuzzy category matching (e.g., "Sports" matches "sport", "Kids" matches "kids")
    for (const genre of genres) {
        if (
            genre.includes(normalizedCategory) ||
            normalizedCategory.includes(genre) ||
            normalizedSimilarity(genre, normalizedCategory) >= 0.8
        ) {
            return true;
        }
    }

    return false;
}

// ── Placeholder guides and shared tvg-ids ──────────────────────────────

/** Words that name a feed of a channel, not the channel ("Low", "(HEVC)", "HDraw"). */
const FEED_WORDS = new Set([
    'low',
    'high',
    'web',
    'hevc',
    'h264',
    'h265',
    'raw',
    'hdraw',
    'sdraw',
    'uhdraw',
    'fhdraw',
    'cable',
    'backup',
    'alt',
    'mobile',
    'mobil',
    'fps',
    '50fps',
    '60fps',
]);

/** Small capitals some playlists use for a feed tag ("HDʀᴀᴡ"). */
const SMALL_CAPS: Readonly<Record<string, string>> = { ʀ: 'r', ᴀ: 'a', ᴡ: 'w' };

/** Longest name stationKey reads; provider names are untrusted and the later grouping is quadratic. */
const MAX_STATION_NAME = 200;

/**
 * A channel name reduced to the station: no country tag, quality, bracketed
 * parts ("(Alt 2)", "[Bouquet]") or feed words. "AT: Kanal Gold HD" and
 * "Kanal Gold Low (HEVC)" are both "kanal gold"; "+1" stays ("kanal gold+1").
 */
function stationKey(name: string): string {
    const key = similarityKey(
        stripTag(name.slice(0, MAX_STATION_NAME).replace(/[ʀᴀᴡ]/gu, (c) => SMALL_CAPS[c] ?? c)),
    )
        // "24/7 • ..." marks a loop channel, not a different station.
        .replace(/^\W*(?:24\s?\/\s?7|7\s?\/\s?24)\W*/u, '')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        // "Kanal Jr Too/Peppa Pig", "FHD/HD/SD": an alias after a slash.
        .replace(/\s*\/.*$/, '');
    return key
        .split(/\s+/)
        .filter((w) => w && !FEED_WORDS.has(w.replace(/[^\p{L}\p{N}]/gu, '')))
        .join(' ');
}

/**
 * Whether two station keys under one tvg-id name different stations. Only
 * clear evidence counts, since providers spell one station many ways
 * ("ServusTV AT" / "Servus TV", "NDR FS NDS" / "NDR Fernsehen"): the same
 * name with other numbers ("<Net> 4" / "<Net> 24", a "+1" timeshift), or a
 * name of two words or more with words added at its end ("<Net> News" /
 * "<Net> News Arabia"). Words in front are a bouquet or provider prefix.
 */
function differentStations(a: string, b: string): boolean {
    const numbers = (k: string): string => (k.match(/\d+/g) ?? []).join(',');
    const words = (k: string): string[] => k.match(/\p{L}+/gu) ?? [];
    const wa = words(a);
    const wb = words(b);
    if (numbers(a) !== numbers(b)) {
        return normalizedSimilarity(wa.join(''), wb.join('')) >= 0.8;
    }
    const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    if (short.length < 2 || long.length === short.length) return false;
    return long.slice(0, short.length).join(' ') === short.join(' ');
}

function sameStation(a: string, b: string): boolean {
    return !differentStations(a, b);
}

/**
 * Stations under one guide id, with no common first word, at which the id
 * stops being a station's guide. Regional variants of one network ("Rai 3
 * TGR Veneto", "... Lazio") share their first word and keep the guide.
 */
const PLACEHOLDER_MIN_STATIONS = 10;
/** Distinct first words those stations need. */
const PLACEHOLDER_MIN_FIRST_WORDS = 5;
/** With one programme title for every listing, this many stations already make a placeholder. */
const PLACEHOLDER_SINGLE_TITLE_MIN_STATIONS = 3;

/**
 * Returns true once YIELD_EVERY_MS has passed since the last true, so a long
 * loop in the generator's setup hands the event loop back like the main loop.
 */
function sliceTimer(): () => boolean {
    let last = performance.now();
    return () => {
        if (performance.now() - last < YIELD_EVERY_MS) return false;
        last = performance.now();
        return true;
    };
}

/**
 * Guide ids that are a provider's placeholder, not a station: the id is
 * given (in the guide or as the playlist's tvg-id) to several stations while
 * every listing under it carries the same title ("no programme information"),
 * or to many unrelated stations. A 24/7 channel with one title is one station
 * and keeps its guide.
 */
function* findPlaceholderGuideIds(
    channels: ProcessedChannel[],
    epgData: XmltvImportResult,
): Generator<MatchProgress, Set<string>, void> {
    const due = sliceTimer();
    const pause = (): MatchProgress => ({ processed: 0, total: channels.length });
    const stations = new Map<string, Set<string>>();
    const add = (id: string, name: string): void => {
        const set = stations.get(id) ?? new Set<string>();
        set.add(stationKey(name));
        stations.set(id, set);
    };
    for (const ch of epgData.channels) {
        add(ch.id, ch.displayName);
        if (due()) yield pause();
    }
    for (const ch of channels) {
        const id = ch.original.tvgId;
        if (!ch.isVod && id && stations.has(id)) add(id, ch.original.name);
        if (due()) yield pause();
    }
    const title = new Map<string, string | null>();
    for (const p of epgData.programs) {
        const seen = title.get(p.channelId);
        if (seen === undefined) title.set(p.channelId, p.title);
        else if (seen !== null && seen !== p.title) title.set(p.channelId, null);
        if (due()) yield pause();
    }
    const out = new Set<string>();
    for (const [id, set] of stations) {
        if (
            set.size >= PLACEHOLDER_SINGLE_TITLE_MIN_STATIONS &&
            typeof title.get(id) === 'string'
        ) {
            out.add(id);
        } else if (set.size >= PLACEHOLDER_MIN_STATIONS) {
            const firstWords = new Set([...set].map((k) => k.split(' ')[0]));
            if (firstWords.size >= PLACEHOLDER_MIN_FIRST_WORDS) out.add(id);
        }
    }
    return out;
}

/** Distinct station keys under one tvg-id above which the id is not grouped. */
const MAX_STATIONS_PER_TVG_ID = 50;
/** Guide names read per id when the groups vote. */
const MAX_GUIDE_NAMES_PER_ID = 200;

/**
 * For each guide id the playlist gives to more than one station: the station
 * keys allowed to keep an exact tvg-id match. The playlist's channels with
 * that tvg-id are grouped by station; the group most of the guide's own
 * names for the id agree with wins, then the larger group. Ids carried by one
 * station only (however many feeds) are not listed: every exact match keeps
 * them, as do guides that name the station differently ("ARD" for "Das
 * Erste").
 */
function* acceptedTvgIdStations(
    channels: ProcessedChannel[],
    guide: XmltvChannel[],
): Generator<MatchProgress, Map<string, Set<string>>, void> {
    const due = sliceTimer();
    const pause = (): MatchProgress => ({ processed: 0, total: channels.length });
    const guideIds = new Set(guide.map((ch) => ch.id));
    const keysById = new Map<string, Map<string, number>>();
    for (const ch of channels) {
        const id = ch.original.tvgId;
        if (ch.isVod || !id || !guideIds.has(id)) continue;
        const keys = keysById.get(id) ?? new Map<string, number>();
        const key = stationKey(ch.original.name);
        keys.set(key, (keys.get(key) ?? 0) + 1);
        keysById.set(id, keys);
        if (due()) yield pause();
    }
    const namesById = new Map<string, string[]>();
    for (const ch of guide) {
        if (!keysById.has(ch.id)) continue;
        const names = namesById.get(ch.id) ?? [];
        if (names.length < MAX_GUIDE_NAMES_PER_ID) names.push(stationKey(ch.displayName));
        namesById.set(ch.id, names);
        if (due()) yield pause();
    }

    const out = new Map<string, Set<string>>();
    for (const [id, keys] of keysById) {
        if (keys.size < 2) continue;
        // An id this many names share is a placeholder: grouping them is
        // quadratic and no group would be right anyway, so every exact match
        // keeps it.
        if (keys.size > MAX_STATIONS_PER_TVG_ID) continue;
        if (due()) yield pause();
        // Group the channel keys into stations.
        const groups: Array<{ rep: string; keys: Set<string>; channels: number }> = [];
        for (const [key, count] of keys) {
            const group = groups.find((g) => sameStation(g.rep, key));
            if (group) {
                group.keys.add(key);
                group.channels += count;
            } else {
                groups.push({ rep: key, keys: new Set([key]), channels: count });
            }
        }
        if (groups.length < 2) continue;
        // The station most of the playlist's feeds with this id belong to
        // keeps it; the guide's own names for the id break a tie; a tie that
        // remains keeps all of them.
        const names = namesById.get(id) ?? [];
        const votes = (g: { rep: string }): number =>
            names.filter((n) => sameStation(g.rep, n)).length;
        const score = (g: { rep: string; channels: number }): [number, number] => [
            g.channels,
            votes(g),
        ];
        const top = groups
            .map(score)
            .reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a));
        const winners = groups.filter((g) => {
            const [c, v] = score(g);
            return c === top[0] && v === top[1];
        });
        if (winners.length > 1) continue;
        const best = winners[0];
        out.set(id, best.keys);
    }
    return out;
}

// ── Match Orchestrator ─────────────────────────────────────────────────

/**
 * Match EPG channels to M3U channels using multi-signal scoring.
 * Pure function — no database access, no side effects.
 *
 * Pipeline stages (in priority order):
 * 1. tvg-id matching (highest priority)
 * 2. Name fuzzy matching (for unmatched channels)
 * 3. Group-title tiebreaker
 * 4. Backup group propagation
 * 5. Conflict resolution
 */
export function matchEpgChannels(
    channels: ProcessedChannel[],
    epgData: XmltvImportResult,
): EpgMatchResult {
    const steps = matchEpgChannelsSteps(channels, epgData);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/**
 * Longest stretch of matching between two event-loop yields in
 * matchEpgChannelsAsync. Time, not a channel count: the cost per channel
 * depends on the guide size and the CPU.
 */
const YIELD_EVERY_MS = 50;

export interface MatchProgress {
    processed: number;
    total: number;
}

/**
 * matchEpgChannels for large sources: same result, but it yields to the event
 * loop every YIELD_EVERY_MS (health checks keep answering, so the
 * liveness probe does not kill the worker) and reports progress.
 */
export async function matchEpgChannelsAsync(
    channels: ProcessedChannel[],
    epgData: XmltvImportResult,
    onProgress?: (progress: MatchProgress) => void | Promise<void>,
): Promise<EpgMatchResult> {
    const steps = matchEpgChannelsSteps(channels, epgData);
    let step = steps.next();
    while (!step.done) {
        await onProgress?.(step.value);
        await new Promise<void>((resolve) => setImmediate(resolve));
        step = steps.next();
    }
    return step.value;
}

function* matchEpgChannelsSteps(
    channels: ProcessedChannel[],
    fullEpgData: XmltvImportResult,
): Generator<MatchProgress, EpgMatchResult, void> {
    // A provider's placeholder ids ("no guide available" under one id for
    // hundreds of event feeds) are no guide: matching skips them, so their
    // programmes are not stored and a real entry can still be found by name.
    const placeholderIds = yield* findPlaceholderGuideIds(channels, fullEpgData);
    const epgData: XmltvImportResult =
        placeholderIds.size === 0
            ? fullEpgData
            : {
                  ...fullEpgData,
                  channels: fullEpgData.channels.filter((ch) => !placeholderIds.has(ch.id)),
              };
    const tvgIdStations = yield* acceptedTvgIdStations(channels, epgData.channels);
    const matches: EpgMatch[] = [];
    const unmatched: UnmatchedChannel[] = [];
    const warnings: Array<{ channel: string; message: string }> = [];

    // Build lookup maps for XMLTV channels
    const xmltvIdMap = new Map<string, XmltvChannel>();
    const xmltvNormalizedIdMap = new Map<string, XmltvChannel>();
    for (const ch of epgData.channels) {
        xmltvIdMap.set(ch.id, ch);
        const normalizedId = ch.id.toLowerCase().replace(/\s+/g, '');
        if (xmltvNormalizedIdMap.has(normalizedId)) {
            warnings.push({
                channel: ch.id,
                message: `Duplicate normalized XMLTV channel ID "${normalizedId}" (display="${ch.displayName}") — previous entry overwritten`,
            });
        }
        xmltvNormalizedIdMap.set(normalizedId, ch);
    }
    const xmltvSuffixStrippedIdMap = buildSuffixStrippedIdMap(xmltvNormalizedIdMap);
    // Country-aware only when the channels carry countries; the guide side is
    // checked by buildCountryIndex.
    const nameIndex = buildNameIndex(
        epgData.channels,
        channels.some((ch) => !ch.isVod && channelCountry(ch) !== undefined),
    );
    const countries = nameIndex.countries;

    // Build category hints from programs
    const categoryHints = buildCategoryHints(epgData.programs);

    // Track which M3U channels have been matched (index → match)
    const matchedByIndex = new Map<number, EpgMatch>();

    // Track which XMLTV channels have been claimed (epgChannelId → best match index)
    // rank: claimRank() with country info, else 0 (confidence alone decides).
    // exact: claimed by an exact tvg-id match, which never loses the entry.
    const claimedEpg = new Map<
        string | XmltvChannel,
        { channelIndex: number; confidence: number; rank: number; exact: boolean }
    >();
    // Large provider guides list one station's id under several names, one
    // per country or quality ("TORQHD" as "AT: TORQ HD+" and as "TORQ FHD");
    // the id's schedule is shared anyway. With country info each of those
    // entries is claimed on its own, so the AT feed taking "AT: TORQ HD+" does
    // not lock the German feed out of "TORQ FHD". Placeholder ids reused for
    // unrelated channels ("keinepg" for hundreds of event feeds) and unique
    // ids are claimed by id as before.
    const repeatedIds = countries
        ? stationIdsWithSeveralNames(epgData.channels)
        : new Set<string>();
    const claimKey = (ch: XmltvChannel): string | XmltvChannel =>
        repeatedIds.has(ch.id) ? ch : ch.id;

    // ── Stage 1+2: Match non-VOD, non-backup channels first ──────────
    const nonVodIndices: number[] = [];
    for (let i = 0; i < channels.length; i++) {
        if (!channels[i].isVod) {
            nonVodIndices.push(i);
        }
    }

    // First pass: primary channels and standalone channels
    const total = nonVodIndices.length;
    let processed = 0;
    let lastYield = performance.now();
    for (const idx of nonVodIndices) {
        if (performance.now() - lastYield >= YIELD_EVERY_MS) {
            yield { processed, total };
            lastYield = performance.now();
        }
        processed++;
        const channel = channels[idx];

        // Signal 1: tvg-id matching
        let matchResult = matchByTvgId(
            channel.original.tvgId,
            xmltvIdMap,
            xmltvNormalizedIdMap,
            xmltvSuffixStrippedIdMap,
        );
        // An exact tvg-id the playlist also gives to another station (PULS 4
        // and PULS 24, a "+1" timeshift) belongs to the station the guide
        // names; the others fall back to name matching.
        if (matchResult?.signal === 'tvg_id_exact') {
            const accepted = tvgIdStations.get(matchResult.epgChannel.id);
            if (accepted && !accepted.has(stationKey(channel.original.name))) {
                matchResult = undefined;
            }
        }

        // Signal 2: Name fuzzy matching (if tvg-id didn't match)
        let nameResult: NameMatchResult | undefined;
        if (!matchResult) {
            nameResult = matchByName(channel, nameIndex);
            if (nameResult) {
                matchResult = nameResult;
            }
        }

        if (!matchResult) continue;

        // Signal 3: Group-title boost
        let confidence = matchResult.confidence;
        const signals: EpgMatchSignal[] = [matchResult.signal];

        if (hasCategoryMatch(channel.category, matchResult.epgChannel.id, categoryHints)) {
            confidence = Math.min(confidence + 0.05, 1.0);
            signals.push('group_title');
        }

        const match: EpgMatch = {
            channelIndex: idx,
            channelName: channel.original.name,
            tvgId: channel.original.tvgId,
            epgChannelId: matchResult.epgChannel.id,
            epgDisplayName: matchResult.epgChannel.displayName,
            confidence,
            signals,
        };

        matchedByIndex.set(idx, match);

        const rank = countries
            ? claimRank(
                  channelCountry(channel),
                  effectiveEntryCountry(countries, channelCountry(channel), matchResult.epgChannel),
                  !nameResult,
              )
            : 0;

        // Track conflict resolution. A channel whose tvg-id IS the guide id
        // always keeps that guide: several feeds of one station (separate
        // backup groups, e.g. a country's own variant) may carry the same
        // tvg-id, and programmes are stored per channel. Only name, fuzzy and
        // partial-id matches compete for an entry.
        const exact = matchResult.signal === 'tvg_id_exact';
        const existing = claimedEpg.get(claimKey(matchResult.epgChannel));
        if (existing && exact && existing.exact) {
            // Both carry the guide id: both keep it.
        } else if (existing) {
            // Conflict: multiple M3U channels → same XMLTV channel
            // An exact tvg-id match beats any other claim; otherwise keep the
            // one with higher confidence; on a tie the better country fit
            // (claimRank), else the earlier channel
            if (
                !existing.exact &&
                (exact ||
                    confidence > existing.confidence ||
                    (confidence === existing.confidence && rank > existing.rank))
            ) {
                // Demote the previous match to unmatched
                const prevMatch = matchedByIndex.get(existing.channelIndex);
                if (prevMatch) {
                    matchedByIndex.delete(existing.channelIndex);
                    unmatched.push({
                        channelIndex: existing.channelIndex,
                        channelName: prevMatch.channelName,
                        tvgId: prevMatch.tvgId,
                        bestCandidate: {
                            epgChannelId: prevMatch.epgChannelId,
                            displayName: prevMatch.epgDisplayName,
                            score: prevMatch.confidence,
                        },
                        reason: `Conflict: another channel matched same EPG channel with higher confidence (${confidence.toFixed(2)} > ${existing.confidence.toFixed(2)})`,
                    });
                }
                claimedEpg.set(claimKey(matchResult.epgChannel), {
                    channelIndex: idx,
                    confidence,
                    rank,
                    exact,
                });
            } else {
                // This match loses the conflict
                matchedByIndex.delete(idx);
                unmatched.push({
                    channelIndex: idx,
                    channelName: channel.original.name,
                    tvgId: channel.original.tvgId,
                    bestCandidate: {
                        epgChannelId: matchResult.epgChannel.id,
                        displayName: matchResult.epgChannel.displayName,
                        score: confidence,
                    },
                    reason: `Conflict: another channel matched same EPG channel with higher or equal confidence`,
                });
            }
        } else {
            claimedEpg.set(claimKey(matchResult.epgChannel), {
                channelIndex: idx,
                confidence,
                rank,
                exact,
            });
        }
    }

    // ── Stage 4: Backup group propagation ────────────────────────────
    // Group channels by backupGroupKey
    const backupGroups = new Map<string, number[]>();
    for (const idx of nonVodIndices) {
        const channel = channels[idx];
        if (channel.backupGroupKey) {
            const group = backupGroups.get(channel.backupGroupKey) ?? [];
            group.push(idx);
            backupGroups.set(channel.backupGroupKey, group);
        }
    }

    for (const [, groupIndices] of backupGroups) {
        // Find primary match in this group
        let primaryMatch: EpgMatch | undefined;
        for (const idx of groupIndices) {
            const match = matchedByIndex.get(idx);
            if (match) {
                if (!primaryMatch || match.confidence > primaryMatch.confidence) {
                    primaryMatch = match;
                }
            }
        }

        if (!primaryMatch) continue;

        // Propagate to unmatched group members
        for (const idx of groupIndices) {
            if (matchedByIndex.has(idx)) continue;

            const channel = channels[idx];
            const isTvgIdMatch =
                primaryMatch.signals.includes('tvg_id_exact') ||
                primaryMatch.signals.includes('tvg_id_partial');

            const propagatedConfidence = isTvgIdMatch
                ? primaryMatch.confidence
                : primaryMatch.confidence * 0.95;

            const propagatedMatch: EpgMatch = {
                channelIndex: idx,
                channelName: channel.original.name,
                tvgId: channel.original.tvgId,
                epgChannelId: primaryMatch.epgChannelId,
                epgDisplayName: primaryMatch.epgDisplayName,
                confidence: propagatedConfidence,
                signals: [...primaryMatch.signals, 'backup_propagation'],
            };

            matchedByIndex.set(idx, propagatedMatch);
        }
    }

    // ── Stage 4b: Remove conflict-demoted channels that were re-matched via propagation
    // When backup propagation re-matches a channel that lost conflict resolution,
    // it must be removed from the unmatched array to prevent duplicates.
    for (let i = unmatched.length - 1; i >= 0; i--) {
        if (matchedByIndex.has(unmatched[i].channelIndex)) {
            unmatched.splice(i, 1);
        }
    }

    // ── Stage 5: Build final results ─────────────────────────────────
    // A Set, not unmatched.some() per channel: quadratic over ~12k unmatched
    // channels. Stage 5 only adds indices it visits once, so the set built
    // here answers the same question.
    const alreadyUnmatched = new Set(unmatched.map((u) => u.channelIndex));
    for (const idx of nonVodIndices) {
        if (performance.now() - lastYield >= YIELD_EVERY_MS) {
            yield { processed: total, total };
            lastYield = performance.now();
        }
        const match = matchedByIndex.get(idx);
        if (match) {
            // Apply acceptance thresholds
            if (match.confidence >= 0.5) {
                matches.push(match);
                if (match.confidence < 0.8) {
                    warnings.push({
                        channel: match.channelName,
                        message: `Low confidence match (${match.confidence.toFixed(2)}) — admin review recommended`,
                    });
                }
            } else {
                // Below threshold — mark as unmatched with candidate
                unmatched.push({
                    channelIndex: idx,
                    channelName: match.channelName,
                    tvgId: match.tvgId,
                    bestCandidate: {
                        epgChannelId: match.epgChannelId,
                        displayName: match.epgDisplayName,
                        score: match.confidence,
                    },
                    reason: `Below confidence threshold (${match.confidence.toFixed(2)} < 0.5)`,
                });
            }
        } else if (!alreadyUnmatched.has(idx)) {
            // No match found at all — find best candidate for reference
            // (memoized: the first pass already scored this name)
            const channel = channels[idx];
            const nameResult = matchByName(channel, nameIndex);
            unmatched.push({
                channelIndex: idx,
                channelName: channel.original.name,
                tvgId: channel.original.tvgId,
                bestCandidate: nameResult
                    ? {
                          epgChannelId: nameResult.epgChannel.id,
                          displayName: nameResult.epgChannel.displayName,
                          score: nameResult.confidence,
                      }
                    : undefined,
                reason: 'No matching signal found',
            });
        }
    }

    // ── Build statistics ─────────────────────────────────────────────
    const bySignal: Record<EpgMatchSignal, number> = {
        tvg_id_exact: 0,
        tvg_id_partial: 0,
        tvg_name_match: 0,
        name_exact: 0,
        name_fuzzy: 0,
        group_title: 0,
        backup_propagation: 0,
    };

    for (const match of matches) {
        for (const signal of match.signals) {
            bySignal[signal]++;
        }
    }

    const averageConfidence =
        matches.length > 0 ? matches.reduce((sum, m) => sum + m.confidence, 0) / matches.length : 0;

    const stats = {
        totalChannels: nonVodIndices.length,
        matched: matches.length,
        unmatched: unmatched.length,
        bySignal,
        averageConfidence,
    };

    // Log aggregate stats only (never individual channel data — security)
    logger.info('EPG matching complete', {
        matched: stats.matched,
        unmatched: stats.unmatched,
        avgConfidence: Number(stats.averageConfidence.toFixed(2)),
    });

    return { matches, unmatched, stats, warnings };
}

/** Internals exposed for the differential test against the original scorer. */
export const __testing = { normalizeName, buildNameIndex, findBestNameMatch };
