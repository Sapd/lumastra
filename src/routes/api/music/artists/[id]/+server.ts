// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { createArtistDetailHandler } from '$lib/server/api/handlers/music-artist-detail.handler.js';

// authz: user — the authz decision lives in the shared handler
// (createArtistDetailHandler wraps requireAuth(withErrorHandler(...))), not
// in this thin route file. See music-artist-detail.handler.ts for the guard.
export const GET: RequestHandler = createArtistDetailHandler({
    surface: 'internal',
});
