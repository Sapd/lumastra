// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The season number a season download button may pass to the queue: a non-negative
 * integer, else undefined (the button is then hidden). A missing or fractional index
 * must never turn into season 0 ("Specials") or NaN.
 */
export function downloadSeasonNumber(...candidates: unknown[]): number | undefined {
    for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const n = typeof c === 'number' ? c : Number.NaN;
        return Number.isInteger(n) && n >= 0 ? n : undefined;
    }
    return undefined;
}
