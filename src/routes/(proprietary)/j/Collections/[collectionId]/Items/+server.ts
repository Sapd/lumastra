// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { collectionsUnsupportedResponse } from '$lib/server/proprietary/jellyfin-compat/collections';

/** POST /j/Collections/{collectionId}/Items — AddToCollection. Not supported: see collections.ts. */
export const POST: RequestHandler = withJellyfinAuth(async () => collectionsUnsupportedResponse(), {
    mode: 'write',
});

/** DELETE /j/Collections/{collectionId}/Items — RemoveFromCollection. Not supported. */
export const DELETE: RequestHandler = withJellyfinAuth(
    async () => collectionsUnsupportedResponse(),
    { mode: 'write' },
);
