// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client-side calendar contract (`api-content-responses.ts`) is what
 * `apiGet('/api/calendar', CalendarResponseSchema)` validates against, and a
 * `z.object` STRIPS undeclared keys. So a field the server emits but this
 * schema omits is silently deleted before any component sees it — the failure
 * mode is an absent value, never an error.
 *
 * These tests pin that both halves of the series-identifier split survive the
 * parse: the honest `seriesMediaId` and its legacy `sonarrSeriesId` alias.
 */

import { describe, it, expect } from 'vitest';
import { CalendarItemSchema } from './api-content-responses';

const SERIES_UUID = '974d7f8d-cacb-4cfb-b9c9-243d92a2b9e0';

describe('CalendarItemSchema — series identifier fields survive parsing', () => {
    it('keeps seriesMediaId instead of stripping it', () => {
        const parsed = CalendarItemSchema.parse({
            title: 'Cold Harbor',
            seriesMediaId: SERIES_UUID,
        });

        expect(parsed.seriesMediaId).toBe(SERIES_UUID);
    });

    it('keeps the legacy sonarrSeriesId alias as a string', () => {
        const parsed = CalendarItemSchema.parse({
            title: 'Cold Harbor',
            seriesMediaId: SERIES_UUID,
            sonarrSeriesId: SERIES_UUID,
        });

        expect(parsed.sonarrSeriesId).toBe(SERIES_UUID);
        expect(parsed.seriesMediaId).toBe(parsed.sonarrSeriesId);
    });

    it('still strips a field it does not declare', () => {
        // Guards the guard: proves the two assertions above are load-bearing
        // and not just "z.object passes everything through".
        const parsed = CalendarItemSchema.parse({
            title: 'Cold Harbor',
            definitelyNotDeclared: SERIES_UUID,
        });

        expect(parsed).not.toHaveProperty('definitelyNotDeclared');
    });
});
