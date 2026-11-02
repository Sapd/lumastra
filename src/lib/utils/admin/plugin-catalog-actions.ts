// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a plugin-catalog row can offer.
 *
 * Lives outside the component so the version arithmetic is testable — it is
 * exactly the kind of logic that silently does the wrong thing (a lexical
 * compare hides `1.10.0` behind `1.9.0`, and an offered downgrade is a button
 * that anti-rollback will always refuse).
 */

export type CatalogAction = 'install' | 'update' | 'current' | 'unavailable';

export interface CatalogActionInput {
    /** Newest version this host's plugin ABI can install, or null when none can. */
    version: string | null;
    manifestUrl: string | null;
    signature: string | null;
    installedVersion: string | null;
}

/** Strict major.minor.patch compare. Missing components read as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const x = Number.isFinite(pa[i]) ? pa[i] : 0;
        const y = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (x !== y) return x - y;
    }
    return 0;
}

export function catalogAction(entry: CatalogActionInput): CatalogAction {
    // No signature means no verifiable install, so there is nothing to offer —
    // the catalog never gets to route an operator around signature checking.
    if (!entry.version || !entry.manifestUrl || !entry.signature) return 'unavailable';
    if (!entry.installedVersion) return 'install';
    // A catalog BEHIND the installed version is reported as up to date rather
    // than as a downgrade: anti-rollback refuses those, and offering one would
    // be a button that only ever produces an error.
    return compareVersions(entry.version, entry.installedVersion) > 0 ? 'update' : 'current';
}
