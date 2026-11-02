// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

/**
 * Process-local memory of metadata-provider credentials the provider has
 * REJECTED (HTTP 401), so a scan over hundreds of files asks once, not once
 * per file.
 *
 * Before this, an invalid TMDB key (the `.env.example` placeholder on a fresh
 * install) made every file's search fail with `TMDB API request failed: 401`
 * plus a full stack trace, and the scan still reported `unmatched: 0,
 * errors: 0` (Windows e2e 2026-09-27, S5).
 *
 * Keyed by a hash of the credential, so saving a new key starts from a clean
 * slate immediately; entries also expire after {@link AUTH_FAILURE_TTL_MS} so a
 * spurious 401 heals on its own.
 */

export const AUTH_FAILURE_TTL_MS = 10 * 60 * 1000;

/** Thrown by a provider when its credential is rejected (HTTP 401/403-invalid-key). */
export class ProviderAuthError extends Error {
    readonly providerId: string;
    readonly status: number | null;

    constructor(providerId: string, message: string, status: number | null = 401) {
        super(message);
        this.name = 'ProviderAuthError';
        this.providerId = providerId;
        this.status = status;
    }
}

export function isProviderAuthError(err: unknown): err is ProviderAuthError {
    if (err instanceof ProviderAuthError) return true;
    // Survives a structured-clone / module-duplication boundary (worker bundle).
    return (
        err instanceof Error &&
        err.name === 'ProviderAuthError' &&
        typeof (err as { providerId?: unknown }).providerId === 'string'
    );
}

const failures = new Map<string, number>();
const lastWarnAt = new Map<string, number>();

function keyOf(providerId: string, credential: string): string {
    const digest = createHash('sha256').update(credential).digest('hex').slice(0, 16);
    return `${providerId}:${digest}`;
}

export function markProviderAuthFailed(
    providerId: string,
    credential: string,
    now: number = Date.now(),
): void {
    failures.set(keyOf(providerId, credential), now);
}

export function isProviderAuthFailed(
    providerId: string,
    credential: string,
    now: number = Date.now(),
): boolean {
    const k = keyOf(providerId, credential);
    const at = failures.get(k);
    if (at === undefined) return false;
    if (now - at > AUTH_FAILURE_TTL_MS) {
        failures.delete(k);
        return false;
    }
    return true;
}

/**
 * True at most once per provider per {@link AUTH_FAILURE_TTL_MS}: callers use it
 * to log a rejected key as ONE clear warning instead of one error per file.
 */
export function shouldWarnProviderAuth(providerId: string, now: number = Date.now()): boolean {
    const at = lastWarnAt.get(providerId);
    if (at !== undefined && now - at < AUTH_FAILURE_TTL_MS) return false;
    lastWarnAt.set(providerId, now);
    return true;
}

/** Test hook. */
export function resetProviderAuthStateForTests(): void {
    failures.clear();
    lastWarnAt.clear();
}
