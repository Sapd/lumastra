// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood Shelf Rotation
 *
 * Deterministically picks a subset of mood chips to render as rotating
 * "mood shelf" carousels on /music, seeded by (date, user) so the same user
 * sees the same picks all day and a new day rotates the selection.
 *
 * @module services/music/mood-rotation
 */

import type { MoodChip } from '$lib/constants/music-moods.js';

/**
 * FNV-1a 32-bit string hash — turns the date+user key into a stable seed so
 * the same user gets the same mood picks for the same day.
 */
function hashSeed(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Default RNG: mulberry32. Tiny, fast, deterministic for a given seed —
 * mirrors the RNG used by the genre plan (see genre-plan.service.ts).
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deterministically pick `count` distinct mood chips for a given (dateKey,
 * userId) pair. Same inputs always produce the same picks; a different
 * dateKey (or userId) can produce a different selection. Returns fewer than
 * `count` entries only when `moods` itself has fewer entries.
 */
export function pickDailyMoodShelves(
    moods: readonly MoodChip[],
    dateKey: string,
    userId: string,
    count: number,
): MoodChip[] {
    if (moods.length === 0 || count <= 0) return [];

    const rng = mulberry32(hashSeed(`${dateKey}:${userId}`));
    const pool = [...moods];
    const picked: MoodChip[] = [];
    const take = Math.min(count, pool.length);

    for (let i = 0; i < take; i++) {
        const idx = Math.floor(rng() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
    }

    return picked;
}
