// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';

/** One snapshot for all three sharing dimensions; sharing is on unless disabled. */
export function defaultActivitySharing(): boolean {
    return config.DEFAULT_ACTIVITY_SHARING !== false;
}
