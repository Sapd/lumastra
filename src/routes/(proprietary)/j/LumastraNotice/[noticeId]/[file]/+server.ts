// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { serveStreamLimitClipFile } from '$lib/server/proprietary/jellyfin-compat/stream-limit-notice';

/**
 * The "stream limit reached" clip: MP4, HLS playlist and its segments.
 *
 * No Jellyfin auth on purpose — like the play-token stream paths, players fetch
 * these without auth headers, and the HLS playlist references its segments
 * relatively. The notice id in the path IS the credential: server-minted,
 * 128-bit random, short-lived in Valkey, and it only ever unlocks the same
 * fixed explanation clip.
 */
const handler: RequestHandler = async ({ params, request }) => {
    const res = await serveStreamLimitClipFile(params.noticeId, params.file, request);
    return res ?? ApiResponses.notFound('Media');
};

export const GET = handler;
export const HEAD = handler;
