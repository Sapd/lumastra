// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `[1, 2, 3, 5, 7, 8]` → `"1–3, 5, 7–8"`, each bound passed through `fmt`.
 * Input order and duplicates do not matter.
 */
export function formatNumberRanges(nums: number[], fmt: (n: number) => string = String): string {
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        parts.push(i === j ? fmt(sorted[i]) : `${fmt(sorted[i])}–${fmt(sorted[j])}`);
        i = j + 1;
    }
    return parts.join(', ');
}
