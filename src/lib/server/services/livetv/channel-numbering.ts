// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LiveTvCategory, LiveTvChannel } from '$lib/schemas/livetv';

/** A channel paired with the channel number a Jellyfin client should display. */
export interface NumberedChannel {
    channel: LiveTvChannel;
    number: number;
}

/** Narrowest block we ever use, so numbers stay human-readable on a remote. */
const MIN_BLOCK_WIDTH = 100;

/**
 * Smallest power of ten that is strictly greater than `largestBucket`, floored at
 * MIN_BLOCK_WIDTH. Strictly greater matters: the first category is numbered from 1,
 * so it occupies 1..largestBucket and must stay clear of the second block.
 *
 * Derived from the data rather than hardcoded — installs differ wildly in both
 * channel count and category count.
 */
function blockWidth(largestBucket: number): number {
    let width = MIN_BLOCK_WIDTH;
    while (width <= largestBucket) width *= 10;
    return width;
}

/**
 * Assigns each channel a category-blocked number and returns the channels in the
 * order those numbers imply.
 *
 * The first category is numbered from 1; every later category starts at its
 * 1-based position times the block width, so the leading digit identifies the
 * category (block 1 stays unused by design — see the numbering decision below):
 *
 *   Sports (419 chans)    1 ..  419
 *   Free TV (73 chans) 2000 .. 2072
 *   Orb (20 chans)     3000 .. 3019
 *
 * Block width scales to the largest category (100 while every category fits in
 * 99 channels, 1000 up to 999, and so on), so a small install gets short numbers
 * and a large one still never collides.
 *
 * Categories with no visible channels are skipped rather than consuming a block.
 * Channels whose category is missing or unknown are grouped into a trailing block.
 *
 * Ordering matters as much as the numbers: `getAllVisibleChannels` returns channels
 * ordered by `sort_order` globally, which INTERLEAVES categories (sort_order is a
 * within-category key). Numbering that list positionally would make the guide jump
 * between categories, so this groups by category first and orders within a category
 * by `sortOrder`, then name.
 */
export function numberChannelsByCategory(
    channels: LiveTvChannel[],
    categories: LiveTvCategory[],
): NumberedChannel[] {
    const orderedCategoryIds = [...categories]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((category) => category.id);

    // Bucket key: the category id, or a sentinel for channels without a known one.
    const UNCATEGORIZED = Symbol('uncategorized');
    const buckets = new Map<string | symbol, LiveTvChannel[]>();
    const knownCategoryIds = new Set(orderedCategoryIds);

    for (const channel of channels) {
        const key =
            channel.categoryId && knownCategoryIds.has(channel.categoryId)
                ? channel.categoryId
                : UNCATEGORIZED;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(channel);
        else buckets.set(key, [channel]);
    }

    // Category order first, then the uncategorized remainder. Empty categories
    // never made it into the map, so they consume no block.
    const orderedKeys: Array<string | symbol> = orderedCategoryIds.filter((id) => buckets.has(id));
    if (buckets.has(UNCATEGORIZED)) orderedKeys.push(UNCATEGORIZED);

    const width = blockWidth(Math.max(0, ...[...buckets.values()].map((b) => b.length)));

    const numbered: NumberedChannel[] = [];
    orderedKeys.forEach((key, blockIndex) => {
        const bucket = buckets.get(key) ?? [];
        bucket.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

        // First category starts at 1; later ones at (position + 1) * width so the
        // leading digit reads as the category number.
        const start = blockIndex === 0 ? 1 : (blockIndex + 1) * width;
        bucket.forEach((channel, offset) => {
            numbered.push({ channel, number: start + offset });
        });
    });

    return numbered;
}

/**
 * Assigns each channel a dense 1-based lineup position — the flat "all channels"
 * order a client shows when NOT grouping by category (1 = first channel of the
 * first category, 2 = the next, …). Unlike {@link numberChannelsByCategory}'s
 * category-blocked numbers (built for Jellyfin remotes), positions here are
 * contiguous, which is what a "real TV lineup" reads like.
 *
 * Ordering is identical to numberChannelsByCategory: categories by `sortOrder`
 * then name, channels within a category by `sortOrder` then name, with
 * uncategorized channels trailing. This matters because `getAllVisibleChannels`
 * returns channels ordered by a globally-sorted `sort_order` that INTERLEAVES
 * categories (sort_order is a within-category key), so a client cannot derive
 * this order itself.
 *
 * Returns a Map keyed by channel id, so callers can annotate an existing channel
 * list in place without reordering the payload.
 */
export function assignGlobalChannelNumbers(
    channels: LiveTvChannel[],
    categories: LiveTvCategory[],
): Map<string, number> {
    const categoryOrder = new Map<string, number>();
    [...categories]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .forEach((category, index) => categoryOrder.set(category.id, index));

    // Unknown/missing category → trails every real category.
    const categoryRank = (channel: LiveTvChannel): number => {
        const rank = channel.categoryId ? categoryOrder.get(channel.categoryId) : undefined;
        return rank ?? Number.MAX_SAFE_INTEGER;
    };

    const ordered = [...channels].sort(
        (a, b) =>
            categoryRank(a) - categoryRank(b) ||
            a.sortOrder - b.sortOrder ||
            a.name.localeCompare(b.name),
    );

    const numbers = new Map<string, number>();
    ordered.forEach((channel, index) => numbers.set(channel.id, index + 1));
    return numbers;
}

/**
 * The lineup with the numbers viewers dial, in number order. The standalone
 * provider stores stable numbers per station card (channel-numbers.service.ts)
 * and sets `channelNumber`; a channel without one (only past 9999) trails after
 * the highest number. A provider without stored numbers (none of the channels
 * has one) keeps the category-blocked numbering of {@link numberChannelsByCategory}.
 */
export function numberChannelsForLineup(
    channels: LiveTvChannel[],
    categories: LiveTvCategory[],
): NumberedChannel[] {
    if (!channels.some((channel) => channel.channelNumber !== undefined)) {
        return numberChannelsByCategory(channels, categories);
    }
    const numbered = channels.filter((channel) => channel.channelNumber !== undefined);
    const highest = Math.max(...numbered.map((channel) => channel.channelNumber as number));
    const rest = numberChannelsByCategory(
        channels.filter((channel) => channel.channelNumber === undefined),
        categories,
    );
    return [
        ...numbered
            .map((channel) => ({ channel, number: channel.channelNumber as number }))
            .sort((a, b) => a.number - b.number),
        ...rest.map((entry, index) => ({ channel: entry.channel, number: highest + index + 1 })),
    ];
}
