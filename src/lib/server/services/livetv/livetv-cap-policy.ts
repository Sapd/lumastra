// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';

export type LiveTvCapFallback = 'refuse' | 'source';

/**
 * Operator policy for a quality ceiling the server cannot produce.
 *
 * Reads through `config` rather than `process.env` directly so the value honours
 * settings.json (and therefore the admin Settings UI) exactly like every other
 * Live TV key. Reading env here made the setting invisible to operators, which is
 * how a `refuse` default could take Live TV down with no way to turn it back on.
 * Unknown values fall back to the schema default inside `config`.
 */
export function getLiveTvCapFallback(): LiveTvCapFallback {
    return config.LIVETV_CAP_FALLBACK;
}
