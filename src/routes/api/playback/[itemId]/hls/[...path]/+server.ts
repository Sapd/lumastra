// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Route: Lumastra HLS Segment Serving
 *
 * This route mirrors the /api/v1 endpoint for segment serving.
 * Used when clients access via forward auth headers (X-Forwarded-User).
 */

export { GET, OPTIONS } from '../../../../v1/playback/[id]/hls/[...path]/+server.js';
