// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getParam } from '$lib/server/jellyfin-compat/utils';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const rawSize = parseInt(getParam(event.url, 'Size') ?? '102400', 10);
    const size = isNaN(rawSize) || rawSize < 0 ? 102400 : rawSize;
    const bytes = new Uint8Array(Math.min(size, 1024 * 1024));
    return new Response(bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
    });
});
