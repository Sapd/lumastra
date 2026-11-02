// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { EndpointRateLimit } from '$lib/server/api/define.js';

/** One per-user regeneration budget across actions and API surfaces (AI: 30/minute). */
export const refreshRateLimit: EndpointRateLimit = {
    limit: 30,
    windowSec: 60,
    keyBy: (event) =>
        `recommendations-refresh:${event.locals.principal?.userId ?? event.locals.user?.userId ?? 'anonymous'}`,
};
