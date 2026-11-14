// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Trailers (TrailersController.GetTrailers): the local trailers of every movie and
// series the user can see, as a paged BaseItemDtoQueryResult.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleTrailers } from '$lib/server/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth(handleTrailers);
