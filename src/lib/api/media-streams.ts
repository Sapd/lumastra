// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin media streams read — `getMediaStreams()` only.
 *
 * Split out of `$lib/api/admin` (2026-09-25, fix round 1) so
 * `MediaFileInfoModal.svelte` — reached from every rail page via
 * `StandardSection.svelte` (`/`, `/browse`, ...) — doesn't have to pull in
 * the whole admin API client module just to show a media item's stream
 * list. Re-exported from `$lib/api/admin` so other importers (e.g. the
 * admin-only `FilesTab.svelte`) keep working.
 */

import { apiGet } from './client.js';
import { StreamsResponseSchema } from '$lib/schemas/api-admin-media-streams.js';

export function getMediaStreams(mediaId: string, fileId?: string | null) {
    const params = fileId ? `?fileId=${fileId}` : '';
    return apiGet(`/api/admin/media/${mediaId}/streams${params}`, StreamsResponseSchema);
}
