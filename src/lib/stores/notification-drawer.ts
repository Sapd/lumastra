// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notification-drawer.ts — open/closed state for the notification drawer.
 *
 * The drawer used to be owned by `NotificationBell.svelte`, which was fine
 * while the bell was its only opener. It no longer is: on mobile the bell is
 * hidden entirely and the drawer is opened from inside the dock instead (see
 * `docs/architecture/user-events.md`, "Mobile: the bell folds into the dock"),
 * so two unrelated components need to drive one drawer.
 *
 * Lifting the state here rather than passing props through the layout keeps the
 * drawer mounted EXACTLY ONCE (in `+layout.svelte`). Mounting it per-opener
 * would give mobile two live drawers — two focus traps, two scroll locks, two
 * copies of the same list — which is the failure mode this indirection buys us
 * out of.
 */

import { writable, type Readable } from 'svelte/store';

const _open = writable(false);

/** True while the drawer is on screen. */
export const notificationDrawerOpen: Readable<boolean> = _open;

export function openNotificationDrawer(): void {
    _open.set(true);
}

export function closeNotificationDrawer(): void {
    _open.set(false);
}

export function toggleNotificationDrawer(): void {
    _open.update((v) => !v);
}
