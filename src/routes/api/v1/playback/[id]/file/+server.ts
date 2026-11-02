// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Direct File Playback
 *
 * Re-exports the internal file endpoint for 3rd party clients.
 * Accepts the item/session-bound grant query parameter for media auth (e.g. tvOS AVPlayer).
 */
export * from '../../../../../api/playback/[itemId]/file/+server.js';
