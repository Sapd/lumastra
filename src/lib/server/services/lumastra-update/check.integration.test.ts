// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One update-check request per install per day, even when several processes
 * (replicas, a restart overlapping a run) reach the check at the same moment.
 * Real PostgreSQL: the claim is one atomic statement on `plugin_settings`, so
 * N concurrent runs make exactly one request. The task system's own single-run
 * guarantee (scope 'global' identity + Valkey fairness per scheduler bucket,
 * see tasks/cross-replica-enqueue.integration.test.ts) comes on top of this.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { runUpdateCheck, readUpdateState, UPDATE_CHECK_STATE_ID } from './check.js';
import type { ReleasesFetcher } from './github-releases.js';

const sql = getTestDb();
const NOW = Date.parse('2026-11-01T12:00:00Z');
const logger = { info: () => {}, warn: () => {}, debug: () => {} };

function slowFetcher(counter: { n: number }): ReleasesFetcher {
    return async () => {
        counter.n++;
        // Long enough that every concurrent run is past its state read.
        await new Promise((r) => setTimeout(r, 150));
        return {
            kind: 'ok',
            etag: null,
            complete: true,
            releases: [
                {
                    version: '0.1.2',
                    url: 'https://github.com/Sapd/lumastra/releases/tag/v0.1.2',
                    publishedAt: null,
                    security: false,
                    prerelease: false,
                },
            ],
        };
    };
}

const run = (fetchReleases: ReleasesFetcher, now = NOW) =>
    runUpdateCheck({
        sql,
        enabled: true,
        build: { version: 'v0.1.0' },
        fetchReleases,
        logger,
        now: () => now,
        random: () => 0.5,
    });

beforeEach(async () => {
    await sql`DELETE FROM plugin_settings WHERE plugin_id = ${UPDATE_CHECK_STATE_ID}`;
});

afterAll(async () => {
    await sql`DELETE FROM plugin_settings WHERE plugin_id = ${UPDATE_CHECK_STATE_ID}`;
    await closeTestDb();
});

describe('update check across processes (real database)', () => {
    it('eight simultaneous runs make exactly one request', async () => {
        const counter = { n: 0 };
        const fetcher = slowFetcher(counter);
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => run(fetcher)));
        expect(counter.n).toBe(1);
        expect(outcomes.filter((o) => o.status === 'checked')).toHaveLength(1);
        expect(outcomes.filter((o) => o.status === 'not-due')).toHaveLength(7);
        expect((await readUpdateState(sql)).releases).toHaveLength(1);
    });

    it('a second wave later the same day makes none', async () => {
        const counter = { n: 0 };
        await run(slowFetcher(counter));
        await Promise.all(
            Array.from({ length: 4 }, () => run(slowFetcher(counter), NOW + 3600_000)),
        );
        expect(counter.n).toBe(1);
    });

    it('a failed attempt holds the slot, so concurrent processes do not retry in a storm', async () => {
        let n = 0;
        const failing: ReleasesFetcher = async () => {
            n++;
            await new Promise((r) => setTimeout(r, 100));
            throw new Error('offline');
        };
        await Promise.all(Array.from({ length: 5 }, () => run(failing)));
        expect(n).toBe(1);
        // Within the retry window (6 h) still nothing; after it, one more try.
        await run(failing, NOW + 3600_000);
        expect(n).toBe(1);
        await run(failing, NOW + 6 * 3600_000 + 1000);
        expect(n).toBe(2);
    });

    it('the next day asks again', async () => {
        const counter = { n: 0 };
        await run(slowFetcher(counter));
        await run(slowFetcher(counter), NOW + 25 * 3600_000);
        expect(counter.n).toBe(2);
    });
});
