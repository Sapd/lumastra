// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI route definitions for miscellaneous endpoints.
 *
 * Covers: active sessions, calendar,
 * auth logout, device heartbeat/actions, Jellyseerr request management,
 * holiday plugin management, and Jellyfin episode lookup.
 */

import { z } from 'zod';
import { requestStatusBodySchema } from '$lib/schemas/request';
import {
    holidayCreateBodySchema,
    holidayUpdateBodySchema,
    holidayReorderBodySchema,
    holidayIdParamsSchema,
} from '$lib/schemas/holidays';
import {
    BEARER_AUTH,
    COMMON_ERRORS,
    COMMON_ERRORS_WITH_404,
    jsonResponse,
    apiErrorResponse,
    type PathsObject,
} from '../helpers';

// Canonical schemas — single source of truth for API responses
import {
    HolidaysListResponseSchema,
    HolidayMutationResponseSchema,
    HolidayReorderResponseSchema,
} from '../../../src/lib/schemas/api-admin-responses';
import {
    CalendarResponseSchema,
    RequestQuotaResponseSchema,
    PendingRequestsResponseSchema,
    RequestStatusResponseSchema,
    SubmitRequestResponseSchema,
} from '../../../src/lib/schemas/api-content-responses';
import {
    SessionsResponseSchema,
    JellyfinEpisodeResponseSchema,
} from '../../../src/lib/schemas/api-playback-responses';
import { CurrentSessionsResponseSchema } from '../../../src/lib/schemas/api-sessions-responses';
import { LogoutResponseSchema } from '../../../src/lib/schemas/api-user-responses';

// ============================================================================
// Request Schemas
// ============================================================================

const calendarQuerySchema = z.object({
    start: z.string().optional().meta({ description: 'Start date (ISO 8601) for calendar range' }),
    end: z.string().optional().meta({ description: 'End date (ISO 8601) for calendar range' }),
});

const createRequestBodySchema = z.object({
    externalIds: z.object({
        tmdb: z.string().optional().meta({ description: 'TMDB ID' }),
        imdb: z.string().optional().meta({ description: 'IMDB ID' }),
    }),
    mediaType: z.enum(['movie', 'tv']).meta({ description: 'Media type for the request' }),
    seasons: z
        .array(z.number())
        .optional()
        .meta({ description: 'Season numbers to request (TV only)' }),
});

const findEpisodeBodySchema = z.object({
    seriesName: z.string().meta({ description: 'Name of the TV series' }),
    season: z.number().meta({ description: 'Season number' }),
    episode: z.number().meta({ description: 'Episode number' }),
});

// ============================================================================
// Route Definitions
// ============================================================================

export const miscRoutes: PathsObject = {
    // ========================================================================
    // Sessions
    // ========================================================================

    '/public-api/sessions': {
        get: {
            tags: ['Sessions'],
            summary: 'Get active streaming sessions',
            description: 'Returns a list of currently active streaming sessions across all users.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(SessionsResponseSchema, 'Active sessions retrieved'),
                ...COMMON_ERRORS,
            },
        },
    },

    '/public-api/sessions/current': {
        get: {
            tags: ['Sessions'],
            summary: "Get current user's active sessions",
            description:
                'Returns active streaming sessions from Jellyfin, AudiobookShelf, and Lumastra sources with signed image URLs. Admins can query other users via username parameter.',
            security: BEARER_AUTH,
            requestParams: {
                query: z.object({
                    username: z.string().optional().meta({
                        description: "Look up another user's sessions (admin only)",
                    }),
                }),
            },
            responses: {
                '200': jsonResponse(CurrentSessionsResponseSchema, 'Current sessions'),
                '403': apiErrorResponse("Only admins can query other users' sessions", 403),
                ...COMMON_ERRORS,
            },
        },
    },

    '/public-api/calendar': {
        get: {
            tags: ['Calendar'],
            summary: 'Get media calendar events',
            description:
                'Returns upcoming media release events (new episodes, movies) within the specified date range. Integrates with Sonarr and Radarr calendars.',
            security: BEARER_AUTH,
            requestParams: {
                query: calendarQuerySchema,
            },
            responses: {
                '200': jsonResponse(CalendarResponseSchema, 'Calendar events retrieved'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Auth
    // ========================================================================

    '/public-api/auth/logout': {
        post: {
            tags: ['Auth'],
            summary: 'Logout current session',
            description: 'Invalidates the current user session and clears authentication state.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(LogoutResponseSchema, 'Successfully logged out'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Request (Jellyseerr)
    // ========================================================================

    '/public-api/request': {
        post: {
            tags: ['Request'],
            summary: 'Create media request',
            description:
                'Creates a new media request via Jellyseerr. Supports movie requests and TV requests with optional season selection.',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': { schema: createRequestBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(SubmitRequestResponseSchema, 'Request created successfully'),
                ...COMMON_ERRORS,
            },
        },
    },

    '/public-api/request/status': {
        post: {
            tags: ['Request'],
            summary: 'Check request status for items',
            description:
                'Checks the current request/availability status for one or more media items (max 20).',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': { schema: requestStatusBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(
                    RequestStatusResponseSchema,
                    'Request statuses for submitted items',
                ),
                ...COMMON_ERRORS,
            },
        },
    },

    '/public-api/request/pending': {
        get: {
            tags: ['Request'],
            summary: 'Get pending requests',
            description: 'Returns all pending media requests for the current user.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(PendingRequestsResponseSchema, 'Pending requests retrieved'),
                ...COMMON_ERRORS,
            },
        },
    },

    '/public-api/request/quota': {
        get: {
            tags: ['Request'],
            summary: 'Get user request quota',
            description:
                "Returns the current user's request quota information, including remaining requests and reset timing.",
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(RequestQuotaResponseSchema, 'Request quota retrieved'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Holidays
    // ========================================================================

    '/api/plugins/holidays': {
        get: {
            tags: ['Holidays'],
            summary: 'List all holidays',
            description: 'Returns all configured holidays and their settings.',
            security: BEARER_AUTH,
            responses: {
                '200': jsonResponse(HolidaysListResponseSchema, 'Holidays retrieved'),
                ...COMMON_ERRORS,
            },
        },
        post: {
            tags: ['Holidays'],
            summary: 'Create a new holiday',
            description: 'Creates a new holiday configuration. The ID is generated server-side.',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': { schema: holidayCreateBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(HolidayMutationResponseSchema, 'Holiday created'),
                ...COMMON_ERRORS,
            },
        },
    },

    '/api/plugins/holidays/{id}': {
        get: {
            tags: ['Holidays'],
            summary: 'Get a holiday by ID',
            description: 'Returns a single holiday configuration by its identifier.',
            security: BEARER_AUTH,
            requestParams: {
                path: holidayIdParamsSchema,
            },
            responses: {
                '200': jsonResponse(HolidayMutationResponseSchema, 'Holiday retrieved'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        put: {
            tags: ['Holidays'],
            summary: 'Update a holiday',
            description: 'Updates an existing holiday configuration. Supports partial updates.',
            security: BEARER_AUTH,
            requestParams: {
                path: holidayIdParamsSchema,
            },
            requestBody: {
                content: {
                    'application/json': { schema: holidayUpdateBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(HolidayMutationResponseSchema, 'Holiday updated'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
        delete: {
            tags: ['Holidays'],
            summary: 'Delete a holiday',
            description: 'Permanently removes a holiday configuration.',
            security: BEARER_AUTH,
            requestParams: {
                path: holidayIdParamsSchema,
            },
            responses: {
                '200': jsonResponse(HolidayMutationResponseSchema, 'Holiday deleted'),
                ...COMMON_ERRORS_WITH_404,
            },
        },
    },

    '/api/plugins/holidays/reorder': {
        post: {
            tags: ['Holidays'],
            summary: 'Reorder holidays',
            description:
                'Sets the display order of holidays by providing an ordered list of holiday IDs.',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': { schema: holidayReorderBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(HolidayReorderResponseSchema, 'Holidays reordered'),
                ...COMMON_ERRORS,
            },
        },
    },

    // ========================================================================
    // Jellyfin Episode Lookup
    // ========================================================================

    '/api/jellyfin/episode': {
        post: {
            tags: ['Jellyfin'],
            summary: 'Find a Jellyfin episode by series/season/episode',
            description:
                'Looks up a specific episode in Jellyfin by series name, season number, and episode number.',
            security: BEARER_AUTH,
            requestBody: {
                content: {
                    'application/json': { schema: findEpisodeBodySchema },
                },
            },
            responses: {
                '200': jsonResponse(JellyfinEpisodeResponseSchema, 'Episode lookup result'),
                ...COMMON_ERRORS,
            },
        },
    },
};
