// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: per-chapter thumbnail.
 * GET /api/v1/playback/{id}/chapter-image/{index}
 * Re-exports the internal playback chapter-image route.
 */
export * from '../../../../../../api/playback/[itemId]/chapter-image/[index]/+server.js';
