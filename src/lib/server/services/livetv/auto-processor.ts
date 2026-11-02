// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { countryFromTvgSuffix, detectChannelRegion, stripCountryTag } from './channel-country.js';
import {
    GENRE,
    bouquetLabel,
    categorizeChannel,
    genreFromName,
    genreFromSection,
    isBouquetCategory,
} from './channel-genre.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { M3uChannel } from './m3u-parser.js';
import { detectBackupGroups } from './backup-group-detector.js';

const logger = Logger.for('AutoProcessor');

// ── Types ──────────────────────────────────────────────────────────────

/** Quality tier matching the CHECK constraint on livetv_channels.quality_tier */
export type QualityTier = 'uhd' | 'fhd' | 'hd' | 'sd';

/** Regional variant information for a channel */
export interface RegionalVariantInfo {
    /** Country code from tvg-id suffix (e.g., 'de', 'at', 'ch') */
    countryCode: string;
    /** Base channel name without regional indicators */
    baseName: string;
    /** Whether this is a regional-only channel (e.g., OSK, HLV) vs regional variant of a shared show */
    isRegionalOnly: boolean;
}

/** Enriched channel with quality, backup group, category */
export interface ProcessedChannel {
    /** Original M3uChannel data */
    original: M3uChannel;
    /**
     * Country or region for lineup filtering (stored as `country_code`): the
     * tvg-id country, else the name's or section's tag (`channel-country.ts`).
     * Backup and regional-variant detection keep using `original.countryCode`
     * only: a label region would split "3kult HD" in an untagged German section
     * from "3kult HDraw" under "DE • Local RAW".
     */
    region: string | undefined;
    /** Detected quality tier (undefined if no quality indicator in name) */
    qualityTier: QualityTier | undefined;
    /** Normalized base name (quality/backup suffixes stripped) */
    baseName: string;
    /** Normalized category name */
    category: string;
    /** Backup group key (channels sharing same key are in same group) */
    backupGroupKey: string | undefined;
    /** Whether this is the primary channel in its backup group */
    isPrimary: boolean;
    /** Whether this channel is a VOD entry (should be filtered) */
    isVod: boolean;
    /** Regional variant info */
    regionalVariant: RegionalVariantInfo | undefined;
}

/** Detected backup group */
export interface BackupGroup {
    /** Stable key for this group (derived from base name + tvg-id) */
    key: string;
    /** Display name for the group (highest quality channel name, cleaned) */
    name: string;
    /** All channels in this group, ordered by quality (best first) */
    channelIndices: number[];
    /** Index of primary channel (highest quality, first occurrence) */
    primaryIndex: number;
    /** How the group was detected */
    detectionSignals: string[];
}

/** Normalized category mapping */
export interface CategoryMapping {
    /** Raw group-title from M3U */
    rawGroupTitle: string;
    /** Normalized category name */
    normalizedName: string;
}

/** Complete pipeline output */
export interface ProcessingResult {
    /** All channels with enriched metadata */
    channels: ProcessedChannel[];
    /** Detected backup groups */
    backupGroups: BackupGroup[];
    /** Normalized category mappings (raw group-title -> clean category) */
    categories: CategoryMapping[];
    /** Entries filtered out: VOD plus section headers (see separatorCount) */
    vodCount: number;
    /** Section-header entries ("✦●✦ DE • Sport ✦●✦"), filtered out with the VOD */
    separatorCount: number;
    /** Statistics */
    stats: {
        totalInput: number;
        totalAfterVodFilter: number;
        backupGroupCount: number;
        uniqueChannelCount: number;
        categoryCount: number;
        regionalVariantCount: number;
    };
    /** Warnings for admin review */
    warnings: Array<{ channel: string; field: string; message: string }>;
}

// ── Quality Tier Detection ─────────────────────────────────────────────

/** "HDraw", "FHD raw": a quality token with the raw (transport-stream) suffix. */
const RAW_QUALITY_RE = /\b((?:U|F)?HD|SD)\s?raw\b/i;
// Like the quality strip, a backup digit right after it goes too ("HDraw 2").
const RAW_VARIANT_STRIP_RE = /\s*\b(?:(?:U|F)?HD|SD)\s?raw\b(?:\s+\d+)?/gi;
/**
 * "Super MTK HD+", "MTK FHD+": the same station over the HD+ satellite
 * platform or as an HEVC feed. Only at the end of a name (a backup digit may
 * follow); as a group title ("FreeTV / HD+") it stays the platform's name.
 */
const PLUS_VARIANT_RE = /\b((?:U|F)?HD)\+(?=\s*[¹²³\d]*\s*$)/i;
/** A delivery-path word at the very end of a name ("KWF HDraw Cable"). */
const TRAILING_FEED_WORD_RE = /(?:\s+\b(?:Cable|Kabel|SAT|RAW)\b)+\s*$/i;
/**
 * The feed word only counts right after the quality tag ("KWF HD Cable",
 * "TORQ HDraw Cable", "Telesport 1 HD SAT"); before it, it is part of the name
 * ("KWL RAW HD", "Elk Sat HD").
 */
const QUALITY_THEN_FEED_WORD_RE =
    /\b(?:(?:U|F)?HD|SD|4K|1080p|720p|2160p)(?:\s?raw)?[+²³\d]*(?:\s+(?:Cable|Kabel|SAT|RAW)\b)+\s*$/i;

const QUALITY_PATTERNS: Array<{ pattern: RegExp; tier: QualityTier }> = [
    // UHD must be checked before HD
    {
        pattern: /(?:^|\s|[^A-Za-z])(?:UHD|4K|2160p)(?:\s|$|[^A-Za-z])/i,
        tier: 'uhd',
    },
    // FHD must be checked before HD (FHD contains HD)
    {
        pattern: /(?:^|\s|[^A-Za-z])(?:FHD|1080p|FULLHD|FULL\s+HD)(?:\s|$|[^A-Za-z])/i,
        tier: 'fhd',
    },
    // HD but not part of FHD/UHD, and not HD+ (German satellite platform name)
    {
        pattern: /(?:^|\s)HD(?!\+)(?:\s|$|[^A-Za-z])|(?:^|\s|[^A-Za-z])720p(?:\s|$|[^A-Za-z])/i,
        tier: 'hd',
    },
    // SD
    {
        pattern: /(?:^|\s|[^A-Za-z])(?:SD|480p|576p)(?:\s|$|[^A-Za-z])/i,
        tier: 'sd',
    },
];

/**
 * Channel names and group titles come from a provider and several patterns below
 * start with `\s*`, so a long whitespace run made them quadratic. No real name is
 * near this long; everything past it is dropped before any pattern runs.
 */
const MAX_PATTERN_INPUT = 512;

function bounded(text: string): string {
    return text.length > MAX_PATTERN_INPUT ? text.slice(0, MAX_PATTERN_INPUT) : text;
}

/** Small capitals and modifier letters providers style names with ("HDʀᴀᴡ", "ᴴᴰ", "[ʟᴏᴄᴀʟ ᴛʀᴀɴsᴄᴏᴅᴇᴅ]"). */
const STYLED_LETTERS: Readonly<Record<string, string>> = {
    ᴀ: 'a',
    ʙ: 'b',
    ᴄ: 'c',
    ᴅ: 'd',
    ᴇ: 'e',
    ꜰ: 'f',
    ɢ: 'g',
    ʜ: 'h',
    ɪ: 'i',
    ᴊ: 'j',
    ᴋ: 'k',
    ʟ: 'l',
    ᴍ: 'm',
    ɴ: 'n',
    ᴏ: 'o',
    ᴘ: 'p',
    ꞯ: 'q',
    ʀ: 'r',
    ꜱ: 's',
    ᴛ: 't',
    ᴜ: 'u',
    ᴠ: 'v',
    ᴡ: 'w',
    ʏ: 'y',
    ᴢ: 'z',
    ᴴ: 'H',
    ᴰ: 'D',
    ᵁ: 'U',
    ᶠ: 'F',
    ˢ: 'S',
};
const STYLED_LETTER_RE = new RegExp(`[${Object.keys(STYLED_LETTERS).join('')}]`, 'gu');

/** A name as the quality and grouping rules read it: bounded, styled letters folded. */
function plainName(text: string): string {
    return (
        bounded(text)
            // "MTKᴴᴰ": a superscript tag glued to the name is still a separate word.
            .replace(/(?<=[\p{L}\p{N}])(?=[ᴴᵁᶠˢ][ᴰᴴ])/gu, ' ')
            .replace(STYLED_LETTER_RE, (c) => STYLED_LETTERS[c] ?? c)
    );
}

/**
 * A bracketed feed tag: "(Transcoded)", "[Local Transcoded]", "(Mobil)",
 * "(Backup)", "(HEVC)". It names how the station is delivered, not the station.
 * Only a tag followed by nothing but quality words and numbers counts (see
 * FEED_TAIL_RE); the tail is checked outside the pattern because a repeated
 * group inside a lookahead backtracks exponentially on a long digit run.
 */
const FEED_TAG_RE =
    /[([]\s*(?:local\s+)?(?:transcoded|mobil(?:e)?|backup|low\s*quali\w*|hevc|h\.?265)\s*[)\]]/gi;

/** Worse-than-normal feed tags, without the codec ones. Same tail rule as FEED_TAG_RE. */
const DEGRADED_TAG_RE =
    /[([]\s*(?:local\s+)?(?:transcoded|mobil(?:e)?|backup|low\s*quali\w*)\s*[)\]]/gi;

/**
 * What may follow a feed tag: quality words and single digits. Digits are
 * matched one at a time so every input splits one way, which keeps the match
 * linear.
 */
const FEED_TAIL_RE = /^(?:\s*(?:\d|(?:U|F)?HD\+?|SD|4K))*\s*$/i;

/** The first tag of `tagRe` that only quality words follow, with the whitespace before it. */
function findFeedTag(name: string, tagRe: RegExp): { start: number; end: number } | undefined {
    for (const match of name.matchAll(tagRe)) {
        const end = match.index + match[0].length;
        if (!FEED_TAIL_RE.test(name.slice(end))) continue;
        let start = match.index;
        while (start > 0 && /\s/.test(name.charAt(start - 1))) start--;
        return { start, end };
    }
    return undefined;
}

/**
 * Delivery words anywhere in a name: an alternate feed ("(Alt 2)"), a web or
 * low-bitrate copy ("(Web)", "(Low)", "FHD Low (HEVC)"), a codec ("HEVC",
 * "H.265") or a frame rate ("50FPS"). They name how the station is sent, never
 * the station, so "TNT 1 FHD HEVC (Alt 1)" and "TNT 1 50FPS FHD" are TNT 1.
 */
const DELIVERY_WORD_SOURCE = String.raw`\s*(?:[([]\s*(?:alt(?:ernative)?\.?\s*\d*|web|low)\s*[)\]]|\b(?:hevc|h\.?26[45]|\d{2,3}\s?fps)\b|\blow\b(?=\s*(?:[([]|$)))`;
const DELIVERY_WORD_RE = new RegExp(DELIVERY_WORD_SOURCE, 'i');
const DELIVERY_WORD_GLOBAL = new RegExp(DELIVERY_WORD_SOURCE, 'gi');

/** Degraded-feed markers that are not a trailing tag; each is linear on its own. */
const DEGRADED_REST_RE =
    /\blow\s*quali\w*\s*$|[([]\s*low\s*[)\]]|\blow\b(?=\s*(?:[([]\s*(?:hevc|h\.?265)\s*[)\]]\s*)?$)/i;

/** Feeds worse than the station's normal ones: never the primary while another exists. */
export function isDegradedFeed(rawChannelName: string): boolean {
    const name = plainName(rawChannelName);
    return findFeedTag(name, DEGRADED_TAG_RE) !== undefined || DEGRADED_REST_RE.test(name);
}

/** Priority ordering for quality tiers (higher = better) */
export const QUALITY_PRIORITY: Record<QualityTier, number> = {
    uhd: 4,
    fhd: 3,
    hd: 2,
    sd: 1,
};

/**
 * Detect quality tier from channel name.
 * Returns the highest quality tier found, or undefined if none detected.
 * 100% accuracy — deterministic regex, not heuristic.
 */
export function detectQualityTier(rawChannelName: string): QualityTier | undefined {
    // "HDraw" is an HD feed: rank it like HD (hasFeedMarker then sorts it after
    // the clean HD feed within its backup group).
    const channelName = plainName(rawChannelName)
        .replace(RAW_QUALITY_RE, '$1')
        .replace(PLUS_VARIANT_RE, '$1');
    let bestTier: QualityTier | undefined;
    let bestPriority = 0;

    for (const { pattern, tier } of QUALITY_PATTERNS) {
        if (pattern.test(channelName) && QUALITY_PRIORITY[tier] > bestPriority) {
            bestTier = tier;
            bestPriority = QUALITY_PRIORITY[tier];
        }
    }

    return bestTier;
}

// ── Base Name Extraction ───────────────────────────────────────────────

/** Superscript number characters used as backup markers */
const SUPERSCRIPT_PATTERN = /[\u00B9\u00B2\u00B3\u2074-\u2079\u2070]+/g;

/** Backup markers to strip */
const BACKUP_MARKERS = /\s*(?:\*{1,2}|\bWEB\b|\bbackup\b)/gi;

/**
 * True if a channel name carries a backup/alternate-feed marker — an asterisk
 * (`*`/`**`), a superscript number (¹²³…), or `WEB`/`backup`. These mark
 * redundant mirror feeds of the same channel; the unmarked feed is the "clean"
 * primary. Used to rank the clean feed above its backups when choosing a backup
 * group's primary. (The regexes are `g`-flagged and stateful, so reset before use.)
 */
export function hasFeedMarker(rawChannelName: string): boolean {
    const channelName = plainName(rawChannelName);
    BACKUP_MARKERS.lastIndex = 0;
    SUPERSCRIPT_PATTERN.lastIndex = 0;
    return (
        BACKUP_MARKERS.test(channelName) ||
        SUPERSCRIPT_PATTERN.test(channelName) ||
        RAW_QUALITY_RE.test(channelName) ||
        PLUS_VARIANT_RE.test(channelName) ||
        findFeedTag(channelName, FEED_TAG_RE) !== undefined ||
        DELIVERY_WORD_RE.test(channelName) ||
        QUALITY_THEN_FEED_WORD_RE.test(channelName)
    );
}

/**
 * Extract normalized base name from channel name.
 * Strips quality suffixes, backup markers, and superscript numbers.
 * Preserves channel numbers (e.g., "ZAVO 1" stays as "ZAVO 1").
 *
 * Strategy: strip quality+backup suffixes that appear AFTER the core channel name.
 * A trailing number is a backup indicator ONLY if it comes directly after a quality suffix
 * (e.g., "Nordwelle HD 2"), NOT if it's part of the channel name (e.g., "ZAVO 1 FHD").
 */
export function extractBaseName(rawChannelName: string): string {
    const channelName = plainName(rawChannelName);
    const feedTag = findFeedTag(channelName, FEED_TAG_RE);
    const withoutTag = feedTag
        ? channelName.slice(0, feedTag.start) + channelName.slice(feedTag.end)
        : channelName;
    let name = withoutTag.replace(DELIVERY_WORD_GLOBAL, ' ');

    // First strip backup markers (*, **, WEB, backup) — these can appear after quality
    name = name.replace(BACKUP_MARKERS, '');

    // Strip superscript numbers (¹, ², ³, etc.)
    name = name.replace(SUPERSCRIPT_PATTERN, '');

    // "raw" quality variants (unprocessed transport-stream feeds): "Nordwelle
    // HDraw" is the same station as "Nordwelle HD", so it must share its
    // backup group (and its guide) instead of becoming its own tile.
    name = name.replace(RAW_VARIANT_STRIP_RE, '');

    // A trailing "HD+"/"FHD+" is a feed of the same station (see PLUS_VARIANT_RE).
    name = name.replace(PLUS_VARIANT_RE, '$1');

    // Strip quality suffixes + any trailing backup number that directly follows quality
    // Pattern: (quality)(optional space + single digit)
    // "Nordwelle HD 2" -> strip "HD 2"
    // "ZAVO 1 FHD" -> strip "FHD" but keep "1" because it precedes quality
    // "HD+" mid-name stays ("HD+ Info"); a trailing one was reduced to HD above.
    name = name.replace(
        /\s*\b(?:FULL\s+HD|FULLHD|1080p|2160p|720p|480p|576p|UHD|FHD|4K|HD(?!\+)|SD)\b(?:\s+\d+)?/gi,
        '',
    );

    // Normalize whitespace
    name = name.replace(/\s+/g, ' ').trim();

    // A trailing feed word names the delivery path, not the station ("KWF
    // HDraw Cable"). Only at the end, so "Kabel Acht" or "SAT.4" stay intact,
    // and only when letters remain ("3 SAT" keeps its name).
    if (QUALITY_THEN_FEED_WORD_RE.test(channelName)) {
        const withoutFeedWord = name.replace(TRAILING_FEED_WORD_RE, '').trim();
        if (/\p{L}/u.test(withoutFeedWord)) name = withoutFeedWord;
    }

    // If stripping reduced to empty, return original (trimmed) to avoid empty group keys
    return name || channelName.replace(/\s+/g, ' ').trim();
}

// ── VOD Detection ──────────────────────────────────────────────────────

/** File extensions that indicate VOD content */
const VOD_EXTENSIONS = /\.(?:mkv|mp4|avi|flv|wmv|mov)(?:\?|$)/i;

/** Group-title patterns that indicate VOD content (excludes "Film" — too broad, catches live movie channels) */
const VOD_GROUP_PATTERNS = /\b(?:VOD|Movies|Series)\b/i;

/**
 * Detect whether a channel entry is actually VOD content.
 * Uses file extension detection and group-title hints.
 * Zero false negatives target: better to miss a VOD than filter a live channel.
 */
export function isVodEntry(channel: M3uChannel): boolean {
    // File extension check on URL path (strip query params)
    try {
        const urlPath = new URL(channel.streamUrl).pathname;
        if (VOD_EXTENSIONS.test(urlPath)) return true;
    } catch {
        // If URL is malformed, check raw string
        const urlWithoutQuery = channel.streamUrl.split('?')[0];
        if (VOD_EXTENSIONS.test(urlWithoutQuery)) return true;
    }

    // Group-title hint check
    if (channel.groupTitle && VOD_GROUP_PATTERNS.test(channel.groupTitle)) return true;

    return false;
}

// ── Section headers ────────────────────────────────────────────────────

/**
 * Decoration character: not a letter, digit or space, and not punctuation real
 * channel names start with ("[DE] ...", "(CH) ...", "+18 ...", ".Black HD").
 */
// Flag emoji (regional-indicator pairs) are content, not ornament.
const DECOR = String.raw`[^\p{L}\p{N}\p{M}\s\[\](){}+.,:'"&/\u{1F1E6}-\u{1F1FF}]`;
const DECOR_CHAR_RE = new RegExp(`^${DECOR}$`, 'u');
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/u;

const isDecor = (ch: string): boolean => DECOR_CHAR_RE.test(ch);
const isSpace = (ch: string): boolean => /\s/u.test(ch);

/**
 * The leading and trailing decoration runs of a section header, or undefined
 * if the name is not shaped like one: optional space, two or more decoration
 * characters, a single line of text with a letter in it, one or more
 * decoration characters, optional space. By hand, not a regex: the pattern
 * with its three open-ended gaps backtracks on long mixed names.
 */
function separatorEnds(name: string): { leading: string[]; trailing: string[] } | undefined {
    const chars = [...name];
    let i = 0;
    while (i < chars.length && isSpace(chars[i])) i++;
    const leadStart = i;
    while (i < chars.length && isDecor(chars[i])) i++;
    if (i - leadStart < 2) return undefined;
    let end = chars.length;
    while (end > i && isSpace(chars[end - 1])) end--;
    let trailStart = end;
    while (trailStart > i && isDecor(chars[trailStart - 1])) trailStart--;
    if (trailStart === end) return undefined;
    const middle = chars.slice(i, trailStart).join('');
    if (LINE_TERMINATOR_RE.test(middle) || !/\p{L}/u.test(middle)) return undefined;
    return { leading: chars.slice(leadStart, i), trailing: chars.slice(trailStart, end) };
}

/**
 * IPTV playlists put fake "channels" between sections to label them:
 * "✦●✦ DE • Local RAW ✦●✦", "▼•●• TopLiga Replay •●• ▼", "### ADULT ###",
 * "---AZERBAIJAN ---". A name that starts with a run of two or more decoration
 * characters and ends with decoration, with text between, is one of those.
 * A single-symbol prefix ("♥ Name", "☆ Welcome Channel ☆") stays a channel.
 */
export function isSeparatorEntry(name: string): boolean {
    const ends = separatorEnds(bounded(name));
    if (!ends) return false;
    // The two ends repeat the same ornament ("✦●✦ x ✦●✦", "▼•●• x •●• ▼").
    // An emoji-led channel name ("🇩🇪 Nordwelle 📺") does not.
    const leading = new Set(ends.leading);
    return ends.trailing.some((ch) => leading.has(ch));
}

/** "✦●✦|BG| KIDS ✦●✦" -> "BG| KIDS"; the label a section header announces. */
export function separatorLabel(name: string): string {
    const chars = [...bounded(name)];
    let start = 0;
    let end = chars.length;
    while (start < end && (isSpace(chars[start]) || isDecor(chars[start]))) start++;
    while (end > start && (isSpace(chars[end - 1]) || isDecor(chars[end - 1]))) end--;
    return chars.slice(start, end).join('').replace(/\s+/g, ' ').trim();
}

// ── Category Normalization ─────────────────────────────────────────────

/** Strip backup markers and quality indicators from group titles before matching */
function cleanGroupTitle(groupTitle: string): string {
    return bounded(groupTitle)
        .replace(/\s*\*+\s*/g, ' ')
        .replace(/\s*\/\s*(?:HD\+?|FHD|UHD|SD)\s*/gi, '')
        .replace(/\s*\/\s*backup\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalize a raw group-title into a genre category (`channel-genre.ts`).
 */
export function normalizeGroupTitle(groupTitle: string): string {
    if (!groupTitle || groupTitle.trim() === '') return 'Uncategorized';

    const cleaned = cleanGroupTitle(groupTitle);
    if (!cleaned) return 'Uncategorized';

    // A genre the title names ("Orb Topliga", "PL FILMY i SERIALE"), else
    // the title without its country part ("NL VELOPLAY" -> "VELOPLAY"), else
    // General ("SK • SLOVAKIA"). Channel names refine this in categorizeChannel.
    return genreFromSection(cleaned) ?? bouquetLabel(cleaned) ?? 'General';
}

// ── Regional Variant Detection ─────────────────────────────────────────

/**
 * Detect regional variants within processed channels.
 * Channels with same base name but different country codes are flagged as regional variants.
 * Channels that only appear in one country are marked as regional-only.
 */
function detectRegionalVariants(channels: ProcessedChannel[]): void {
    // Group non-VOD channels by base name
    const baseNameGroups = new Map<
        string,
        Array<{ index: number; countryCode: string | undefined }>
    >();

    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (ch.isVod) continue;

        const key = ch.baseName.toLowerCase();
        const group = baseNameGroups.get(key) ?? [];
        group.push({ index: i, countryCode: ch.original.countryCode });
        baseNameGroups.set(key, group);
    }

    for (const [, group] of baseNameGroups) {
        // Get unique country codes (excluding undefined)
        const countryCodes = new Set(
            group.map((g) => g.countryCode).filter((c): c is string => c !== undefined),
        );

        if (countryCodes.size <= 1) {
            // All from same country or no country codes — check if regional-only
            if (countryCodes.size === 1) {
                const countryCode = [...countryCodes][0];
                // Regional-only: channel only exists for one region
                for (const member of group) {
                    if (member.countryCode) {
                        channels[member.index].regionalVariant = {
                            countryCode,
                            baseName: channels[member.index].baseName,
                            isRegionalOnly: true,
                        };
                    }
                }
            }
            continue;
        }

        // Multiple country codes = regional variants (NOT backup groups)
        for (const member of group) {
            if (member.countryCode) {
                channels[member.index].regionalVariant = {
                    countryCode: member.countryCode,
                    baseName: channels[member.index].baseName,
                    isRegionalOnly: false,
                };
            }
        }
    }
}

// ── Mixed bouquets ─────────────────────────────────────────────────────

function mostCommon(values: ReadonlyArray<string | undefined>): string | undefined {
    const counts = new Map<string, number>();
    for (const v of values) if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: string | undefined;
    let bestCount = 0;
    for (const [v, count] of counts) if (count > bestCount) [best, bestCount] = [v, count];
    return best;
}

/** Leading "[Tag]", "(Tag)" or "Label:" sections a provider puts before a station name. */
const LEADING_TAG_RE = /^\s*(?:[[(][^\])]{1,30}[\])]|[^\s:|•]{1,20}\s*[:|•])\s*/u;

/** A station's name without tags, quality and punctuation, to find its other copies. */
function stationLookupKey(name: string): string {
    let base = stripCountryTag(name) ?? name;
    for (let i = 0; i < 2 && LEADING_TAG_RE.test(base); i++) {
        base = base.replace(LEADING_TAG_RE, '');
    }
    return extractBaseName(base)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

const NOT_A_STATION_GENRE: ReadonlySet<string> = new Set([
    GENRE.general,
    GENRE.loop,
    GENRE.adult,
    GENRE.religious,
]);

/** Different genres a bouquet's stations need before the bouquet stops being a category. */
const MIXED_BOUQUET_GENRES = 3;
/** Share of its stations whose genre is known. */
const MIXED_BOUQUET_KNOWN_SHARE = 0.2;

/**
 * A provider bouquet ("<Platform>", "<Service>TV") becomes a category when no
 * genre word says better (`categorizeChannel` step 4). Bouquets that carry a
 * whole platform (news, kids, sport and films side by side) make a useless
 * category: when its stations' own genres span several genres, each station
 * takes its genre — the category its other feeds sit in (backup group), else
 * a genre word in its name — and General without either.
 */
export function resolveMixedBouquets(
    channels: ProcessedChannel[],
    backupGroups: readonly BackupGroup[],
    keepCategories: ReadonlySet<string> = new Set(),
): void {
    /**
     * A genre that says something about the station: not a bouquet, not the
     * catch-all, and not 24/7, adult or religious, which describe one copy.
     */
    const genreOf = (i: number): string | undefined => {
        const category = channels[i].category;
        return channels[i].isVod || isBouquetCategory(category) || NOT_A_STATION_GENRE.has(category)
            ? undefined
            : category;
    };
    const groupGenre = new Map<number, string>();
    for (const group of backupGroups) {
        const best = mostCommon(group.channelIndices.map(genreOf));
        if (best) for (const i of group.channelIndices) groupGenre.set(i, best);
    }
    // Bouquet copies often carry the bouquet's own tag ("[Platform] Station HD")
    // and so stay out of the station's backup group: look the name up too.
    const byStation = new Map<string, Array<string | undefined>>();
    channels.forEach((ch, i) => {
        const genre = genreOf(i);
        if (!genre) return;
        const key = stationLookupKey(ch.original.name);
        const list = byStation.get(key) ?? [];
        list.push(genre);
        byStation.set(key, list);
    });
    const stationGenre = (name: string): string | undefined => {
        const key = stationLookupKey(name);
        const exact = byStation.get(key);
        if (exact) return mostCommon(exact);
        // "Station HD Austria": the station's market word after the name.
        const shorter = key.replace(/\s*\S+$/u, '');
        const loose = shorter && shorter !== key ? byStation.get(shorter) : undefined;
        return loose ? mostCommon(loose) : undefined;
    };

    const bouquets = new Map<string, number[]>();
    channels.forEach((ch, i) => {
        if (ch.isVod || !isBouquetCategory(ch.category)) return;
        const members = bouquets.get(ch.category) ?? [];
        members.push(i);
        bouquets.set(ch.category, members);
    });

    for (const [category, members] of bouquets) {
        if (keepCategories.has(category)) continue;
        const own = members.map(
            (i) =>
                groupGenre.get(i) ??
                stationGenre(channels[i].original.name) ??
                genreFromName(channels[i].original.name),
        );
        const known = own.filter((g): g is string => g !== undefined);
        // A few stray genre words in a large single-theme bouquet do not make it mixed.
        if (
            new Set(known).size < MIXED_BOUQUET_GENRES ||
            known.length < members.length * MIXED_BOUQUET_KNOWN_SHARE
        ) {
            continue;
        }
        members.forEach((i, k) => {
            channels[i].category = own[k] ?? GENRE.general;
        });
    }
}

// ── Pipeline Orchestrator ──────────────────────────────────────────────

/**
 * Process raw M3U channels through the auto-processing pipeline.
 * No database access, no logging of individual channel data (security — URLs contain credentials).
 *
 * Pipeline stages:
 * 1. Quality detection
 * 2. Base name extraction
 * 3. VOD filtering
 * 4. Category normalization
 * 5. Backup group detection
 * 6. Regional variant detection
 * 7. Primary channel selection
 */
export interface ProcessingOptions {
    /**
     * Bouquet categories to keep even when they mix genres: the ones the
     * source's Configure Lineup hides, so their channels stay hidden.
     */
    keepCategories?: ReadonlySet<string>;
}

export function processChannels(
    channels: M3uChannel[],
    options: ProcessingOptions = {},
): ProcessingResult {
    const warnings: Array<{ channel: string; field: string; message: string }> = [];
    const categoryMap = new Map<string, string>();

    // Stage 1-4: Enrich each channel. Section headers are dropped like VOD; a
    // channel without its own group-title takes the label of the last header
    // above it (a bare playlist has no group-title at all, so the headers are
    // its only grouping).
    let separatorCount = 0;
    let section = '';
    const rawGroups: string[] = [];
    const processed: ProcessedChannel[] = channels.map((channel) => {
        const qualityTier = detectQualityTier(channel.name);
        const baseName = extractBaseName(channel.name);
        const isSeparator = isSeparatorEntry(channel.name);
        if (isSeparator) {
            separatorCount++;
            section = separatorLabel(channel.name);
        }
        const isVod = isSeparator || isVodEntry(channel);
        const ownGroup = channel.groupTitle?.trim() ?? '';
        const rawGroup = ownGroup || (isSeparator ? '' : section);
        const category = isSeparator
            ? normalizeGroupTitle(rawGroup)
            : categorizeChannel(channel.name, cleanGroupTitle(rawGroup) || undefined);
        rawGroups.push(rawGroup);

        return {
            original: channel,
            region: isSeparator
                ? countryFromTvgSuffix(channel.countryCode)
                : detectChannelRegion(channel.name, rawGroup, channel.countryCode),
            qualityTier,
            baseName,
            category,
            backupGroupKey: undefined,
            isPrimary: false,
            isVod,
            regionalVariant: undefined,
        };
    });

    // Stage 5: Backup group detection (non-VOD channels only)
    const backupGroups = detectBackupGroups(processed);

    // Apply backup group info back to channels
    for (const group of backupGroups) {
        for (const idx of group.channelIndices) {
            processed[idx].backupGroupKey = group.key;
            processed[idx].isPrimary = idx === group.primaryIndex;
        }
    }

    // Stage 6: Regional variant detection
    detectRegionalVariants(processed);

    // Stage 7: bouquets that mix genres take each station's own genre.
    resolveMixedBouquets(processed, backupGroups, options.keepCategories);

    // One mapping per category: many provider groups collapse into one genre.
    processed.forEach((ch, i) => {
        if (!ch.isVod && !categoryMap.has(ch.category)) categoryMap.set(ch.category, rawGroups[i]);
    });

    // Build category mappings
    const categories: CategoryMapping[] = [...categoryMap.entries()].map(([normalized, raw]) => ({
        rawGroupTitle: raw,
        normalizedName: normalized,
    }));

    // Calculate statistics
    const nonVodChannels = processed.filter((ch) => !ch.isVod);
    const channelsInGroups = new Set(backupGroups.flatMap((g) => g.channelIndices));
    const regionalVariantCount = processed.filter(
        (ch) => ch.regionalVariant && !ch.regionalVariant.isRegionalOnly,
    ).length;

    const stats = {
        totalInput: channels.length,
        totalAfterVodFilter: nonVodChannels.length,
        backupGroupCount: backupGroups.length,
        uniqueChannelCount: nonVodChannels.length - channelsInGroups.size + backupGroups.length,
        categoryCount: categories.length,
        regionalVariantCount,
    };

    // Log aggregate stats only (never individual channel data — security)
    logger.info('Processing complete', {
        channels: stats.totalInput,
        afterVodFilter: stats.totalAfterVodFilter,
        backupGroups: stats.backupGroupCount,
        categories: stats.categoryCount,
    });

    return {
        channels: processed,
        backupGroups,
        categories,
        vodCount: channels.length - nonVodChannels.length,
        separatorCount,
        stats,
        warnings,
    };
}
