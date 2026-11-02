// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Recovery policy for expiring playback delivery grants. */

/** Default spacing between two failure-driven re-mints. */
export const STREAM_TOKEN_RECOVERY_COOLDOWN_MS = 60_000;

/**
 * `expires_at` as epoch ms. The playback endpoint documents an ISO string but
 * its schema also admits a number; a number below 1e12 is epoch SECONDS.
 * Returns null when absent or unparseable (treated as "no known expiry").
 */
export function parseStreamTokenExpiry(value: string | number | null | undefined): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value !== '') {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }
    return null;
}

/** A token is usable when present and not past its known absolute expiry. */
export function isStreamTokenUsable(
    token: string | null,
    expiresAtMs: number | null,
    now: number = Date.now(),
): boolean {
    if (!token) return false;
    return expiresAtMs === null || now < expiresAtMs;
}

/** Limit failure-driven playback-session restarts to one per cooldown. */
export class StreamTokenRecoveryGate {
    private lastAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly cooldownMs: number = STREAM_TOKEN_RECOVERY_COOLDOWN_MS) {}

    /** True (and arms the cooldown) when a recovery may run now. */
    tryAcquire(now: number = Date.now()): boolean {
        if (now - this.lastAt < this.cooldownMs) return false;
        this.lastAt = now;
        return true;
    }

    /** Test/reset hook: forget the last recovery. */
    reset(): void {
        this.lastAt = Number.NEGATIVE_INFINITY;
    }
}

/** The `grant` query parameter of a (possibly relative) URL, or null. */
export function streamTokenOf(src: string): string | null {
    if (!src) return null;
    try {
        return new URL(src, 'http://local').searchParams.get('grant');
    } catch {
        return null;
    }
}
