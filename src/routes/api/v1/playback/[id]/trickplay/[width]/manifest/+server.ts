// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Trickplay Manifest
 *
 * GET /api/v1/playback/[itemId]/trickplay/[width]/manifest
 *
 * Re-exports from the internal API which uses DB-first local trickplay storage.
 */
export * from '../../../../../../../api/playback/[itemId]/trickplay/[width]/manifest/+server.js';
