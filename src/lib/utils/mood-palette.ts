// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared mood→color palette utility.
 *
 * SINGLE COLOR VOCABULARY used by:
 *   - Alchemy mixing desk mood-island map (Canvas2D dots)
 *   - Queue track-row energy/mood dot (QueueTrackItem)
 *   - MiniPlayer mood-tint accent
 *   - BrewResponse.moodAnchors[].color (server-side, import from this module)
 *
 * CONTRACT (Haiku agent implements the function bodies):
 *
 *   moodToColor(mood: string): string
 *     Maps a mood tag string (e.g. "happy", "aggressive", "sad") to a hex
 *     color string (e.g. "#f59e0b"). Case-insensitive. Unknown moods fall
 *     back to MOOD_PALETTE_FALLBACK. Must be pure and deterministic.
 *
 *   energyToColor(energy: number): string
 *     Maps a continuous energy value in [0, 1] to a hex color string by
 *     interpolating through the energy gradient. 0 = cool/low energy color,
 *     1 = hot/high energy color. Must be pure and deterministic.
 *     energy values outside [0, 1] are clamped.
 *
 * IMPLEMENTATION NOTES for Haiku:
 *   - Keep the palette consistent with the Lumastra dark-slate aesthetic
 *     (slate-900 background). Colors must be legible on dark backgrounds.
 *   - The palette is intentionally small (≤ 16 named moods) so every color
 *     is distinctive and memorable. Unknown moods share the fallback color.
 *   - Do NOT use random or time-based values — callers rely on determinism
 *     for stable island positions across re-renders.
 *   - This module is imported on both the server (brew endpoint sets
 *     MoodIslandAnchor.color) and the client (Canvas2D + queue row + MiniPlayer).
 *     Keep it free of server-only imports ($env, database, etc.).
 *
 * IMPORT PATH (canonical, do not move this file):
 *   import { moodToColor, energyToColor, MOOD_PALETTE_FALLBACK } from '$lib/utils/mood-palette';
 */

/**
 * Fallback color for moods not in the palette.
 * Used by moodToColor() and as the default island color.
 */
export const MOOD_PALETTE_FALLBACK = '#64748b'; // slate-500

/**
 * Named mood palette — a small, memorable set of distinct colors.
 * Each color is chosen for legibility on slate-900 dark backgrounds.
 * Unknown moods fall back to MOOD_PALETTE_FALLBACK.
 */
const MOOD_COLORS: Record<string, string> = {
    // Primary emotions
    happy: '#fbbf24', // amber-400
    sad: '#60a5fa', // blue-400
    angry: '#f87171', // red-400
    calm: '#86efac', // green-400
    excited: '#f472b6', // pink-400

    // Music/energy descriptors
    aggressive: '#ef4444', // red-500
    energetic: '#fbbf24', // amber-400
    mellow: '#a78bfa', // purple-400
    melancholic: '#38bdf8', // cyan-400
    uplifting: '#4ade80', // green-500

    // Additional moods
    dark: '#9333ea', // purple-600
    romantic: '#f43f5e', // rose-500
    party: '#ec4899', // pink-500
    chill: '#06b6d4', // cyan-500
};

/**
 * Energy gradient — 10-stop gradient from cool (low energy) to hot (high energy).
 * Values are equally spaced in [0, 1] and interpolate linearly.
 */
const ENERGY_GRADIENT: string[] = [
    '#38bdf8', // cyan-400 — very calm
    '#60a5fa', // blue-400
    '#818cf8', // indigo-400
    '#a78bfa', // purple-400
    '#c084fc', // purple-500
    '#e879f9', // fuchsia-500
    '#f472b6', // pink-400
    '#f87171', // red-400
    '#fb923c', // orange-400
    '#fbbf24', // amber-400 — maximum energy
];

/**
 * Map a mood tag to a hex color string.
 * Case-insensitive. Unknown moods return MOOD_PALETTE_FALLBACK.
 *
 * @param mood - Mood tag string, e.g. "happy", "aggressive", "sad"
 * @returns Hex color string, e.g. "#f59e0b"
 */
export function moodToColor(mood: string): string {
    if (!mood) return MOOD_PALETTE_FALLBACK;
    const normalized = mood.toLowerCase().trim();
    return MOOD_COLORS[normalized] ?? MOOD_PALETTE_FALLBACK;
}

/**
 * Curated colors for common music genres (the Music Map colours dots by genre,
 * since this library has rich `genre` tags but no essentia mood tags). Anything
 * not listed gets a stable hashed hue from {@link labelToColor} — so the map is
 * always fully coloured, and the frequent genres get hand-picked, legible hues.
 */
const GENRE_COLORS: Record<string, string> = {
    dance: '#ec4899', // pink-500
    'dance & dj': '#ec4899',
    electronic: '#22d3ee', // cyan-400
    house: '#2dd4bf', // teal-400
    techno: '#14b8a6', // teal-500
    trance: '#3b82f6', // blue-500
    'pop trance': '#60a5fa', // blue-400
    hardstyle: '#a855f7', // purple-500
    pop: '#f472b6', // pink-400
    rock: '#f97316', // orange-500
    'heavy metal': '#dc2626', // red-600
    metal: '#ef4444', // red-500
    'power metal': '#fb7185', // rose-400
    'hip hop': '#facc15', // yellow-400
    rap: '#eab308', // yellow-500
    country: '#84cc16', // lime-500
    jazz: '#8b5cf6', // violet-500
    classical: '#cbd5e1', // slate-300
    reggae: '#4ade80', // green-400
    soundtrack: '#94a3b8', // slate-400
};

/**
 * Deterministically map any label (genre or mood) to a hex color.
 *
 * Resolution order: named mood palette → curated genre palette → a stable
 * hashed HSL hue (so every distinct label gets its own consistent colour
 * instead of the grey fallback). Pure + deterministic — same label always
 * yields the same colour across renders and server/client.
 *
 * Used by the Music Map to colour dots by their first genre.
 *
 * @param label - A genre or mood string, e.g. "Trance", "Heavy Metal", "happy"
 * @returns Hex color string.
 */
export function labelToColor(label: string): string {
    if (!label) return MOOD_PALETTE_FALLBACK;
    const normalized = label.toLowerCase().trim();
    const named = MOOD_COLORS[normalized] ?? GENRE_COLORS[normalized];
    if (named) return named;

    // Stable FNV-1a hash → hue. Fixed S/L keeps colours legible on slate-900.
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const hue = Math.abs(hash) % 360;
    return hslToHex(hue, 65, 60);
}

/** Convert HSL (h in [0,360), s/l in [0,100]) to a hex color string. */
function hslToHex(h: number, s: number, l: number): string {
    const sFrac = s / 100;
    const lFrac = l / 100;
    const c = (1 - Math.abs(2 * lFrac - 1)) * sFrac;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lFrac - c / 2;
    const rgb: [number, number, number] =
        h < 60
            ? [c, x, 0]
            : h < 120
              ? [x, c, 0]
              : h < 180
                ? [0, c, x]
                : h < 240
                  ? [0, x, c]
                  : h < 300
                    ? [x, 0, c]
                    : [c, 0, x];
    const [r, g, b] = rgb;
    const toHex = (v: number): string =>
        Math.round((v + m) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Linearly interpolate between two hex colors.
 * @param color1 - Hex color string (e.g. "#ff0000")
 * @param color2 - Hex color string (e.g. "#0000ff")
 * @param t - Interpolation parameter in [0, 1]
 * @returns Interpolated hex color string
 */
function hexLerp(color1: string, color2: string, t: number): string {
    // Parse hex colors
    const r1 = parseInt(color1.slice(1, 3), 16);
    const g1 = parseInt(color1.slice(3, 5), 16);
    const b1 = parseInt(color1.slice(5, 7), 16);

    const r2 = parseInt(color2.slice(1, 3), 16);
    const g2 = parseInt(color2.slice(3, 5), 16);
    const b2 = parseInt(color2.slice(5, 7), 16);

    // Interpolate
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);

    // Convert back to hex
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Map a continuous energy value [0, 1] to a hex color string.
 * Interpolates through a fixed gradient (cool → warm → hot).
 * Values outside [0, 1] are clamped.
 *
 * @param energy - Energy value in [0, 1]
 * @returns Hex color string
 */
export function energyToColor(energy: number): string {
    // Clamp to [0, 1]
    const clamped = Math.max(0, Math.min(1, energy));

    // Map to gradient position
    const position = clamped * (ENERGY_GRADIENT.length - 1);
    const index = Math.floor(position);
    const remainder = position - index;

    // If at the last position, return the last color
    if (index >= ENERGY_GRADIENT.length - 1) {
        return ENERGY_GRADIENT[ENERGY_GRADIENT.length - 1];
    }

    // Interpolate between adjacent gradient stops
    return hexLerp(ENERGY_GRADIENT[index], ENERGY_GRADIENT[index + 1], remainder);
}
