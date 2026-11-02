// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media metadata sync (single item) — `syncMediaMetadata()` only.
 *
 * Split out of `$lib/api/admin` (2026-09-25, fix round 1) so
 * `$lib/utils/media-context-actions` — reached from every rail page via
 * `UniversalMediaCard.svelte` (`/`, `/browse`, ...) — doesn't have to pull in
 * the whole admin API client module just for its "resync metadata" media
 * action. `SyncResponseSchema` already lived in the dependency-light
 * `$lib/schemas/metadata-sync` (imports only `zod`), so this is a pure move
 * of the function only. Re-exported from `$lib/api/admin` so other importers
 * (admin-only `EpisodesTab.svelte`, `SyncTab.svelte`,
 * `routes/admin/library/media/+page.svelte`) keep working.
 */

import { apiPost } from './client.js';
import { SyncResponseSchema } from '$lib/schemas/metadata-sync.js';

/** Trigger a metadata sync from provider (single item) */
export function syncMediaMetadata(mediaId: string, includeChildren?: boolean) {
    return apiPost(`/api/admin/media/${mediaId}/sync`, SyncResponseSchema, {
        includeChildren: includeChildren ?? false,
    });
}
