// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { collectionsUnsupportedResponse } from '$lib/server/jellyfin-compat/collections';

/** POST /j/Collections — CreateCollection. Not supported: see collections.ts. */
export const POST: RequestHandler = withJellyfinAuth(async () => collectionsUnsupportedResponse(), {
    mode: 'write',
});
