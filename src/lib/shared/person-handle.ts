// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export type PersonHandleResult =
    | { ok: true; handle: string; numericId: number }
    | { ok: false };

/** Accept bare numeric aliases, but always return the configured provider's canonical handle. */
export function parsePersonHandle(raw: string, primaryProvider = 'tmdb'): PersonHandleResult {
    if (!/^[a-z][a-z0-9_-]*$/.test(primaryProvider)) return { ok: false };
    const digits = raw.startsWith(`${primaryProvider}:`)
        ? raw.slice(primaryProvider.length + 1) : raw;
    if (!/^\d+$/.test(digits)) return { ok: false };
    const numericId = Number(digits);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return { ok: false };
    return { ok: true, handle: `${primaryProvider}:${numericId}`, numericId };
}

export function formatPersonHandle(n: number): string {
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError('Person id must be a positive safe integer');
    return `tmdb:${n}`;
}
