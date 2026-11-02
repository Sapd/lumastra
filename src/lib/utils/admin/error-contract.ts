// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign — the error contract (spec §7): every operator-facing
 * error is classified into one of four buckets BEFORE it is rendered, so a
 * network blip can never masquerade as "your session expired" and a real
 * auth failure can never masquerade as a shrug-worthy network error.
 *
 * `classifyError` is the single place that decides the class. Components
 * (AsyncSection, DetailPanel — step `shared-components`) render `message` as
 * the "what happened" line and put `detail` behind a "details" disclosure;
 * `retryable` drives whether a retry action is offered.
 */

import * as m from '$lib/paraglide/messages.js';

export type ErrorClass = 'network' | 'auth' | 'server' | 'data';

export interface ClassifiedError {
    class: ErrorClass;
    /** Operator copy: what happened, localized, one sentence. */
    message: string;
    /** Raw error text, for the "details" disclosure only. */
    detail?: string;
    retryable: boolean;
}

function describeErr(err: unknown): string | undefined {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string' && err.length > 0) return err;
    return undefined;
}

function isNetworkError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    // A failed `fetch()` (DNS/CORS/offline) throws a TypeError with no Response.
    if (err instanceof TypeError) return true;
    if (err instanceof Error && /network|failed to fetch|load failed/i.test(err.message)) {
        return true;
    }
    return false;
}

function isDataError(err: unknown): boolean {
    if (err instanceof SyntaxError) return true; // JSON.parse failure
    if (err instanceof Error && err.name === 'ZodError') return true;
    return false;
}

/**
 * Classifies an error for display. `response` — when the caller has one —
 * takes priority over guessing from `err`, since an actual HTTP status is
 * the ground truth.
 *
 * INVARIANT (spec §7: "a failed fetch can never render as 'session
 * expired'"): a genuine network failure never carries a real HTTP status —
 * this app's API client (`$lib/api/client.ts`) reports `status: 0` for
 * network/timeout failures and only ever sets `status` to a real HTTP code
 * once a `Response` was actually received. `status <= 0` is therefore always
 * classified 'network', never 'auth', regardless of `err`'s shape.
 */
export function classifyError(err: unknown, response?: { status: number } | null): ClassifiedError {
    const detail = describeErr(err);

    if (response) {
        if (response.status <= 0) {
            return { class: 'network', message: m.admin_err_network(), detail, retryable: true };
        }
        if (response.status === 401 || response.status === 403) {
            return { class: 'auth', message: m.admin_err_auth(), detail, retryable: false };
        }
        if (response.status >= 500) {
            return { class: 'server', message: m.admin_err_server(), detail, retryable: true };
        }
        if (response.status >= 400) {
            return { class: 'data', message: m.admin_err_data(), detail, retryable: false };
        }
        // 2xx/3xx reaching classifyError means the caller detected a problem
        // downstream of the transport (e.g. schema mismatch) — treat as data.
        return { class: 'data', message: m.admin_err_data(), detail, retryable: false };
    }

    if (isNetworkError(err)) {
        return { class: 'network', message: m.admin_err_network(), detail, retryable: true };
    }
    if (isDataError(err)) {
        return { class: 'data', message: m.admin_err_data(), detail, retryable: false };
    }
    return { class: 'server', message: m.admin_err_server(), detail, retryable: true };
}
