// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { paginatedEnvelope } from '$lib/schemas/pagination.js';
import { UpcomingCalendarItemSchema } from '$lib/schemas/api-recommender-responses.js';
import { canonicalizeCalendarRow, handleCalendarView } from './calendar-delegate.js';

/**
 * defs/recommendations/calendar.ts — GET /api/calendar
 *
 * Returns upcoming releases from Postgres (media_items) for a date range.
 * Episodes and movies whose premiere_date falls within [start, end] are
 * returned. TMDB sync pre-creates episode stubs (has_files=false) for
 * upcoming episodes of tracked series, so the full look-ahead window is
 * already present without live Sonarr/Radarr calls.
 *
 * Caching: global per-range cache keyed by date range; per-user exclusion
 * filter applied post-cache. Access filters (library group + age rating) are
 * folded into the cache key.
 *
 * Query params:
 *   start — ISO 8601 date (defaults to today)
 *   end   — ISO 8601 date (defaults to today)
 *   limit — max items per page (1–500, default 20). The calendar is a bounded
 *           date-range (month) view, so callers request the whole window in one
 *           page rather than paginating.
 *   offset — page offset (default 0)
 *
 * Response: { items: CalendarItem[], page: PageBlock }
 * Errors: problem+json (incl. 503 when the database is unavailable)
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import type { CalendarRow } from '$lib/server/database/queries/calendar.queries.js';

// ---------------------------------------------------------------------------
// Typed item schema — no passthrough/any/unknown
// ---------------------------------------------------------------------------

/** Calendar rows are MediaPreviews, with monitored and hasFile flags. */
const CalendarItemSchema = UpcomingCalendarItemSchema;
export type CalendarItem = z.infer<typeof CalendarItemSchema>;
export type CalendarRawRow = CalendarRow;
export const toCalendarItem = canonicalizeCalendarRow;

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const CalendarQuerySchema = z.object({
    start: z.string().optional(),
    end: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    docs: {
        GET: {
            tags: ['Discovery'],
            summary: 'Calendar of episode and movie previews',
            description:
                'Resolvable handles, ImageSet and typed context.airDate; episode context includes series and coordinates. Rows without a resolvable series are dropped. monitored and hasFile describe library availability.',
            responses: {
                200: {
                    schema: paginatedEnvelope(CalendarItemSchema),
                    description: 'Calendar preview page',
                },
            },
        },
    },
    request: {
        query: CalendarQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => handleCalendarView(event, ctx.surface, 500),
    },
});
