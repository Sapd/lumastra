// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turn an ApiResult's `error` + `details` into one human-readable string.
 *
 * WHY THIS EXISTS
 * ---------------
 * `mount()` rejects a bad request body with a 422 whose problem+json body
 * carries precise field-level reasons:
 *
 *   {"code":"validation_failed","error":"Request validation failed",
 *    "details":[{"field":"body.max_concurrent_streams",
 *                "message":"Too big: expected number to be <=20"}]}
 *
 * `parseErrorResponse` already surfaces `details` on the ApiResult, but callers
 * habitually toast only `error` — so a fixable input mistake ("you typed 100,
 * max is 20") reaches the user as the opaque "Request validation failed" and
 * looks like a server fault. Pass both through here instead.
 *
 * `details` is typed `unknown` because problem+json also uses that slot for
 * quota objects and bare strings; anything that is not a ValidationDetail[]
 * is ignored and the bare message is returned.
 */

/** Mirror of the server's `ValidationDetail` (src/lib/server/api/problem.ts). */
interface ValidationDetailLike {
    field: string;
    message: string;
}

function isValidationDetail(value: unknown): value is ValidationDetailLike {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.field === 'string' && typeof record.message === 'string';
}

/**
 * `body.max_concurrent_streams` → `max concurrent streams`.
 *
 * Drops the slot prefix (`body.` / `query.` / `params.`), which is an internal
 * detail of where the value was read from, and de-snake-cases the rest so the
 * label matches the form field the user is looking at.
 */
function humanizeField(field: string): string {
    const withoutSlot = field.replace(/^(body|query|params)\./, '');
    return withoutSlot.replace(/_/g, ' ');
}

/**
 * Compose `error` and any field-level `details` into a single toast-ready line.
 *
 * @param message - the ApiResult `error` string (already human-readable)
 * @param details - the ApiResult `details` payload, whatever shape it arrived in
 */
export function formatApiError(message: string, details: unknown): string {
    if (!Array.isArray(details)) return message;

    const parts = details
        .filter(isValidationDetail)
        .map((detail) => `${humanizeField(detail.field)}: ${detail.message}`);

    if (parts.length === 0) return message;

    return `${message} — ${parts.join('; ')}`;
}
