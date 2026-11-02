// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Regression: resolveIds' anime pre-filter must NOT reject an item that already
// carries a MAL mapping just because provider_metadata lacks `anime_genres`.
//
// Imported episodes can have a media_external_groupings MAL mapping while
// their series also has a MAL external_ids row, but provider_metadata lacks
// anime_genres. The old filter keyed ONLY on anime_genres, so it dropped the
// episodes before the effective-mapping lookup ran, and the engine drained them
// terminally as "no provider id (gave up)". Having a MAL mapping is a stronger
// anime signal than anime_genres — and it resolves with zero MAL API calls.

const EP_ID = 'a1b2c3d4-0000-4000-8000-000000000011';
const SERIES_ID = 'a1b2c3d4-0000-4000-8000-000000000012';

/**
 * Query router modeling an episode with a synthetic MAL grouping
 * and NO anime_genres anywhere. It answers the anime-filter query faithfully to
 * the SQL it is given — i.e. it only returns the episode if the filter query
 * actually consults MAL mappings (the fix). The buggy filter, which joins only
 * provider_metadata, gets an empty result and bails.
 */
function makeSql() {
    return (strings) => {
        const q = strings.join(' ? ');
        // 1. Anime pre-filter (top of resolveIds).
        if (q.includes('anime_genres')) {
            const consultsMalMapping =
                q.includes('media_external_groupings') || q.includes("provider = 'mal'");
            return Promise.resolve(consultsMalMapping ? [{ query_id: EP_ID }] : []);
        }
        // 2. Effective-mapping lookup (media_external_groupings, admin-override wins).
        if (q.includes('group_external_id') && q.includes('DISTINCT ON (media_id)')) {
            return Promise.resolve([{ group_external_id: '990001' }]);
        }
        // 3. Episode → season → series parent walk.
        if (q.includes('season.season_number') || q.includes('series.title AS series_title')) {
            return Promise.resolve([
                {
                    series_id: SERIES_ID,
                    series_title: 'Cloud Lantern Academy',
                    series_type: 'tv',
                    season_number: 1,
                },
            ]);
        }
        return Promise.resolve([]);
    };
}

// Minimal ctx.http test double: forwards to the (stubbed) global `fetch` so
// the /users/@me auth-probe mock keeps working unchanged — resolveIds' GET
// calls now route through ctx.http.get (C22 fix round 1's ctx.http migration).
const httpMock = {
    get: (url, opts) => fetch(url, { ...opts, method: 'GET' }),
    post: (url, body, opts) =>
        fetch(url, {
            ...opts,
            method: 'POST',
            body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
        }),
};

function makeCtx() {
    return {
        sql: makeSql(),
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        secrets: {},
        userCredentials: {
            listUsersWithKey: async () => ['user-1'],
            get: async (_u, key) =>
                key === 'access_token'
                    ? 'access-tok'
                    : key === 'refresh_token'
                      ? 'refresh-tok'
                      : 'testviewer',
            set: async () => {},
        },
        http: httpMock,
        // initFromCtx() also requires ctx.catalog (always present on a real
        // PluginContext — see resolve-ids-persists-live-search.test.js).
        catalog: { upsertExternalId: async () => {} },
    };
}

describe('mal resolveIds — anime filter keeps MAL-mapped items', () => {
    beforeEach(() => {
        // Auth probe (/users/@me) must succeed so resolveIds reaches per-item work.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: 'x' }) })),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves an episode with a MAL grouping even when anime_genres is absent', async () => {
        const resolved = await plugin.resolveIds(makeCtx(), [
            { mediaId: EP_ID, mediaType: 'episode', title: 'The Lantern Ceremony' },
        ]);
        expect(resolved).toContainEqual({ mediaId: EP_ID, providerId: '990001' });
    });
});
