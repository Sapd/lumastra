// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Derive the same admin-display source for discovery and reclaimed params. */
export function providerIdToSource(providerId: string): string {
    if (providerId === 'local-trickplay') return 'local';
    if (providerId === 'jellyfin-disk-trickplay') return 'jellyfin-disk';
    return providerId;
}
