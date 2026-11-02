// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The confidence badge on an EPG match review row.
 *
 * A module rather than a `const` in EPGMatchReview.svelte because nothing in
 * this repo type-checks a lookup map written inside a component: `npm run
 * typecheck` runs tsgo, which does not read `.svelte` at all, and `npm run
 * check` (svelte-check-native) was MEASURED on 2026-08-27 not to flag a renamed
 * key in a component-local `Record<Union, …>` either.
 *
 * `EpgMatchConfidenceLevelSchema` lives in `$lib/schemas/livetv.ts`, and the
 * badge record lived in the component. The row calls
 * `config[channel.confidenceLevel].label()` directly, so a level added to the
 * schema would not have produced an unlabelled badge — it would have thrown out
 * of the render and taken the match review list with it, which is the only
 * surface an operator has for correcting EPG matches.
 */

import * as m from '$lib/paraglide/messages.js';
import type { EpgMatchConfidenceLevel } from '$lib/schemas/livetv.js';

export interface EpgConfidenceBadge {
    color: string;
    label: string;
}

/**
 * Exhaustive over `EpgMatchConfidenceLevel` — a missing case fails the declared
 * return type under tsgo, a stale case fails as not comparable. No `default`
 * arm: a fallback badge would claim a confidence the matcher never reported.
 */
export function epgConfidenceBadge(level: EpgMatchConfidenceLevel): EpgConfidenceBadge {
    switch (level) {
        case 'high':
            return {
                color: 'bg-green-900/50 text-green-300 border-green-700/50',
                label: m.admin_livetv_epg_confidence_high(),
            };
        case 'medium':
            return {
                color: 'bg-amber-900/50 text-amber-300 border-amber-700/50',
                label: m.admin_livetv_epg_confidence_medium(),
            };
        case 'low':
            return {
                color: 'bg-red-900/50 text-red-300 border-red-700/50',
                label: m.admin_livetv_epg_confidence_low(),
            };
        case 'unmatched':
            return {
                color: 'bg-surface-700/50 text-surface-400 border-surface-600/50',
                label: m.admin_livetv_epg_unmatched(),
            };
        case 'manual':
            return {
                color: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
                label: m.admin_livetv_epg_confidence_manual(),
            };
        case 'stale':
            return {
                color: 'bg-orange-900/50 text-orange-300 border-orange-700/50',
                label: m.admin_livetv_epg_confidence_stale(),
            };
    }
}
