// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

const handler: RequestHandler = async () => {
    return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = withJellyfinAuth(handler, {
    pat: 'deny',
    mode: 'write',
});
