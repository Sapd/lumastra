// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why the episode-title reconciler proposed — or declined to propose — a change.
 *
 * A module rather than a `const` in HealthTab.svelte because nothing in this
 * repo type-checks a lookup map written inside a component: `npm run typecheck`
 * runs tsgo, which does not read `.svelte` at all, and `npm run check`
 * (svelte-check-native) was MEASURED on 2026-08-27 not to flag a renamed key in
 * a component-local `Record<Union, …>` either.
 *
 * The reason enum is declared inline in `ReconciliationProposalSchema`
 * (api-admin-responses.ts), which is where a new one would be added, and the
 * label record lived in the component. This is the "needs review" list an
 * operator reads BEFORE applying a batch of title rewrites, and the reason is
 * the only thing on the row that says why the match was rejected — a missing
 * entry rendered `undefined` there, i.e. asked someone to approve a change with
 * the explanation blanked out.
 */

import * as m from '$lib/paraglide/messages.js';
import type { ReconciliationProposal } from '$lib/schemas/api-admin-responses.js';

/**
 * Exhaustive over the proposal reasons — a missing case fails the declared
 * return type under tsgo, a stale case fails as not comparable.
 *
 * `'matched'` returns the empty string on purpose: those rows are listed under
 * "will change", where the proposed title is the explanation and a reason chip
 * beside it would be noise.
 */
export function reconciliationReasonLabel(reason: ReconciliationProposal['reason']): string {
    switch (reason) {
        case 'matched':
            return '';
        case 'no-usable-chapters':
            return m.media_health_reason_no_usable_chapters();
        case 'chapter-count-mismatch':
            return m.media_health_reason_chapter_count_mismatch();
        case 'below-threshold':
            return m.media_health_reason_below_threshold();
        case 'duplicate-match':
            return m.media_health_reason_duplicate_match();
        case 'manually-locked':
            return m.media_health_reason_manually_locked();
        case 'identity-bound':
            return m.media_health_reason_identity_bound();
    }
}
