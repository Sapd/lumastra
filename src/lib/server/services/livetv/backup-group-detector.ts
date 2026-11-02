// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { QUALITY_PRIORITY, hasFeedMarker, isDegradedFeed } from './auto-processor.js';
import { countryFromLabel, stripCountryTag } from './channel-country.js';
import type { ProcessedChannel, BackupGroup, QualityTier } from './auto-processor.js';

// ── Backup Group Detection ─────────────────────────────────────────────

/**
 * Generate a stable group key from base name and tvg-id.
 * Format: lowercase baseName | tvgId (or just baseName if no tvgId)
 */
function makeGroupKey(
    baseName: string,
    tvgId: string | undefined,
    qualityClass: 'uhd' | 'sdr' = 'sdr',
    country = '',
): string {
    const normalizedBase = baseName.toLowerCase();
    // UHD feeds form a separate group from the FHD/HD feed of the same base name,
    // so they need a distinct key or the two groups would collide. So do the
    // country-separated groups of one station (".de" and ".at"): the tvg-id
    // suffix is stripped below, and the import maps a key to one group row.
    const suffix =
        (country ? `|c:${country.toLowerCase()}` : '') + (qualityClass === 'uhd' ? '|uhd' : '');
    if (tvgId) {
        // Strip country code suffix from tvg-id for grouping (e.g., "Nordwelle.de" -> "Nordwelle")
        const baseId = tvgId.replace(/\.[a-z]{2,3}$/i, '').toLowerCase();
        return `${normalizedBase}|${baseId}${suffix}`;
    }
    return `${normalizedBase}${suffix}`;
}

/**
 * Get quality priority for a channel (0 for undefined quality).
 */
function getQualityScore(tier: QualityTier | undefined): number {
    return tier ? QUALITY_PRIORITY[tier] : 0;
}

/**
 * The name a station is grouped by: case, accents, spaces and separator
 * punctuation do not tell stations apart ("LRV-alpha HD" / "LRV alpha HDraw", "KWFneo FHD" /
 * "KWF_neo HDraw" are one station; split, viewers got it twice and the guide
 * reached only one of the two).
 */
export function stationKey(baseName: string): string {
    return (
        baseName
            .toLowerCase()
            .normalize('NFKD')
            .replace(/\p{M}/gu, '')
            // Separators only: a "+" or "&" is part of a name ("ANVIO" ≠ "ANVIO+"),
            // and so is a dot between letters ("o.tz" ≠ "OTZ"); "Pino Jr." = "Pino Jr".
            .replace(/\.(?![\p{L}\p{N}])/gu, '')
            .replace(/[\s\-_:'’·]/gu, '')
    );
}

/** A leading bracketed bouquet tag: "[Bouquet] Station HD". */
const BRACKET_TAG_RE = /^\s*\[[^\]]{2,24}\]\s*/u;

/**
 * The base name without the provider's leading tag: a country ("AT: Station",
 * "Spain- Station") or a bracketed bouquet ("[Bouquet] Station"). The same
 * station listed in two provider sections is one station.
 */
export function untaggedBaseName(baseName: string): string {
    const name = stripCountryTag(baseName) ?? baseName;
    const withoutBracket = name.replace(BRACKET_TAG_RE, '');
    return /\p{L}/u.test(withoutBracket) ? withoutBracket : name;
}

/**
 * Feeds of one key whose names carry different country tags ("UK: History",
 * "US: History") are different stations: split them by that tag. Feeds without
 * a tag stay together with the rest only when at most one tagged country is
 * present (the "AT: Station HD" + "Station HDraw" case).
 */
function splitByNameCountry(channels: ProcessedChannel[], indices: number[]): number[][] {
    const byTag = new Map<string, number[]>();
    for (const idx of indices) {
        const tag = countryFromLabel(channels[idx].original.name) ?? '_untagged_';
        const list = byTag.get(tag) ?? [];
        list.push(idx);
        byTag.set(tag, list);
    }
    const tagged = [...byTag.keys()].filter((tag) => tag !== '_untagged_');
    return tagged.length <= 1 ? [indices] : [...byTag.values()];
}

/**
 * Detect backup groups among processed channels.
 * Multi-signal detection:
 * 1. Name matching (primary): channels with same baseName
 * 2. tvg-id confirmation (high): channels sharing same tvgId
 * 3. Group-title cross-reference (tiebreaker): same/similar group-title
 *
 * Excludes VOD entries and respects regional variant distinctions.
 */
export function detectBackupGroups(channels: ProcessedChannel[]): BackupGroup[] {
    // Group channels by base name (primary signal)
    const baseNameGroups = new Map<string, number[]>();

    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        if (ch.isVod) continue;

        const key = stationKey(untaggedBaseName(ch.baseName));
        const group = baseNameGroups.get(key) ?? [];
        group.push(i);
        baseNameGroups.set(key, group);
    }

    const backupGroups: BackupGroup[] = [];

    for (const [, indices] of baseNameGroups) {
        if (indices.length < 2) continue;

        // Sub-group by country code to separate regional variants from backups,
        // and by UHD-ness: a UHD feed carries its own schedule and rights (e.g.
        // "MTK UHD" only simulcasts select events) so it is a distinct channel,
        // not a higher-quality mirror of the FHD/HD feed. Merging the two hid the
        // FHD entry entirely and moved the card to the UHD feed's playlist slot.
        const bySubGroup = new Map<string, number[]>();
        for (const idx of indices) {
            const cc = channels[idx].original.countryCode ?? '_none_';
            const qualityClass = channels[idx].qualityTier === 'uhd' ? 'uhd' : 'sdr';
            const subKey = `${cc}|${qualityClass}`;
            const group = bySubGroup.get(subKey) ?? [];
            group.push(idx);
            bySubGroup.set(subKey, group);
        }

        // Each sub-group forms its own backup group (if 2+ channels)
        for (const countryIndices of [...bySubGroup.values()].flatMap((list) =>
            splitByNameCountry(channels, list),
        )) {
            if (countryIndices.length < 2) continue;

            // Verify with additional signals
            const signals: string[] = ['name_match'];

            // Check tvg-id confirmation
            const tvgIds = new Set(
                countryIndices
                    .map((i) => channels[i].original.tvgId)
                    .filter((id): id is string => id != null),
            );
            if (tvgIds.size === 1) {
                signals.push('tvg_id_match');
            }

            // Check group-title similarity
            const groupTitles = new Set(
                countryIndices
                    .map((i) => channels[i].original.groupTitle)
                    .filter((g): g is string => g !== undefined),
            );
            // Strip backup markers from group titles for comparison
            const normalizedTitles = new Set(
                [...groupTitles].map((g) =>
                    g
                        .slice(0, 512)
                        .replace(/\s*\*+/g, '')
                        .trim(),
                ),
            );
            if (normalizedTitles.size === 1) {
                signals.push('group_title_match');
            }

            // Sort by quality (best first), then prefer the clean feed over marked
            // backups (*, superscript, WEB) of the same quality, then original order.
            // This keeps the unmarked feed as the group's primary (the visible card)
            // and pushes the alternate/mirror feeds into the backup slots.
            // A transcoded, mobile or backup feed is never the primary while a
            // normal feed exists, even at a higher quality tier.
            const sorted = [...countryIndices].sort((a, b) => {
                const degradedDiff =
                    Number(isDegradedFeed(channels[a].original.name)) -
                    Number(isDegradedFeed(channels[b].original.name));
                if (degradedDiff !== 0) return degradedDiff;
                const qualDiff =
                    getQualityScore(channels[b].qualityTier) -
                    getQualityScore(channels[a].qualityTier);
                if (qualDiff !== 0) return qualDiff;
                const markDiff =
                    Number(hasFeedMarker(channels[a].original.name)) -
                    Number(hasFeedMarker(channels[b].original.name));
                if (markDiff !== 0) return markDiff; // marked feed sorts after the clean one
                return a - b; // preserve original order
            });

            const primaryIndex = sorted[0];
            const primaryChannel = channels[primaryIndex];

            // Build group key from primary channel
            const key = makeGroupKey(
                primaryChannel.baseName,
                primaryChannel.original.tvgId,
                primaryChannel.qualityTier === 'uhd' ? 'uhd' : 'sdr',
                primaryChannel.original.countryCode ??
                    countryFromLabel(primaryChannel.original.name) ??
                    '',
            );

            backupGroups.push({
                key,
                name: primaryChannel.baseName,
                channelIndices: sorted,
                primaryIndex,
                detectionSignals: signals,
            });
        }
    }

    return backupGroups;
}
