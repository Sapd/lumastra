// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detects numbered channel families (e.g. "ZAVO EVENT 1"..."ZAVO EVENT 30")
 * within a list of LiveTV channels so the grid can collapse them behind a
 * single group card instead of rendering a wall of near-identical cards.
 */

import type { LiveTvStation } from '$lib/schemas/livetv.js';

export interface ChannelFamily {
    key: string;
    label: string;
    channels: LiveTvStation[];
}

export function isChannelFamily(item: LiveTvStation | ChannelFamily): item is ChannelFamily {
    return 'channels' in item;
}

/** Matches a trailing 1-3 digit number, with optional separators, at the end of a name. */
const NUMBERED_NAME_RE = /^(.*?)[\s.|#-]*(\d{1,3})$/;

/**
 * Notes and quality tags after the slot number: "<stem> 3 [EVENT ONLY]",
 * "<stem> 3 HD", "<stem> 3 FHD (LIVE ON MATCH)".
 */
const TRAILING_TAG_RE = /\s*(?:[[(][^\])]*[\])]|\b(?:(?:U|F)?HD\+?|SD|4K|HEVC|RAW)\b)\s*$/i;

function withoutTrailingTags(name: string): string {
    let out = name;
    for (let i = 0; i < 4; i++) {
        const next = out.replace(TRAILING_TAG_RE, '').trimEnd();
        if (next === out || !next) break;
        out = next;
    }
    return out;
}

const MIN_PREFIX_LENGTH = 3;

interface ParsedEntry {
    channel: LiveTvStation;
    index: number;
    prefixKey: string;
    prefixLabel: string;
    num: number;
}

function normalizePrefix(raw: string): string {
    return raw.trim().replace(/\s+/g, ' ');
}

function hasRealEpg(channel: LiveTvStation): boolean {
    const title = channel.nowNext.current?.title;
    return typeof title === 'string' && title.trim().length > 0;
}

/**
 * Groups channels that share a numbered-name prefix (e.g. "Telesport Extra 1"
 * .. "Telesport Extra 32") into a `ChannelFamily`, called per-category by the
 * grid. Channels currently airing a real program stay outside the family as
 * individual items; only the EPG-less members collapse.
 */
export function groupNumberedFamilies(
    channels: LiveTvStation[],
    minSize = 5,
): { items: Array<LiveTvStation | ChannelFamily> } {
    const groups = new Map<string, ParsedEntry[]>();

    channels.forEach((channel, index) => {
        const trimmed = withoutTrailingTags(channel.name.trim());
        const match = NUMBERED_NAME_RE.exec(trimmed);
        if (!match) return;

        const prefixLabel = normalizePrefix(match[1]);
        if (prefixLabel.length < MIN_PREFIX_LENGTH) return;

        const prefixKey = prefixLabel.toLowerCase();
        const num = Number.parseInt(match[2], 10);

        const entry: ParsedEntry = { channel, index, prefixKey, prefixLabel, num };
        const existing = groups.get(prefixKey);
        if (existing) {
            existing.push(entry);
        } else {
            groups.set(prefixKey, [entry]);
        }
    });

    const collapsedIndices = new Set<number>();
    const familyAtIndex = new Map<number, ChannelFamily>();

    for (const entries of groups.values()) {
        if (entries.length < minSize) continue;

        const collapsible = entries.filter((entry) => !hasRealEpg(entry.channel));
        if (collapsible.length < minSize) continue;

        const sortedMembers = [...collapsible].sort((a, b) => a.num - b.num);
        const firstIndex = collapsible.reduce((min, entry) => Math.min(min, entry.index), Infinity);

        for (const entry of collapsible) collapsedIndices.add(entry.index);

        familyAtIndex.set(firstIndex, {
            key: entries[0].prefixKey,
            label: entries[0].prefixLabel,
            channels: sortedMembers.map((entry) => entry.channel),
        });
    }

    const items: Array<LiveTvStation | ChannelFamily> = [];
    channels.forEach((channel, index) => {
        const family = familyAtIndex.get(index);
        if (family) {
            items.push(family);
            return;
        }
        if (collapsedIndices.has(index)) return;
        items.push(channel);
    });

    return { items };
}
