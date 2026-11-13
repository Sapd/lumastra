// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET|HEAD /Artists/{name}/Images/{imageType} — an artist's image, by artist name.
// Authenticated, unlike /Items/{id}/Images — see jellyfin-compat/name-images.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveArtistImage } from '$lib/server/proprietary/jellyfin-compat/name-images';

export const GET: RequestHandler = withJellyfinAuth((event) => serveArtistImage(event));
