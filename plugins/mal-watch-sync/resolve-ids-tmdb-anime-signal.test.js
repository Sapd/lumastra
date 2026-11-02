// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Regression: resolveIds' anime pre-filter must NOT permanently give up on a
// legitimate anime whose provider_metadata lacks `anime_genres` (written only
// by mdblist-sync) and that has never been resolved by mal-anime-id-enrichment
// or fribb-anime-sync either.
//
// An imported series can be skipped permanently by several enrichment tasks
// when upstream sources have no mapping yet. TMDB metadata can still include
// the curated 'anime' tag, while a live MAL title search can resolve it. The
// old filter had no path from "TMDB says this is anime" to "try MAL search
// anyway", so completed episodes drained as "no provider id (gave up)".
//
// NOTE: index.js caches sql/http/userCredentials/catalog in module-level
// bindings on first initFromCtx() call and never overwrites them — this suite
// deliberately stays to ONE test per file (matching resolve-ids-anime-filter
// .test.js) so a later test's ctx can't silently bind to an earlier test's
// mocks.

const EP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SERIES_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

/**
 * Query router modeling synthetic data: an episode of a series whose only
 * provider_metadata row is 'tmdb' (keywords including 'anime' present, among
 * genres/production_countries also being populated), with NO anime_genres,
 * NO external_ids mal row, and NO media_external_groupings
 * mal row anywhere. It only surfaces the episode from the anime pre-filter when
 * the query actually consults the tmdb provider_metadata row (the fix) — the
 * old filter (anime_genres / mal external_ids / mal groupings only) sees none
 * of these and returns empty, which is exactly the bug being regression-tested.
 */
function makeSql() {
    return (strings) => {
        const q = strings.join(' ? ');

        // 1. Anime pre-filter (top of resolveIds) — only the new TMDB branch
        //    (unique text: `provider = 'tmdb'`) should surface this episode.
        if (q.includes('anime_genres') && q.includes("provider = 'tmdb'")) {
            return Promise.resolve([{ query_id: EP_ID }]);
        }
        if (q.includes('anime_genres')) {
            return Promise.resolve([]);
        }
        // 2. Effective-mapping lookup (media_external_groupings, admin-override).
        if (q.includes('group_external_id') && q.includes('DISTINCT ON (media_id)')) {
            return Promise.resolve([]);
        }
        // 3. Partial-airing watermark guard (series_grouping_state).
        if (q.includes('enriched_episode_count')) {
            return Promise.resolve([]);
        }
        // 4. Episode → season → series parent walk.
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
        // 5. Stored-id fast path (external_ids, provider mal) — nothing yet.
        if (q.includes('external_id') && q.includes('FROM external_ids')) {
            return Promise.resolve([]);
        }
        // 6. Year lookup (premiere_date).
        if (q.includes('premiere_date')) {
            return Promise.resolve([{ premiere_date: '2020-01-01' }]);
        }
        return Promise.resolve([]);
    };
}

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
        catalog: { upsertExternalId: async () => {} },
    };
}

describe('mal resolveIds — TMDB anime signal unblocks a never-enriched series', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                if (String(url).includes('/users/@me')) {
                    return { ok: true, status: 200, json: async () => ({ name: 'x' }) };
                }
                if (String(url).includes('/anime?q=')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            data: [
                                {
                                    node: {
                                        id: 990002,
                                        title: 'Kumo no Gakuen',
                                        alternative_titles: {
                                            en: 'Cloud Lantern Academy',
                                            ja: '雲の学園',
                                            synonyms: [],
                                        },
                                        start_date: '2020-01-01',
                                        media_type: 'tv',
                                        num_episodes: 28,
                                    },
                                },
                            ],
                        }),
                    };
                }
                return { ok: false, status: 404, json: async () => ({}) };
            }),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves an episode via live MAL search once TMDB metadata marks it as anime', async () => {
        const resolved = await plugin.resolveIds(makeCtx(), [
            { mediaId: EP_ID, mediaType: 'episode', title: 'The Lantern Ceremony' },
        ]);
        expect(resolved).toContainEqual({ mediaId: EP_ID, providerId: '990002' });
    });
});
