// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch State'],
        summary: 'Set my progress through a series',
        description:
            "Marks every episode <= `throughEpisodeId` as watched and every episode > as unwatched, in one transaction. Uses the effective custom-ordering numbers so a re-ordered series splits at the user-visible boundary. Owns the manual-correction path that no upstream sync can fix — Lumastra's view diverging from the user's mental model.",
        responses: {
            200: 'Progress updated',
            400: 'Bad request (missing series id, through-episode not in series, etc.)',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
