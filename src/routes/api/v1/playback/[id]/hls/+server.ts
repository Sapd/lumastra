// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/playback/{id}/hls
 *
 * HLS master playlist. Re-exports from the internal pipeline handler.
 * Segment URLs in the generated playlist reference /api/v1/playback/{id}/hls/{...path}.
 */

export { GET, OPTIONS } from '../../../../../api/playback/[itemId]/hls/+server.js';
