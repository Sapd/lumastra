// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Movies/Recommendations (MoviesController.GetMovieRecommendations): rows like
// "Because you watched X", "Because you like Y", "Directed by Z", "Starring W".
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleMovieRecommendations } from '$lib/server/jellyfin-compat/movie-recommendations';

export const GET: RequestHandler = withJellyfinAuth(handleMovieRecommendations);
