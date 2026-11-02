// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `UpcomingCalendarItem` is the v1 shape for `GET /api/v1/upcoming?view=calendar`,
 * which delegates to THIS app's own calendar — not to a live Sonarr instance.
 * That delegate sets the series id from `item.series_id`, a `media_items` UUID.
 *
 * The schema declared `sonarrSeriesId: z.number()` until 2026-08-27. It never
 * produced a conformance error because no v1 client calls that view, and nothing
 * type-checked the consumers because they live in `.svelte` files. So the wrong
 * declaration reached the published OpenAPI spec — and the spec is what generates
 * the strict Swift client.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE: that the published `docs/api/*.yaml` matches. That
 * needs `openapi:generate`, which reads the working tree and is blocked while a
 * peer's endpoint block sits uncommitted in `api-v1.yaml`.
 */
import { describe, it, expect } from 'vitest';
import { UpcomingCalendarItemSchema } from './api-recommender-responses.js';

const SERIES_UUID = '974d7f8d-cacb-4cfb-b9c9-243d92a2b9e0';

/** The schema's required fields, so a fixture failure cannot masquerade as the assertion. */
const BASE = {
    id: SERIES_UUID,
    catalogId: null,
    title: 'Iruma-kun',
    type: 'episode',
    ids: {},
    images: {},
    monitored: true,
    hasFile: false,
};

describe('UpcomingCalendarItem series id', () => {
    it('accepts the UUID string the calendar delegate actually emits', () => {
        const parsed = UpcomingCalendarItemSchema.parse({
            ...BASE,
            context: { series: { id: SERIES_UUID, catalogId: SERIES_UUID, title: 'Iruma-kun' } },
        });
        expect(parsed.context?.series?.id).toBe(SERIES_UUID);
        expect(parsed).not.toHaveProperty('sonarrSeriesId');
        expect(parsed).not.toHaveProperty('seriesMediaId');
    });

    it('accepts a Sonarr/Radarr-only row, which canonicalizeCalendarRow emits with a discovery series handle', async () => {
        const { canonicalizeCalendarRow } =
            await import('$lib/server/api/defs/recommendations/calendar-delegate.js');
        const row = canonicalizeCalendarRow({
            id: null,
            title: 'Lantern Ward',
            media_type: 'episode',
            series_name: 'Lantern Ward',
            series_id: null,
            season_number: 1,
            episode_number: 2,
            premiere_date: '2026-10-14',
            has_files: false,
            overview: null,
            year: 2026,
            source: 'monitored',
            source_series_id: 77,
            tmdb_id: 880004,
        } as unknown as Parameters<typeof canonicalizeCalendarRow>[0]);
        expect(row?.id).toBe('tmdb:880004:series');
        const parsed = UpcomingCalendarItemSchema.safeParse(row);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it('rejects a number, which is what the declaration used to require', () => {
        const result = UpcomingCalendarItemSchema.safeParse({
            ...BASE,
            context: { series: { id: 12345, catalogId: null, title: 'Iruma-kun' } },
        });
        expect(result.success, 'a numeric series id must not parse — that was the old lie').toBe(
            false,
        );
    });
});
