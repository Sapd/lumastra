// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two confidence tiers of episode-title reconciliation, shared by the
 * reconcile endpoint and the health tab so the numbers cannot drift apart.
 *
 * - Preview: matches at or above this are listed as "will change". The
 *   operator can apply any of them by selecting rows ("Apply selected").
 * - Auto-apply: the bulk "Apply high-confidence" button applies only matches
 *   at or above this, a safe subset of what the preview lists.
 */
export const RECONCILE_PREVIEW_CONFIDENCE = 0.8;
export const RECONCILE_AUTO_APPLY_CONFIDENCE = 0.9;
