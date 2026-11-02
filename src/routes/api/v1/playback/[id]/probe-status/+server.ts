// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Keyframe Probe Status
 *
 * GET /api/v1/playback/{itemId}/probe-status
 *
 * Reports whether the server is currently probing keyframes for this item.
 * 3rd-party players poll this during initial loading so they can show an
 * "Analyzing video structure…" state while the master m3u8 fetch blocks on
 * on-demand keyframe probing.
 *
 * Requires: Bearer token authentication
 */
export * from '../../../../../api/playback/[itemId]/probe-status/+server.js';
