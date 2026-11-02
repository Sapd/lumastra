// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tracks which single list row has its swipe-to-reveal action tray pinned
 * open (e.g. the music queue). Opening a row auto-closes any other.
 */

let openId = $state<string | null>(null);

export const openSwipeRow = {
    isOpen(id: string): boolean {
        return openId === id;
    },
    open(id: string): void {
        openId = id;
    },
    close(id?: string): void {
        if (id === undefined || openId === id) openId = null;
    },
};
