// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which channels a source's lineup keeps: the country/region, 24/7, noise
 * (`lineup-noise.ts`) and category choices from Configure Lineup. Pure, so the
 * guided setup, a re-import and a refresh (new channels only) all decide the
 * same way.
 *
 * @module services/livetv/lineup-filter
 */

import { expandRegions, isLoopChannel } from './channel-country.js';
import type { NoiseKind } from './lineup-noise.js';

export interface LineupFilter {
    /** Country or region codes to keep; empty keeps every country. */
    countries: string[];
    /** With `countries` set: keep channels without a detected country. */
    includeUntagged: boolean;
    hideLoopChannels: boolean;
    /** Info and welcome screens ("Event Info", "Welcome Channel"). */
    hideInfoChannels: boolean;
    /** Numbered slots that stay dark until a match ("<Bouquet> Event 12"). */
    hideEventSlots: boolean;
    /** A network's local stations, each with its own call sign. */
    hideLocalStations: boolean;
    hideRadio: boolean;
    /** Category names (as stored) whose channels are hidden. */
    hiddenCategories: string[];
}

/** The noise switches and the kind each one hides. */
const NOISE_SWITCHES: ReadonlyArray<readonly [keyof LineupFilter, NoiseKind]> = [
    ['hideLoopChannels', 'loop'],
    ['hideInfoChannels', 'info'],
    ['hideEventSlots', 'eventSlot'],
    ['hideLocalStations', 'localStation'],
    ['hideRadio', 'radio'],
];

export interface LineupChannel {
    id: string;
    title: string;
    country_code: string | null;
    category_name: string | null;
}

/** The name the setup summary lists channels without a category under. */
const UNCATEGORIZED = 'Uncategorized';

interface CompiledFilter {
    kept: Set<string>;
    hidden: Set<string>;
}

// A filter is checked against every channel of a 12k-channel source: build its
// sets once per filter object, not once per channel.
const compiled = new WeakMap<LineupFilter, CompiledFilter>();

function compile(filter: LineupFilter): CompiledFilter {
    let c = compiled.get(filter);
    if (!c) {
        c = { kept: expandRegions(filter.countries), hidden: new Set(filter.hiddenCategories) };
        compiled.set(filter, c);
    }
    return c;
}

const NO_NOISE: ReadonlySet<NoiseKind> = new Set();

/**
 * `kinds`: what `classifyLineup` found the channel to be. Without it only the
 * 24/7 tag in the name or category counts.
 */
export function isChannelKept(
    channel: LineupChannel,
    filter: LineupFilter,
    kinds: ReadonlySet<NoiseKind> = NO_NOISE,
): boolean {
    if (
        filter.hideLoopChannels &&
        (isLoopChannel(channel.title) || isLoopChannel(channel.category_name ?? undefined))
    ) {
        return false;
    }
    for (const [option, kind] of NOISE_SWITCHES) {
        if (filter[option] === true && kinds.has(kind)) return false;
    }
    const { kept, hidden } = compile(filter);
    if (hidden.has(channel.category_name ?? UNCATEGORIZED)) {
        return false;
    }
    if (filter.countries.length === 0) return true;
    if (!channel.country_code) return filter.includeUntagged;
    return kept.has(channel.country_code);
}

/** Parse a stored `lineup_filter` value; anything malformed counts as "no filter". */
export function parseLineupFilter(value: unknown): LineupFilter | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    // Every stored filter has a country list (possibly empty); without one it
    // was not written by Configure Lineup.
    if (!Array.isArray(v.countries)) return null;
    const strings = (x: unknown): string[] =>
        Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
    return {
        countries: strings(v.countries),
        includeUntagged: v.includeUntagged !== false,
        hideLoopChannels: v.hideLoopChannels === true,
        // Filters stored before these switches existed hide none of it.
        hideInfoChannels: v.hideInfoChannels === true,
        hideEventSlots: v.hideEventSlots === true,
        hideLocalStations: v.hideLocalStations === true,
        hideRadio: v.hideRadio === true,
        hiddenCategories: strings(v.hiddenCategories),
    };
}
