// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { writable } from 'svelte/store';

/**
 * Which plugin's settings panel is expanded inline under its card (one at a
 * time). Cards toggle it; a `?settings=<id>` deep link sets it.
 */
export const openPluginSettings = writable<string | null>(null);
