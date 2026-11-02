// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Season color palette for episode ordering visualizations.
 * Returns Tailwind color classes and hex values for SVG.
 */

const SEASON_PALETTE = [
    {
        bg: 'bg-blue-500/20',
        text: 'text-blue-400',
        border: 'border-blue-500/40',
        hex: '#60a5fa',
        dot: 'bg-blue-400',
    },
    {
        bg: 'bg-emerald-500/20',
        text: 'text-emerald-400',
        border: 'border-emerald-500/40',
        hex: '#34d399',
        dot: 'bg-emerald-400',
    },
    {
        bg: 'bg-amber-500/20',
        text: 'text-amber-400',
        border: 'border-amber-500/40',
        hex: '#fbbf24',
        dot: 'bg-amber-400',
    },
    {
        bg: 'bg-rose-500/20',
        text: 'text-rose-400',
        border: 'border-rose-500/40',
        hex: '#fb7185',
        dot: 'bg-rose-400',
    },
    {
        bg: 'bg-violet-500/20',
        text: 'text-violet-400',
        border: 'border-violet-500/40',
        hex: '#a78bfa',
        dot: 'bg-violet-400',
    },
    {
        bg: 'bg-cyan-500/20',
        text: 'text-cyan-400',
        border: 'border-cyan-500/40',
        hex: '#22d3ee',
        dot: 'bg-cyan-400',
    },
    {
        bg: 'bg-orange-500/20',
        text: 'text-orange-400',
        border: 'border-orange-500/40',
        hex: '#fb923c',
        dot: 'bg-orange-400',
    },
    {
        bg: 'bg-pink-500/20',
        text: 'text-pink-400',
        border: 'border-pink-500/40',
        hex: '#f472b6',
        dot: 'bg-pink-400',
    },
    {
        bg: 'bg-lime-500/20',
        text: 'text-lime-400',
        border: 'border-lime-500/40',
        hex: '#a3e635',
        dot: 'bg-lime-400',
    },
    {
        bg: 'bg-sky-500/20',
        text: 'text-sky-400',
        border: 'border-sky-500/40',
        hex: '#38bdf8',
        dot: 'bg-sky-400',
    },
] as const;

export type SeasonColor = (typeof SEASON_PALETTE)[number];

/** Get color for a season number (1-indexed, wraps for > 10 seasons) */
export function getSeasonColor(seasonNumber: number): SeasonColor {
    const index =
        (((seasonNumber - 1) % SEASON_PALETTE.length) + SEASON_PALETTE.length) %
        SEASON_PALETTE.length;
    return SEASON_PALETTE[index];
}

/** Get all unique season numbers from episodes, sorted */
export function getUniqueSeasons(episodes: Array<{ originalSeason: number }>): number[] {
    return [...new Set(episodes.map((e) => e.originalSeason))].sort((a, b) => a - b);
}
