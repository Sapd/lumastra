// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Each test loads a fresh module: the plugin keeps per-process API state
// (rate limiting) that the first test's pull would otherwise carry over.
async function loadPlugin() {
    vi.resetModules();
    return (await import('./index.js')).default;
}

// pullWatchState maps each MAL list entry to Lumastra episodes through
// media_external_groupings. It used to run that reverse lookup once per entry
// per user (prod: 352k queries, each re-running a DISTINCT ON over every 'mal'
// grouping); it now loads the mapping once per pull run.

const httpMock = {
    get: (url, opts) => fetch(url, { ...opts, method: 'GET' }),
    post: (url, body, opts) => fetch(url, { ...opts, method: 'POST', body: JSON.stringify(body) }),
};

function makeCtx(sql, users) {
    return {
        sql,
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        secrets: {},
        userCredentials: {
            listUsersWithKey: async () => users,
            get: async (userId, key) => {
                if (key === 'access_token') return `${userId}-access`;
                if (key === 'refresh_token') return `${userId}-refresh`;
                if (key === 'provider_username') return `${userId}-mal`;
                return null;
            },
        },
        http: httpMock,
        catalog: { upsertExternalId: async () => {} },
    };
}

const entry = (id) => ({
    node: { id, title: `Anime ${id}`, media_type: 'tv' },
    list_status: {
        status: 'completed',
        num_episodes_watched: 2,
        updated_at: '2026-10-01T10:00:00Z',
    },
});

describe('mal pullWatchState reverse mapping', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({ data: [entry(100), entry(200), entry(300)], paging: {} }),
            })),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('loads the mapping once per run and maps every entry from it', async () => {
        const mappingQueries = [];
        const sql = vi.fn(async (strings) => {
            const text = strings.join('?');
            if (!text.includes('effective_mapping')) return [];
            mappingQueries.push(text);
            return [
                { group_external_id: '100', media_id: 'e1', season_number: 1, episode_number: 1 },
                { group_external_id: '100', media_id: 'e2', season_number: 1, episode_number: 2 },
                { group_external_id: '300', media_id: 'e9', season_number: 2, episode_number: 1 },
            ];
        });

        const plugin = await loadPlugin();
        const result = await plugin.pullWatchState(makeCtx(sql, ['u1', 'u2']));

        expect(result.errors).toEqual([]);
        expect(mappingQueries).toHaveLength(1);
        // Every list page maps through the one load: 2 episodes for MAL 100, none
        // for 200 (unmapped), 1 for 300. (The mocked list answers every status
        // page, so each entry repeats; the mapping must still load only once.)
        const ids = result.items.map((i) => i.internalMediaId);
        expect(new Set(ids)).toEqual(new Set(['e1', 'e2', 'e9']));
        expect(ids.filter((id) => id === 'e1').length).toBe(ids.filter((id) => id === 'e9').length);
    });

    it('tries a failed mapping load once per run, not once per entry', async () => {
        let attempts = 0;
        const sql = vi.fn(async (strings) => {
            if (!strings.join('?').includes('effective_mapping')) return [];
            attempts++;
            throw new Error('statement timeout');
        });

        const plugin = await loadPlugin();
        const result = await plugin.pullWatchState(makeCtx(sql, ['u3', 'u4']));

        expect(attempts).toBe(1);
        expect(result.items).toEqual([]);
        expect(result.errors).toEqual([
            expect.stringContaining('MAL episode mapping could not be loaded'),
        ]);
    });
});
