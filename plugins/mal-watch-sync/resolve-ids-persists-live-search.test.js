// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Companion to resolve-ids-tmdb-anime-signal.test.js (kept in its own file —
// see the module-level-binding note there): a MAL id found only via live
// search (no external_ids row, no stored grouping) must be written back to
// external_ids via ctx.catalog.upsertExternalId, so
// (a) the next episode of the same series reuses it instead of re-searching
//     MAL, and
// (b) mal-anime-id-enrichment's own eligibility check (which requires an
//     existing external_ids mal row) can eventually pick the series back up
//     for proper sequel-chain/episode-count mapping.

const EP_ID = 'b2c3d4e5-0000-4000-8000-000000000001';
const SERIES_ID = 'b2c3d4e5-0000-4000-8000-000000000002';

function makeSql() {
    return (strings) => {
        const q = strings.join(' ? ');
        if (q.includes('anime_genres') && q.includes("provider = 'tmdb'")) {
            return Promise.resolve([{ query_id: EP_ID }]);
        }
        if (q.includes('anime_genres')) {
            return Promise.resolve([]);
        }
        if (q.includes('group_external_id') && q.includes('DISTINCT ON (media_id)')) {
            return Promise.resolve([]);
        }
        if (q.includes('enriched_episode_count')) {
            return Promise.resolve([]);
        }
        if (q.includes('season.season_number') || q.includes('series.title AS series_title')) {
            return Promise.resolve([
                {
                    series_id: SERIES_ID,
                    series_title: "Frieren: Beyond Journey's End",
                    series_type: 'tv',
                    season_number: 1,
                },
            ]);
        }
        if (q.includes('external_id') && q.includes('FROM external_ids')) {
            return Promise.resolve([]);
        }
        if (q.includes('premiere_date')) {
            return Promise.resolve([{ premiere_date: '2023-11-17' }]);
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

describe('mal resolveIds — persists a live-search MAL id', () => {
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
                                        id: 52991,
                                        title: 'Sousou no Frieren',
                                        alternative_titles: {
                                            en: "Frieren: Beyond Journey's End",
                                            ja: '葬送のフリーレン',
                                            synonyms: [],
                                        },
                                        start_date: '2023-09-29',
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

    it('writes the resolved id back via ctx.catalog.upsertExternalId', async () => {
        const upsertExternalId = vi.fn(async () => {});
        const ctx = {
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
                          : 'dragonfire5020',
                set: async () => {},
            },
            http: httpMock,
            catalog: { upsertExternalId },
        };

        await plugin.resolveIds(ctx, [
            { mediaId: EP_ID, mediaType: 'episode', title: 'Frieren the Slayer' },
        ]);

        expect(upsertExternalId).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'mal',
                externalId: '52991',
                mediaType: 'tv',
                mediaItemId: SERIES_ID,
            }),
        );
    });
});
