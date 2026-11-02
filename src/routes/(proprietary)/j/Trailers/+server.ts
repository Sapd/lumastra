// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Trailers (TrailersController.GetTrailers): the local trailers of every movie and
// series the user can see, as a paged BaseItemDtoQueryResult.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleTrailers } from '$lib/server/proprietary/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth(handleTrailers);
