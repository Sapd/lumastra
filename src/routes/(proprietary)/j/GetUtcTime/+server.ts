// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /GetUtcTime (Jellyfin TimeSyncController) — the server clock, for
 * SyncPlay time sync and clients that check clock skew. Anonymous, as in
 * Jellyfin. The reception time is taken before anything else runs so the
 * client can subtract the server's own processing time.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { JellyfinUtcTimeResponse } from '$lib/server/proprietary/jellyfin-compat/types';

export const GET: RequestHandler = () => {
    const RequestReceptionTime = new Date().toISOString();
    const body: JellyfinUtcTimeResponse = {
        RequestReceptionTime,
        ResponseTransmissionTime: new Date().toISOString(),
    };
    return json(body, { headers: { 'Cache-Control': 'no-store' } });
};
