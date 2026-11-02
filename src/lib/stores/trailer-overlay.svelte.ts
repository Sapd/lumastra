// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tracks whether a modal trailer overlay is open, so ambient hover previews
 * (recommendation rails under the modal) don't start and steal the preview
 * budget / evict the trailer session.
 */

let openCount = $state(0);

export const trailerOverlay = {
    get isOpen(): boolean {
        return openCount > 0;
    },
    opened(): void {
        openCount += 1;
    },
    closed(): void {
        openCount = Math.max(0, openCount - 1);
    },
};
