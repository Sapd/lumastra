// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Sonic Model Constants
 *
 * Single source of truth for the MSCLAP model identifier used across all
 * sonic feature modules (similarity, fingerprint, clustering, map, queue,
 * taste, alchemy, text-sound-search, admin, backfill).
 *
 * @module queries/sonic-constants
 */

/** The only MSCLAP model variant this pipeline supports. */
export const MSCLAP_MODEL_ID = 'msclap-2023' as const;
