// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** An exclusive end may only preview a frame strictly inside its segment. */
export function previewFrame(
    at: number,
    interval: number,
    count: number,
    direction: 'nearest' | 'before' = 'nearest',
): number {
    const index = direction === 'before' ? Math.ceil(at / interval) - 1 : Math.round(at / interval);
    return Math.min(count - 1, Math.max(0, index));
}
