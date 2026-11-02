// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/playback/[itemId]/subtitles/[index]
 *
 * The timeline descriptors (`info.subtitles[].hrefs`) emit this path on the
 * internal surface (`apiUrl('internal', '/playback/{id}/subtitles/{index}')`),
 * the same shape as the v1 surface and as `.../subtitles/external/[subtitleId]`.
 * Only the older `/api/playback/subtitles/[itemId]/[index]` existed, so every
 * web subtitle fetch (embedded and sidecar, index >= 1000) returned the SvelteKit
 * 404 page. Same handler, same params (`itemId`, `index`); the old path stays for
 * clients that still call it.
 */
export * from '../../../subtitles/[itemId]/[index]/+server.js';
