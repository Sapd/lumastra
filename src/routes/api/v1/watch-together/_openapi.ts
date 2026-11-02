// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI metadata for /api/v1/watch-together.
 *
 * See the sibling note in /api/v1/playlists/[id]/_openapi.ts: this route stopped
 * being a re-export of the internal handlers (which made it run with the wrong
 * surface), and the spec generator had been resolving its metadata through that
 * re-export. Both surfaces mount the SAME def, so the contract is identical.
 */
export * from '../../watch-together/_openapi.js';
