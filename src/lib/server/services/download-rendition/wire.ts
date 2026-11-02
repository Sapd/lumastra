// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Row → wire projection for renditions.
 *
 * Lives apart from the def so the list, the create and the status endpoints
 * cannot drift from one another on the one field that matters: `url` is emitted
 * ONLY for a ready rendition. A URL attached to an encoding row would invite a
 * client to start a download against a file that does not exist yet.
 */

import type { Rendition } from '$lib/schemas/api-download-responses.js';
import type { DownloadRenditionRow } from '$lib/server/database/queries/download-renditions.queries.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';

export function renditionToWire(row: DownloadRenditionRow, surface: ApiSurface): Rendition {
    return {
        id: row.id,
        status: row.status,
        progressPct: row.progress_pct,
        rungId: row.rung_id,
        audioIndex: row.audio_index,
        sizeBytes: row.status === 'ready' && row.size_bytes ? Number(row.size_bytes) : undefined,
        url: row.status === 'ready' ? apiUrl(surface, `/renditions/${row.id}/file`) : undefined,
        errorCode: row.error_code ?? undefined,
    };
}
