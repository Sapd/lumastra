// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET|HEAD /MusicGenres/{name}/Images/{imageType}/{imageIndex} — a music genre's image.
// Authenticated, unlike /Items/{id}/Images — see jellyfin-compat/name-images.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { serveMusicGenreImage } from '$lib/server/jellyfin-compat/name-images';

export const GET: RequestHandler = withJellyfinAuth((event) => serveMusicGenreImage(event));
