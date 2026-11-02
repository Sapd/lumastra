// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const QUALITY_TIERS = [50, 70, 85, 95] as const;

export function snapQualityToTier(
    q: number,
    tiers: readonly number[] = QUALITY_TIERS,
    force = false,
): number {
    let best: { tier: number; dist: number } | null = null;
    for (const tier of tiers) {
        const dist = Math.abs(q - tier);
        if (!best || dist < best.dist) best = { tier, dist };
    }
    if (best && (force || best.dist / best.tier <= 0.2)) {
        return best.tier;
    }
    return q;
}
