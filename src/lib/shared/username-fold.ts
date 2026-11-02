// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical key for cross-system username matching.
 *
 * NFC normalization is required before case folding: composed and decomposed
 * Unicode names render identically and must collide rather than being assigned
 * independently to one upstream account.
 */
export function foldUsername(username: string): string {
    return username.normalize('NFC').trim().toLowerCase();
}
