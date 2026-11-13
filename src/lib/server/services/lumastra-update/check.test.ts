// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The update check's state machine, with the network at the fetcher seam and
 * the database at the plugin_settings query module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

let stored: Record<string, unknown> = {};
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: vi.fn(async () => ({ ...stored })),
    upsertTaskSettings: vi.fn(async (_sql: unknown, _id: string, s: Record<string, unknown>) => {
        stored = { ...stored, ...JSON.parse(JSON.stringify(s)) };
    }),
    addToTaskSettingList: vi.fn(async (_sql: unknown, _id: string, key: string, v: string) => {
        const list = Array.isArray(stored[key]) ? (stored[key] as string[]) : [];
        stored = { ...stored, [key]: list.includes(v) ? list : [...list, v] };
    }),
    removeFromTaskSettingList: vi.fn(async (_sql: unknown, _id: string, key: string, v: string) => {
        const list = Array.isArray(stored[key]) ? (stored[key] as string[]) : [];
        stored = { ...stored, [key]: list.filter((x) => x !== v) };
    }),
}));

const claim = vi.hoisted(() => ({ granted: true, calls: [] as unknown[][] }));
vi.mock('./claim.queries.js', () => ({
    claimUpdateCheck: vi.fn(async (...args: unknown[]) => {
        claim.calls.push(args);
        return claim.granted;
    }),
}));

import {
    markSecurityReviewed,
    unmarkSecurityReviewed,
    runUpdateCheck,
    readUpdateState,
    type UpdateCheckDeps,
} from './check.js';
import type { ReleasesFetcher, ReleasesFetchResult } from './github-releases.js';
import type { ReleaseInfo } from './version.js';

const sql = {} as postgres.Sql;
const NOW = Date.parse('2026-11-01T12:00:00Z');

function rel(version: string, security = false): ReleaseInfo {
    return {
        version,
        url: `https://github.com/Sapd/lumastra/releases/tag/v${version}`,
        publishedAt: '2026-10-30T00:00:00Z',
        security,
        prerelease: false,
    };
}

function logger() {
    return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function deps(
    fetchReleases: ReleasesFetcher,
    over: Partial<UpdateCheckDeps> = {},
): UpdateCheckDeps {
    return {
        sql,
        enabled: true,
        build: { version: 'v0.1.0' },
        fetchReleases,
        logger: logger(),
        now: () => NOW,
        random: () => 0.5,
        ...over,
    };
}

function fetcher(...results: Array<ReleasesFetchResult | Error>) {
    const queue = [...results];
    return vi.fn<ReleasesFetcher>(async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra request');
        if (next instanceof Error) throw next;
        return next;
    });
}

beforeEach(() => {
    stored = {};
    claim.granted = true;
    claim.calls = [];
});

describe('runUpdateCheck', () => {
    it('opted out: makes no request and touches no state', async () => {
        const f = fetcher();
        const out = await runUpdateCheck(deps(f, { enabled: false }));
        expect(out.status).toBe('disabled');
        expect(f).not.toHaveBeenCalled();
        expect(stored).toEqual({});
    });

    it('stores the releases and reports a security update', async () => {
        const f = fetcher({
            kind: 'ok',
            etag: '"e1"',
            releases: [rel('0.1.2'), rel('0.1.1', true)],
            complete: true,
        });
        const out = await runUpdateCheck(deps(f));
        expect(out.status).toBe('checked');
        expect(out.evaluation?.latest?.version).toBe('0.1.2');
        expect(out.evaluation?.securityFixedIn?.version).toBe('0.1.1');

        const state = await readUpdateState(sql);
        expect(state.etag).toBe('"e1"');
        expect(state.checkedAt).toBe(new Date(NOW).toISOString());
        // random()=0.5 → no jitter offset → exactly a day later.
        expect(state.nextCheckAt).toBe(new Date(NOW + 24 * 3600_000).toISOString());
        expect(f.mock.calls[0][0]).toMatchObject({ etag: null });
    });

    it('sends the stored ETag and reuses the stored releases on 304', async () => {
        const f = fetcher(
            { kind: 'ok', etag: '"e1"', releases: [rel('0.1.2')], complete: true },
            { kind: 'not-modified' },
        );
        await runUpdateCheck(deps(f));
        const out = await runUpdateCheck(deps(f, { force: true }));
        expect(f.mock.calls[1][0].etag).toBe('"e1"');
        expect(out.status).toBe('not-modified');
        expect(out.evaluation?.latest?.version).toBe('0.1.2');
        expect((await readUpdateState(sql)).releases).toHaveLength(1);
    });

    it('asks unconditionally when there is no stored list to reuse', async () => {
        const f = fetcher(
            { kind: 'ok', etag: '"empty"', releases: [], complete: true },
            { kind: 'ok', etag: '"e2"', releases: [rel('0.1.2')], complete: true },
        );
        await runUpdateCheck(deps(f));
        const out = await runUpdateCheck(deps(f, { force: true }));
        expect(f.mock.calls[1][0].etag).toBeNull();
        expect(out.evaluation?.latest?.version).toBe('0.1.2');
    });

    it('an abort (shutdown, cancel) leaves the state untouched and logs nothing', async () => {
        const log = logger();
        const controller = new AbortController();
        const f = vi.fn<ReleasesFetcher>(async () => {
            controller.abort();
            throw new Error('aborted');
        });
        const out = await runUpdateCheck(deps(f, { logger: log, signal: controller.signal }));
        expect(out.status).toBe('aborted');
        expect(stored).toEqual({});
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('does not ask again before nextCheckAt unless forced', async () => {
        const f = fetcher({ kind: 'ok', etag: null, releases: [rel('0.1.2')], complete: true });
        await runUpdateCheck(deps(f));
        const later = await runUpdateCheck(deps(f, { now: () => NOW + 3600_000 }));
        expect(later.status).toBe('not-due');
        expect(later.evaluation?.latest?.version).toBe('0.1.2');
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('jitters the next check by up to ±2h', async () => {
        await runUpdateCheck(deps(fetcher({ kind: 'not-modified' }), { random: () => 0 }));
        expect((await readUpdateState(sql)).nextCheckAt).toBe(
            new Date(NOW + 22 * 3600_000).toISOString(),
        );
    });

    it('network failure: no notice, no throw, warned once then quiet', async () => {
        const log = logger();
        const f = fetcher(new Error('getaddrinfo ENOTFOUND'), new Error('getaddrinfo ENOTFOUND'));
        const first = await runUpdateCheck(deps(f, { logger: log }));
        expect(first.status).toBe('failed');
        expect(first.evaluation?.latest).toBeNull();
        const second = await runUpdateCheck(deps(f, { logger: log, force: true }));
        expect(second.status).toBe('failed');
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledTimes(1);
        const state = await readUpdateState(sql);
        expect(state.lastError).toBe('getaddrinfo ENOTFOUND');
        expect(state.nextCheckAt).toBe(new Date(NOW + 6 * 3600_000).toISOString());
    });

    it('a failure keeps the previous answer', async () => {
        const f = fetcher(
            { kind: 'ok', etag: '"e1"', releases: [rel('0.1.2', true)], complete: true },
            new Error('timeout'),
        );
        await runUpdateCheck(deps(f));
        const out = await runUpdateCheck(deps(f, { force: true }));
        expect(out.status).toBe('failed');
        expect(out.evaluation?.securityFixedIn?.version).toBe('0.1.2');
    });

    it('404 (repo not public yet) is quiet "no information"', async () => {
        const log = logger();
        const out = await runUpdateCheck(deps(fetcher({ kind: 'not-found' }), { logger: log }));
        expect(out.status).toBe('no-releases');
        expect(out.evaluation?.latest).toBeNull();
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).not.toHaveBeenCalled();
    });

    it('rate limit postpones to the reset time', async () => {
        const retryAt = new Date(NOW + 20 * 60_000).toISOString();
        const out = await runUpdateCheck(deps(fetcher({ kind: 'rate-limited', retryAt })));
        expect(out.status).toBe('rate-limited');
        expect((await readUpdateState(sql)).nextCheckAt).toBe(retryAt);
    });

    it('clears once the running build reaches the latest release', async () => {
        await runUpdateCheck(
            deps(
                fetcher({ kind: 'ok', etag: null, releases: [rel('0.1.2', true)], complete: true }),
            ),
        );
        const upgraded = await runUpdateCheck(
            deps(fetcher(), { build: { version: 'v0.1.2' }, now: () => NOW + 60_000 }),
        );
        expect(upgraded.status).toBe('not-due');
        expect(upgraded.evaluation).toMatchObject({ latest: null, securityFixedIn: null });
    });

    it('reads malformed stored state as "never checked"', async () => {
        stored = { state: { releases: [{ version: 1 }], etag: 5 } };
        const state = await readUpdateState(sql);
        expect(state.releases).toEqual([]);
        expect(state.etag).toBeNull();
    });

    it('tracks the start of a failing streak and clears it on the next answer', async () => {
        const f = fetcher(new Error('down'), new Error('down'), { kind: 'not-modified' });
        await runUpdateCheck(deps(f));
        await runUpdateCheck(deps(f, { force: true, now: () => NOW + 3600_000 }));
        expect((await readUpdateState(sql)).failingSince).toBe(new Date(NOW).toISOString());
        await runUpdateCheck(deps(f, { force: true, now: () => NOW + 7200_000 }));
        expect((await readUpdateState(sql)).failingSince).toBeNull();
    });

    it('a rate limit is no answer either: it starts and keeps the failing streak', async () => {
        const retryAt = new Date(NOW + 60 * 60_000).toISOString();
        const f = fetcher(
            { kind: 'rate-limited', retryAt },
            { kind: 'rate-limited', retryAt: new Date(NOW + 3 * 3600_000).toISOString() },
        );
        await runUpdateCheck(deps(f));
        await runUpdateCheck(deps(f, { force: true, now: () => NOW + 2 * 3600_000 }));
        const state = await readUpdateState(sql);
        expect(state.failingSince).toBe(new Date(NOW).toISOString());
        expect(state.lastError).toBeNull();
        expect(state.lastAttemptAt).toBe(new Date(NOW + 2 * 3600_000).toISOString());
    });

    it('a 404 after the repository was found is a failure and keeps the list', async () => {
        const f = fetcher(
            { kind: 'ok', etag: null, releases: [rel('0.1.2', true)], complete: true },
            { kind: 'not-found' },
        );
        await runUpdateCheck(deps(f));
        const out = await runUpdateCheck(deps(f, { force: true }));
        expect(out.status).toBe('failed');
        expect(out.evaluation?.securityFixedIn?.version).toBe('0.1.2');
        expect((await readUpdateState(sql)).failingSince).not.toBeNull();
    });

    it('a partial read keeps older stored releases and drops the ETag', async () => {
        const f = fetcher(
            {
                kind: 'ok',
                etag: '"full"',
                releases: [rel('0.1.2'), rel('0.1.1', true)],
                complete: true,
            },
            { kind: 'ok', etag: '"p1"', releases: [rel('0.1.3'), rel('0.1.2')], complete: false },
        );
        await runUpdateCheck(deps(f));
        const out = await runUpdateCheck(deps(f, { force: true }));
        const state = await readUpdateState(sql);
        expect(state.releases.map((r) => r.version)).toEqual(['0.1.3', '0.1.2', '0.1.1']);
        expect(state.etag).toBeNull();
        expect(out.evaluation?.securityFixedIn?.version).toBe('0.1.1');
    });

    it('reads the whole list without If-None-Match once a week', async () => {
        const f = fetcher(
            { kind: 'ok', etag: '"e1"', releases: [rel('0.1.2')], complete: true },
            { kind: 'not-modified' },
            { kind: 'ok', etag: '"e2"', releases: [rel('0.1.2')], complete: true },
        );
        await runUpdateCheck(deps(f));
        await runUpdateCheck(deps(f, { force: true, now: () => NOW + 6 * 24 * 3600_000 }));
        await runUpdateCheck(deps(f, { force: true, now: () => NOW + 8 * 24 * 3600_000 }));
        expect(f.mock.calls.map((c) => c[0].etag)).toEqual([null, '"e1"', null]);
    });
});

describe('markSecurityReviewed', () => {
    async function seed(): Promise<void> {
        await runUpdateCheck(
            deps(
                fetcher({
                    kind: 'ok',
                    etag: null,
                    releases: [rel('0.1.2'), rel('0.1.1', true)],
                    complete: true,
                }),
            ),
        );
    }

    it('accepts only a stored security release', async () => {
        await seed();
        expect(await markSecurityReviewed(sql, '0.1.2')).toBe(false);
        expect(await markSecurityReviewed(sql, '9.9.9')).toBe(false);
        expect(await markSecurityReviewed(sql, '0.1.1')).toBe(true);
        expect((await readUpdateState(sql)).reviewedSecurity).toEqual(['0.1.1']);
    });

    it('turns the red notice into the normal one, and survives the next check', async () => {
        await seed();
        await markSecurityReviewed(sql, '0.1.1');
        const out = await runUpdateCheck(deps(fetcher({ kind: 'not-modified' }), { force: true }));
        expect(out.evaluation?.securityFixedIn).toBeNull();
        expect(out.evaluation?.securityReviewed?.version).toBe('0.1.1');
        expect(out.evaluation?.latest?.version).toBe('0.1.2');
        // The task never writes the admin's list into its own key.
        expect((stored.state as Record<string, unknown>).reviewedSecurity).toBeUndefined();
        expect(stored['reviewed-security']).toEqual(['0.1.1']);
    });

    it('can be undone', async () => {
        await seed();
        await markSecurityReviewed(sql, '0.1.1');
        await unmarkSecurityReviewed(sql, '0.1.1');
        const out = await runUpdateCheck(deps(fetcher({ kind: 'not-modified' }), { force: true }));
        expect(out.evaluation?.securityFixedIn?.version).toBe('0.1.1');
    });

    describe('one request per install per day', () => {
        it('another process holds the claim: no request, state untouched', async () => {
            claim.granted = false;
            const f = fetcher({ kind: 'ok', etag: null, releases: [rel('0.1.2')], complete: true });
            const out = await runUpdateCheck(deps(f));
            expect(out.status).toBe('not-due');
            expect(f).not.toHaveBeenCalled();
            expect(stored).toEqual({});
        });

        it('a due check claims before it asks, holding the slot for the retry window', async () => {
            const f = fetcher({ kind: 'not-modified' });
            await runUpdateCheck(deps(f));
            expect(claim.calls).toHaveLength(1);
            expect(claim.calls[0][1]).toMatchObject({
                nowMs: NOW,
                holdMs: 6 * 3600_000,
            });
        });

        it('a manual run does not need the claim', async () => {
            claim.granted = false;
            const f = fetcher({ kind: 'not-modified' });
            const out = await runUpdateCheck(deps(f, { force: true }));
            expect(out.status).not.toBe('not-due');
            expect(f).toHaveBeenCalledTimes(1);
            expect(claim.calls).toHaveLength(0);
        });

        it('not due: the claim is not even attempted', async () => {
            const f = fetcher({ kind: 'ok', etag: null, releases: [rel('0.1.2')], complete: true });
            await runUpdateCheck(deps(f));
            claim.calls = [];
            await runUpdateCheck(deps(f, { now: () => NOW + 3600_000 }));
            expect(claim.calls).toHaveLength(0);
        });

        it('contact: allowed on the first attempt, remembered, then not repeated within 20 h', async () => {
            const f = vi.fn<ReleasesFetcher>(async (opts) => {
                if (opts.contactAllowed) opts.onContact?.();
                throw new Error('offline');
            });
            await runUpdateCheck(deps(f));
            expect(f.mock.calls[0][0].contactAllowed).toBe(true);
            expect((await readUpdateState(sql)).lastContactAt).toBe(new Date(NOW).toISOString());

            // The 6 h retry after a failed day: GitHub only, lumastra.org is not asked again.
            await runUpdateCheck(deps(f, { now: () => NOW + 6 * 3600_000 }));
            expect(f.mock.calls[1][0].contactAllowed).toBe(false);

            // The next day it may ask again.
            await runUpdateCheck(deps(f, { now: () => NOW + 25 * 3600_000 }));
            expect(f.mock.calls[2][0].contactAllowed).toBe(true);
        });

        it('a fetcher that never contacted lumastra.org leaves lastContactAt alone', async () => {
            await runUpdateCheck(deps(fetcher({ kind: 'not-modified' })));
            expect((await readUpdateState(sql)).lastContactAt).toBeNull();
        });
    });
});
