// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';

test.describe('Radio now-playing API contract', () => {
    async function getStationId(
        request: Parameters<Parameters<typeof test>[2]>[0]['request'],
    ): Promise<string | null> {
        const list = await request.get('/api/admin/radio');
        if (!list.ok()) return null;
        const body = await list.json();
        return body?.data?.stations?.[0]?.id ?? null;
    }

    test('internal /api path returns the structured shape', async ({ request }) => {
        const stationId = await getStationId(request);
        test.skip(!stationId, 'no seeded station');

        const res = await request.get(`/api/music/radio/${stationId}/now-playing`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.success).toBe(true);
        // Fields are spread at top level alongside `success`/`timestamp`,
        // not nested under a `data` key — see ApiResponses.success.
        expect(body).toMatchObject({
            stationId,
            track: expect.any(Object),
            show: expect.any(Object),
            dj: expect.any(Object),
            upNext: expect.any(Object),
        });
        // Legacy flat `nowPlaying` string must NOT be present — callers must
        // consume the structured track/show/dj/upNext fields.
        expect(Object.hasOwn(body, 'nowPlaying')).toBe(false);
    });

    test('/api/v1 path returns the same shape', async ({ request }) => {
        const stationId = await getStationId(request);
        test.skip(!stationId, 'no seeded station');

        const res = await request.get(`/api/v1/music/radio/stations/${stationId}/now-playing`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.stationId).toBe(stationId);
        expect(body).toMatchObject({
            track: expect.any(Object),
            show: expect.any(Object),
            dj: expect.any(Object),
            upNext: expect.any(Object),
        });
    });
});
