// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deterministic 32-bit string hash (FNV-1a).
 *
 * Pure and dependency-free, so it is safe in BOTH the browser and on the
 * server. Lives in `shared/` (not `server/`) because hero rotation needs the
 * same seed on the SSR path and the client so their first render agrees.
 */
export function hashSeed(input: string): number {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619); // FNV prime
    }
    return hash >>> 0; // Force unsigned 32-bit
}
