// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Regression: a live search result must NEVER be persisted to external_ids
// until the sequel-chain walk has actually confirmed it behaves like season 1
// of a chain reaching the target season.
//
// Why this matters: searchTitle for a multi-season series is always the bare
// series title (no season qualifier), and the year fed into scoring comes
// from the EPISODE's own premiere_date — for a season-2+ episode that year
// can match a LATER season's MAL entry (its own start_date) at least as well
// as season 1's, so searchMalAnime can hand back a later season's id as
// `baseMalId`. walkSequelChain assumes its input IS season 1 and walks
// forward; when the id it's actually given already points past season 1, the
// walk either overshoots (reachedSeason !== seasonNumber, the case tested
// here — this plugin correctly refuses to PUSH) or, if persisted anyway,
// permanently corrupts the series root's external_ids mapping in a way that
// then poisons every OTHER season's episodes via the storedRows fast path,
// including season-1 episodes (which never re-walk the chain at all and would
// push straight onto whatever's stored).

const EP_ID = 'c3d4e5f6-0000-4000-8000-000000000001';
const SERIES_ID = 'c3d4e5f6-0000-4000-8000-000000000002';

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
        // Episode → season → series parent walk: season 2 this time.
        if (q.includes('season.season_number') || q.includes('series.title AS series_title')) {
            return Promise.resolve([
                {
                    series_id: SERIES_ID,
                    series_title: 'Some Ongoing Anime',
                    series_type: 'tv',
                    season_number: 2,
                },
            ]);
        }
        if (q.includes('external_id') && q.includes('FROM external_ids')) {
            return Promise.resolve([]);
        }
        if (q.includes('premiere_date')) {
            return Promise.resolve([{ premiere_date: '2026-01-16' }]);
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

describe('mal resolveIds — never persists an unconfirmed multi-season guess', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url) => {
                const u = String(url);
                if (u.includes('/users/@me')) {
                    return { ok: true, status: 200, json: async () => ({ name: 'x' }) };
                }
                if (u.includes('/anime?q=')) {
                    // The search scores a match confidently (title + year +
                    // type), but it's actually the WRONG season's entry —
                    // walkSequelChain will discover this below.
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            data: [
                                {
                                    node: {
                                        id: 99999,
                                        title: 'Some Ongoing Anime 2nd Season',
                                        alternative_titles: {
                                            en: 'Some Ongoing Anime',
                                            ja: '',
                                            synonyms: [],
                                        },
                                        start_date: '2026-01-16',
                                        media_type: 'tv',
                                        num_episodes: 12,
                                    },
                                },
                            ],
                        }),
                    };
                }
                // getAnimeInfo(99999): no `related_anime` sequel link at all,
                // so walkSequelChain's loop breaks on its first hop — it never
                // reaches season 2, leaving reachedSeason stuck at 1.
                if (u.includes('/anime/99999')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ related_anime: [], num_episodes: 12 }),
                    };
                }
                return { ok: false, status: 404, json: async () => ({}) };
            }),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not call catalog.upsertExternalId when the sequel walk falls short', async () => {
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

        const resolved = await plugin.resolveIds(ctx, [
            { mediaId: EP_ID, mediaType: 'episode', title: 'Episode 3' },
        ]);

        expect(resolved).toEqual([]);
        expect(upsertExternalId).not.toHaveBeenCalled();
    });
});
