// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Movies/Recommendations (MoviesController.GetMovieRecommendations): rows like
// "Because you watched X", "Because you like Y", "Directed by Z", "Starring W".
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleMovieRecommendations } from '$lib/server/proprietary/jellyfin-compat/movie-recommendations';

export const GET: RequestHandler = withJellyfinAuth(handleMovieRecommendations);
