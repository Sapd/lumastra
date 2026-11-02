// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The channel name viewers see, derived from the provider's raw name.
 *
 * Providers prefix names with a section tag ("UK: Station", "US : Station",
 * "DE • Station", "[Bouquet] Station", "SVC: Event 3") and append quality and
 * feed words ("FHD", "HDraw", "HEVC", "50FPS", "(Alt 2)", "ʀᴀᴡ", "²"). Viewers
 * get the station's name without either.
 *
 * Derived at read time (under LIVETV_HIDE_QUALITY_TAGS), never stored: the raw
 * name stays in `media_items.title` for EPG matching, search aliases and the
 * admin views, an admin rename (`admin_display_name`) always wins, and a change
 * to these rules reaches every lineup without a re-import.
 *
 * A tag stays when it is what tells two cards apart: "UK: History" next to
 * "US: History", or one service's "Event 1..30" next to another's. Tags are
 * compared per name stem (the name without a trailing number), so a numbered
 * family keeps or drops its tag as a whole and never splits.
 */

import { detectQualityTier, extractBaseName } from './auto-processor.js';
import { stationKey } from './backup-group-detector.js';
import { countryFromLabel, stripCountryTag } from './channel-country.js';

/** A leading bracketed bouquet tag: "[Bouquet] Station HD". */
const BRACKET_TAG_RE = /^\s*\[[^\]]{2,24}\]\s*/u;

/**
 * A leading service tag that is not a country: capitals or digits before a
 * colon, bullet or bar ("SVC: Event 3", "AB1 | Station"). Only stripped when
 * the lineup shows it on several channels (see SERVICE_TAG_MIN_CHANNELS): a
 * single "XYZ: Hits" may be the station's own name.
 */
const SERVICE_TAG_RE = /^[^\p{L}\p{N}]*?(\p{Lu}[\p{Lu}\d]{1,5})\s*[:|•]\s*/u;

/** Channels a non-country tag must prefix before it counts as a provider tag. */
const SERVICE_TAG_MIN_CHANNELS = 3;

/** Separator punctuation left at the start once a tag is gone ("- Station"). */
const LEADING_SEPARATOR_RE = /^[\s\-–—|•:·]+/u;

/** A trailing channel number: the stem of "Event 12" is "Event". */
const TRAILING_NUMBER_RE = /[\s.\-#]*\d{1,3}$/u;

interface SplitName {
    /** The tag as written ("US :", "[Bouquet]"), or undefined. */
    tag: string | undefined;
    /** What the tag means: "US :" and "US:" are one tag ("us"). */
    tagKey: string | undefined;
    /** The name after the tag. */
    rest: string;
    /** True for a service tag, which needs SERVICE_TAG_MIN_CHANNELS to count. */
    needsQuorum: boolean;
}

function hasLetter(text: string): boolean {
    return /\p{L}/u.test(text);
}

/** Split a raw name into its leading provider tag and the rest. */
export function splitProviderTag(raw: string): SplitName {
    const name = raw.trim();
    const untagged = stripCountryTag(name);
    if (untagged !== undefined && hasLetter(untagged)) {
        const tag = tagText(name, untagged);
        const tagKey = countryFromLabel(name) ?? stationKey(tag);
        return { tag, tagKey, rest: untagged, needsQuorum: false };
    }
    const bracket = BRACKET_TAG_RE.exec(name);
    if (bracket) {
        const rest = name.slice(bracket[0].length).trim();
        if (hasLetter(rest)) {
            const tag = bracket[0].trim();
            return { tag, tagKey: stationKey(tag), rest, needsQuorum: false };
        }
    }
    const service = SERVICE_TAG_RE.exec(name);
    if (service) {
        const rest = name.slice(service[0].length).trim();
        if (hasLetter(rest)) {
            return { tag: service[1], tagKey: stationKey(service[1]), rest, needsQuorum: true };
        }
    }
    return { tag: undefined, tagKey: undefined, rest: name, needsQuorum: false };
}

function tagText(name: string, rest: string): string {
    return name.slice(0, name.length - rest.length).trim();
}

/** A UHD word already in a cleaned name. */
const UHD_WORD_RE = /(?:^|[^\p{L}\p{N}])(?:UHD|4K|2160p)(?![\p{L}\p{N}])/iu;

/** Separators left next to each other where a quality word was ("NFL | - Playoffs"). */
const DOUBLED_SEPARATOR_RE = /(\s[|•–—-])(?:\s+[|•–—-])+(?=\s)/gu;

/**
 * UHD is the one quality word viewers keep: UHD feeds are few, often their own
 * programme (a UHD sports or event channel), and next to the station's normal
 * feed the two cards must not read the same ("RTL" and "RTL UHD").
 */
function withUhd(source: string, cleaned: string): string {
    const tidy = cleaned.replace(DOUBLED_SEPARATOR_RE, '$1').trim();
    if (!tidy || detectQualityTier(source) !== 'uhd' || UHD_WORD_RE.test(tidy)) return tidy;
    // The provider's own word: "… 4K" stays 4K, "UHDraw"/"2160p" read UHD.
    const word = /(?:^|[^\p{L}\p{N}])4K(?![\p{L}\p{N}])/iu.test(source) ? '4K' : 'UHD';
    return `${tidy} ${word}`;
}

function cleanRest(rest: string): string {
    return withUhd(rest, extractBaseName(rest).replace(LEADING_SEPARATOR_RE, '').trim());
}

/** The name with its tag kept, quality words still cleaned: "UK: History". */
function taggedName(raw: string): string {
    return withUhd(raw, extractBaseName(raw.trim()));
}

/**
 * One channel's viewer name without the rest of the lineup: country and
 * bracket tags go, a service tag stays (nothing shows it is the provider's).
 * For channels outside the lineup (a hidden feed opened from the feed picker).
 */
export function viewerChannelName(raw: string): string {
    const split = splitProviderTag(raw);
    const name =
        split.tag !== undefined && !split.needsQuorum ? cleanRest(split.rest) : taggedName(raw);
    return name || raw.trim();
}

export interface ViewerNameInput {
    id: string;
    /** Raw provider name. */
    name: string;
    /** Admin rename: shown unchanged. */
    adminDisplayName?: string | null;
}

/** The stem a numbered family shares: "Event 12" and "Event 3" -> "event". */
function stemKey(name: string): string {
    return stationKey(name.replace(TRAILING_NUMBER_RE, '') || name);
}

function addStemTag(tagsByStem: Map<string, Set<string>>, name: string, tagKey: string): void {
    const stem = stemKey(name);
    const tags = tagsByStem.get(stem) ?? new Set<string>();
    tags.add(tagKey);
    tagsByStem.set(stem, tags);
}

/**
 * Viewer names for a whole lineup, by channel id. A tag is dropped unless
 * another card with the same name stem carries a different tag (or none), in
 * which case every tagged card of that stem keeps its tag.
 */
export function viewerChannelNames(channels: readonly ViewerNameInput[]): Map<string, string> {
    const result = new Map<string, string>();
    const splits = new Map<string, SplitName>();
    const serviceTagCounts = new Map<string, number>();

    for (const ch of channels) {
        if (ch.adminDisplayName) continue;
        const split = splitProviderTag(ch.name);
        splits.set(ch.id, split);
        if (split.tagKey !== undefined && split.needsQuorum) {
            serviceTagCounts.set(split.tagKey, (serviceTagCounts.get(split.tagKey) ?? 0) + 1);
        }
    }

    // Candidate names, and which tags share each stem.
    const candidates = new Map<string, { name: string; stripped: boolean }>();
    const tagsByStem = new Map<string, Set<string>>();
    for (const ch of channels) {
        const split = splits.get(ch.id);
        if (!split) {
            // An admin's name is a card too: "UK: Orb History" next to a card
            // renamed "Orb History" keeps its tag.
            if (ch.adminDisplayName) addStemTag(tagsByStem, ch.adminDisplayName, '');
            continue;
        }
        const counts =
            split.tagKey !== undefined &&
            (!split.needsQuorum ||
                (serviceTagCounts.get(split.tagKey) ?? 0) >= SERVICE_TAG_MIN_CHANNELS);
        const clean = counts ? cleanRest(split.rest) : '';
        const name = clean || taggedName(ch.name) || ch.name.trim();
        candidates.set(ch.id, { name, stripped: clean !== '' });
        addStemTag(tagsByStem, name, clean ? (split.tagKey ?? '') : '');
    }

    for (const ch of channels) {
        if (ch.adminDisplayName) {
            result.set(ch.id, ch.adminDisplayName);
            continue;
        }
        const candidate = candidates.get(ch.id);
        if (!candidate) continue;
        const ambiguous =
            candidate.stripped && (tagsByStem.get(stemKey(candidate.name))?.size ?? 0) > 1;
        result.set(ch.id, ambiguous ? taggedName(ch.name) || candidate.name : candidate.name);
    }
    return result;
}
