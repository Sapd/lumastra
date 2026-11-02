// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for the "why can't this user see this item?" explainer.
 *
 * ## Why a per-gate verdict and not a boolean
 *
 * `checkMediaAccess` already answers yes/no correctly. What it cannot do is say
 * WHICH gate decided, and that is the entire content of the support thread: "it
 * is there, I can see it, they cannot". An operator handed `false` learns
 * nothing they did not already know.
 *
 * So every gate reports its own verdict WITH the values that produced it — the
 * denied group ids, the item's rating against the user's ceiling, whether the
 * item has files at all. Same principle as recording `decidedBy` on a stage
 * failure rather than collapsing it to `retryable`.
 *
 * ## Gate order mirrors `checkMediaAccess` exactly
 *
 * The gates are evaluated and reported in the order the real code applies them,
 * and `blockedBy` names the FIRST that failed. An explainer that agreed on the
 * answer but disagreed on the reason would be worse than none: the operator
 * would fix the wrong thing and the item would stay invisible.
 *
 * ## `has-files` is reported even though it is not an access gate
 *
 * A discovery-only row is visible on discovery surfaces and never on `/browse`,
 * which is always library-local. That is not a permission problem and no access
 * check will ever mention it — but it is a very common reason one person sees a
 * title and another does not, so it is reported as its own gate rather than
 * left for the operator to rediscover.
 */

import { z } from 'zod';

export const VisibilityGateSchema = z.object({
    /** Stable id for the gate, so the page can order and label without parsing prose. */
    gate: z.enum([
        'item-exists',
        'has-files',
        /** The account is neither disabled nor deleted — otherwise it signs in to nothing. */
        'account',
        'admin-bypass',
        'library-access',
        'age-rating',
    ]),
    /** Whether this gate ALLOWS the user through. */
    passed: z.boolean(),
    /**
     * Whether this gate was actually evaluated. A gate skipped because an
     * earlier one short-circuited must not be reported as "passed" — that would
     * claim a check nobody ran.
     */
    evaluated: z.boolean(),
    /**
     * Which explanation applies, rendered by the page in the user's language
     * with `params`. Codes the page does not know fall back to `detail`.
     */
    code: z.string(),
    /** Values for the explanation (rating, ceiling, group ids, ...). */
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    /** The same explanation in English: fallback for unknown codes, and for logs. */
    detail: z.string(),
});
export type VisibilityGate = z.infer<typeof VisibilityGateSchema>;

export const VisibilityCheckSchema = z.object({
    generatedAt: z.string(),

    userId: z.string(),
    username: z.string(),
    userIsAdmin: z.boolean(),
    /** Null when the user has no age ceiling configured. */
    userMaxAgeRating: z.number().nullable(),
    /** Identity-provider groups this user carries, which drive library grants. */
    userGroups: z.array(z.string()),

    mediaId: z.string(),
    mediaTitle: z.string(),
    mediaType: z.string(),

    /** The end result: can this user reach this item. */
    visible: z.boolean(),
    /**
     * Whether Browse lists it: active and file-backed, by the same filter
     * Browse uses. `visible` without `browsable` is the discovery-only case —
     * reachable from search or a link, never in the library grid.
     */
    browsable: z.boolean(),
    /**
     * The first gate that blocked, or null when visible. Named rather than
     * inferred by the page, so the API and the UI cannot disagree about why.
     */
    blockedBy: z.string().nullable(),

    /** Every gate, in the order `checkMediaAccess` applies them. */
    gates: z.array(VisibilityGateSchema),
});
export type VisibilityCheck = z.infer<typeof VisibilityCheckSchema>;
