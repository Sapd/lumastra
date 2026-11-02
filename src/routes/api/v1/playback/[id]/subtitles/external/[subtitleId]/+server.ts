// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: External Subtitle Delivery
 *
 * Re-exports the internal external subtitle endpoint for 3rd party clients.
 * Accepts the item/session-bound grant query parameter for media auth (e.g. tvOS AVPlayer).
 */
export * from '../../../../../../../api/playback/[itemId]/subtitles/external/[subtitleId]/+server.js';
