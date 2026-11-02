// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface Reorderable {
    id: string;
}

function swap<T>(arr: T[], i: number, j: number): T[] {
    const out = [...arr];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
}

/** Move the item with `id` one slot earlier. No-op (fresh copy) at the top. */
export function moveUp<T extends Reorderable>(items: T[], id: string): T[] {
    const idx = items.findIndex((i) => i.id === id);
    if (idx <= 0) return [...items];
    return swap(items, idx, idx - 1);
}

/** Move the item with `id` one slot later. No-op (fresh copy) at the bottom. */
export function moveDown<T extends Reorderable>(items: T[], id: string): T[] {
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1 || idx >= items.length - 1) return [...items];
    return swap(items, idx, idx + 1);
}
