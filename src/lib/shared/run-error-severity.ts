// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Self-healing failure detector — a known, temporary upstream condition (rate
 * limit, quota) that resolves on its own without operator action. Shared
 * (dependency-free) so both the client-side run-error display
 * (`$lib/utils/admin/run-error-display.ts`) and server-side attention
 * adapters (`$lib/server/services/attention/adapters.ts`) classify the same
 * message text identically without the server importing a client-scoped
 * utils module.
 */
export const EXPECTED_RUN_ERROR_PATTERN =
    /rate limit(ed)?|quota|resumes automatically|retry(-| )after|429/i;

/**
 * Provider rate-limiting detector, for **classification** rather than display.
 *
 * Deliberately NARROWER than {@link EXPECTED_RUN_ERROR_PATTERN}. That pattern
 * decides what colour a badge is, so a false positive costs one mislabelled
 * row. This one decides whether an error is retried, and a false positive
 * there is far worse: a genuine permanent bug would be retried forever while
 * reading as self-healing, which is the exact failure mode the "severity must
 * be earned" rule exists to prevent. Two narrowing choices follow from that:
 *
 *  - **A bare `429` does not match.** It must be an HTTP status (`status=429`,
 *    `HTTP 429`, `code: 429`) or carry its reason phrase (`429 Too Many
 *    Requests`). `mal-anime-id-enrichment` already documents why: `/anime/429`
 *    is a real MyAnimeList id, and a bare `\b429\b` matched it.
 *  - **Bare `quota` does not match.** `EDQUOT` / "disk quota exceeded" is a
 *    real, operator-actionable problem, and silently retrying it would hide a
 *    full disk. The provider-quota messages we actually emit
 *    (`mdblist-sync`, `curated-lists-sync`, `mal-anime-id-enrichment`) all say
 *    "rate limit reached (… quota window resets)" and match on `rate limit`.
 */
export const RATE_LIMIT_ERROR_PATTERN =
    /rate[\s-]?limit(?:ed|ing)?|too many requests|(?:\bhttps?\b|\bstatus(?:\s+code)?\b|\bcode\b)\s*[:=]?\s*\b429\b|retry[\s-]?after/i;
