// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { createAlbumDetailHandler } from '$lib/server/api/handlers/music-album-detail.handler.js';

// authz: user — the authz decision lives in the shared handler
// (createAlbumDetailHandler wraps requireAuth(withErrorHandler(...))), not in
// this thin route file. See music-album-detail.handler.ts for the guard.
export const GET: RequestHandler = createAlbumDetailHandler({
    surface: 'internal',
});
