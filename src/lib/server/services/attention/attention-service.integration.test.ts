// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

// Force the dependency-check source to report one unreachable dependency, so the
// test asserts the SOURCES wiring + adapter without making real outbound probes.
vi.mock('$lib/server/preflight/dependency-checks-cache.js', async (importOriginal) => ({
    // Keep the real DependencyChecksWarmingError so `instanceof` in the service works.
    ...(await importOriginal<typeof import('$lib/server/preflight/dependency-checks-cache.js')>()),
    getCachedDependencyChecks: vi.fn(() =>
        Promise.resolve([
            {
                id: 'sonic-embedder',
                name: 'Music embedder',
                status: 'warn',
                url: 'http://sonic-embedder:8000',
            },
        ]),
    ),
}));

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getAttention,
    runAttentionDerivation,
    ackAttention,
    snoozeAttention,
    deriveAttention,
    resetAttentionSourceMemo,
} from './attention-service.js';
import type { DeriveOutcome, DerivedAlert } from './types.js';
import {
    DependencyChecksWarmingError,
    getCachedDependencyChecks,
} from '$lib/server/preflight/dependency-checks-cache.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import { createLibraryPath } from '$lib/server/database/queries/library-paths.queries.js';
import { config } from '$lib/server/config.js';
import * as upstreamFetch from '$lib/server/utils/fetch-timeout.js';

describe('AttentionService', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:%'`;
        resetAttentionSourceMemo();
    });

    const fixed = (): Promise<DerivedAlert[]> =>
        Promise.resolve([
            {
                id: 'test:circuit:x',
                fingerprint: 'open:5',
                type: 'circuit-open',
                severity: 'critical',
                title: 'x circuit open',
                actions: [],
            },
        ]);

    /**
     * Slice 1 split the single `getAttention({ derive })` call into a write half
     * (`runAttentionDerivation`, which the `problem-derive` task owns) and a read
     * half (`getAttention`, a plain projection of the persisted table). Every
     * assertion below is about what an operator sees AFTER a cycle, so drive both:
     * derive once, then read. That is exactly the production sequence, one poll
     * behind the task instead of inside the request.
     */
    const deriveThenRead = async (
        derive: (sql: postgres.Sql) => Promise<DerivedAlert[] | DeriveOutcome>,
        includeOps = false,
    ) => {
        await runAttentionDerivation(sql, { derive });
        return getAttention(sql, { includeOps });
    };

    it('surfaces unmatched Audiobookshelf listeners before any pull and protects the notice during an outage', async () => {
        const id = crypto.randomUUID();
        const username = `abs-attention-${id}`;
        await sql`INSERT INTO users (id, username) VALUES (${id}::uuid, ${username})`;
        const url = vi.spyOn(config, 'AUDIOURL', 'get').mockReturnValue('http://abs.example');
        const key = vi.spyOn(config, 'AUDIOAPIKEY', 'get').mockReturnValue('test-token');
        const enabled = vi.spyOn(config, 'FEATURE_AUDIOBOOKS', 'get').mockReturnValue(true);
        const autoCreate = vi
            .spyOn(config, 'AUDIOBOOK_AUTO_CREATE_USERS', 'get')
            .mockReturnValue(false);
        const fetch = vi
            .spyOn(upstreamFetch, 'fetchWithTimeout')
            .mockImplementation(async () => new Response(JSON.stringify({ users: [] })));
        const prefix = 'settings:audiobookshelf-unlinked-users';
        try {
            const first = await deriveAttention(sql);
            expect(first.failedPrefixes).not.toContain(prefix);
            expect(first.alerts.find((alert) => alert.id === prefix)?.title).toContain(username);

            autoCreate.mockReturnValue(true);
            const lazy = await deriveAttention(sql);
            expect(lazy.alerts.find((alert) => alert.id === prefix)?.title ?? '').not.toContain(
                username,
            );
            autoCreate.mockReturnValue(false);

            fetch.mockRejectedValue(new Error('upstream unavailable'));
            const outage = await deriveAttention(sql);
            expect(outage.failedPrefixes).toContain(prefix);

            const users = await sql<
                Array<{ id: string; username: string }>
            >`SELECT id, username FROM users WHERE disabled_at IS NULL AND deleted_at IS NULL`;
            fetch.mockImplementation(async () => new Response(JSON.stringify({ users })));
            const repaired = await deriveAttention(sql);
            expect(repaired.failedPrefixes).not.toContain(prefix);
            expect(repaired.alerts.find((alert) => alert.id === prefix)?.title ?? '').not.toContain(
                username,
            );

            enabled.mockReturnValue(false);
            fetch.mockClear();
            const disabled = await deriveAttention(sql);
            expect(disabled.alerts.some((alert) => alert.id === prefix)).toBe(false);
            expect(
                fetch.mock.calls.some(([requestUrl]) => String(requestUrl).includes('/api/users')),
            ).toBe(false);
        } finally {
            fetch.mockRestore();
            enabled.mockRestore();
            autoCreate.mockRestore();
            key.mockRestore();
            url.mockRestore();
            await sql`DELETE FROM users WHERE id = ${id}::uuid`;
        }
    });

    it('persists exactly one notice for ABS-only users and clears it after matching', async () => {
        const username = `absorphan-${crypto.randomUUID()}`;
        const id = crypto.randomUUID();
        const url = vi.spyOn(config, 'AUDIOURL', 'get').mockReturnValue('http://abs.example');
        const key = vi.spyOn(config, 'AUDIOAPIKEY', 'get').mockReturnValue('test-token');
        const enabled = vi.spyOn(config, 'FEATURE_AUDIOBOOKS', 'get').mockReturnValue(true);
        const autoCreate = vi
            .spyOn(config, 'AUDIOBOOK_AUTO_CREATE_USERS', 'get')
            .mockReturnValue(true);
        const fetch = vi
            .spyOn(upstreamFetch, 'fetchWithTimeout')
            .mockImplementation(
                async () => new Response(JSON.stringify({ users: [{ id: 'orphan', username }] })),
            );
        const prefix = 'settings:audiobookshelf-unlinked-users';
        const absOnly = async () => {
            const outcome = await deriveAttention(sql);
            expect(outcome.failedPrefixes).not.toContain(prefix);
            return outcome.alerts.filter((alert) => alert.id === prefix);
        };
        try {
            for (let cycle = 0; cycle < 2; cycle++) {
                await runAttentionDerivation(sql, { derive: absOnly });
                const board = await getAttention(sql);
                const notices = board.items.filter((item) => item.id === prefix);
                expect(notices).toHaveLength(1);
                expect(notices[0].title).toContain(username);
            }
            await sql`INSERT INTO users (id, username) VALUES (${id}::uuid, ${username})`;
            await runAttentionDerivation(sql, { derive: absOnly });
            expect((await getAttention(sql)).items.some((item) => item.id === prefix)).toBe(false);
        } finally {
            fetch.mockRestore();
            enabled.mockRestore();
            autoCreate.mockRestore();
            key.mockRestore();
            url.mockRestore();
            await sql`DELETE FROM users WHERE id = ${id}::uuid`;
            await sql`DELETE FROM admin_attention_alerts WHERE id = ${prefix}`;
        }
    });

    it('carries the quarantine backlog severity through the registered integrity source', async () => {
        await sql`TRUNCATE integrity_violations`;
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO integrity_violations (rule, severity)
            VALUES ('quarantine-backlog-large', 'low') RETURNING id`;
        try {
            const young = await deriveAttention(sql);
            expect(young.failedPrefixes).not.toContain('integrity:');
            expect(young.alerts.find((alert) => alert.id === 'integrity:all')?.severity).toBe(
                'info',
            );
            await sql`UPDATE integrity_violations SET severity = 'medium' WHERE id = ${id}`;
            resetAttentionSourceMemo();
            const aged = await deriveAttention(sql);
            expect(aged.failedPrefixes).not.toContain('integrity:');
            expect(aged.alerts.find((alert) => alert.id === 'integrity:all')?.severity).toBe(
                'warning',
            );
        } finally {
            await sql`DELETE FROM integrity_violations WHERE id = ${id}`;
        }
    });

    it('persists ack removal when the registered quarantine backlog escalates without count growth', async () => {
        await sql`TRUNCATE integrity_violations, admin_attention_alerts`;
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO integrity_violations (rule, severity)
            VALUES ('quarantine-backlog-large', 'low') RETURNING id`;
        const integrityOnly = async (): Promise<DerivedAlert[]> => {
            const outcome = await deriveAttention(sql);
            expect(outcome.failedPrefixes).not.toContain('integrity:');
            return outcome.alerts.filter((alert) => alert.id === 'integrity:all');
        };
        try {
            const young = await deriveThenRead(integrityOnly);
            expect(young.items[0].severity).toBe('info');
            expect(
                await ackAttention(sql, young.items[0].id, young.items[0].fingerprint, 'admin'),
            ).toBe(true);
            const acked = await deriveThenRead(integrityOnly);
            expect(acked.items[0].acked).toBe(true);
            expect(acked.unreadCount).toBe(0);
            await sql`UPDATE integrity_violations SET severity = 'medium' WHERE id = ${id}`;
            resetAttentionSourceMemo();
            const aged = await deriveThenRead(integrityOnly);
            expect(aged.items[0]).toMatchObject({ severity: 'warning', acked: false });
            expect(aged.unreadCount).toBe(1);
            expect(aged.verdict).toBe('degraded');
            const [persisted] =
                await sql`SELECT status, acked_at, acked_by, acked_count, acked_fingerprint FROM admin_attention_alerts WHERE id = 'integrity:all'`;
            expect(persisted).toMatchObject({
                status: 'active',
                acked_at: null,
                acked_by: null,
                acked_count: null,
                acked_fingerprint: null,
            });
        } finally {
            await sql`DELETE FROM integrity_violations WHERE id = ${id}`;
            await sql`DELETE FROM admin_attention_alerts WHERE id = 'integrity:all'`;
        }
    });

    it('persists and returns a critical verdict on first derive', async () => {
        const res = await deriveThenRead(fixed);
        expect(res.verdict).toBe('critical');
        expect(res.items.find((i) => i.id === 'test:circuit:x')).toBeTruthy();
        expect(res.unreadCount).toBeGreaterThanOrEqual(1);
    });

    it('ack then re-derive keeps the item but drops it from unread', async () => {
        await deriveThenRead(fixed);
        const ok = await ackAttention(sql, 'test:circuit:x', 'open:5', 'denis');
        expect(ok).toBe(true);
        const res = await deriveThenRead(fixed);
        const item = res.items.find((i) => i.id === 'test:circuit:x');
        expect(item?.acked).toBe(true);
        expect(res.items.filter((i) => i.id.startsWith('test:') && !i.acked)).toHaveLength(0);
    });

    it('resolves an item that disappears from the derivation', async () => {
        await deriveThenRead(fixed);
        const res = await deriveThenRead(() => Promise.resolve([]));
        expect(res.items.find((i) => i.id === 'test:circuit:x')).toBeFalsy();
        const rows =
            await sql`SELECT status FROM admin_attention_alerts WHERE id = 'test:circuit:x'`;
        expect(rows[0].status).toBe('resolved');
    });

    it('does NOT resolve persisted alerts when derive throws entirely (no false-healthy)', async () => {
        // Total-failure protection covers the REAL source prefixes, so seed under one
        // ('circuit:'); self-clean since it falls outside the beforeEach 'test:%' sweep.
        const id = 'circuit:itest-throw';
        const seed = (): Promise<DerivedAlert[]> =>
            Promise.resolve([
                {
                    id,
                    fingerprint: 'open',
                    type: 'circuit-open',
                    severity: 'critical',
                    title: 'itest circuit open',
                    actions: [],
                },
            ]);
        try {
            await deriveThenRead(seed);
            const down = (): Promise<DerivedAlert[]> =>
                Promise.reject(new Error('signal source down'));
            const res = await deriveThenRead(down);
            // The alert is carried forward, not resolved, and the verdict stays critical.
            expect(res.items.find((i) => i.id === id)).toBeTruthy();
            expect(res.verdict).toBe('critical');
            const rows = await sql`SELECT status FROM admin_attention_alerts WHERE id = ${id}`;
            expect(rows[0].status).not.toBe('resolved');
        } finally {
            await sql`DELETE FROM admin_attention_alerts WHERE id = ${id}`;
        }
    });

    it('protects only the failed source: a healthy source still resolves its gone alerts', async () => {
        // Seed a circuit alert AND a setup alert.
        await deriveThenRead(() =>
            Promise.resolve([
                {
                    id: 'test:circuit:x',
                    fingerprint: 'open',
                    type: 'circuit-open',
                    severity: 'critical',
                    title: 'x circuit open',
                    actions: [],
                },
                {
                    id: 'test:setup',
                    fingerprint: 's',
                    type: 'setup-incomplete',
                    severity: 'info',
                    title: 'setup',
                    actions: [],
                },
            ]),
        );
        // Next cycle: circuit source failed (protected), setup derived nothing (healthy → gone).
        const res = await deriveThenRead(() =>
            Promise.resolve({
                alerts: [],
                failedPrefixes: ['test:circuit:'],
            }),
        );
        expect(res.items.find((i) => i.id === 'test:circuit:x')).toBeTruthy(); // carried forward
        expect(res.items.find((i) => i.id === 'test:setup')).toBeFalsy(); // resolved
    });

    it('snooze suppresses an item from unread/verdict until it expires', async () => {
        await deriveThenRead(fixed);
        const ok = await snoozeAttention(sql, 'test:circuit:x', 'open:5', 60 * 60 * 1000);
        expect(ok).toBe(true);
        const res = await deriveThenRead(fixed);
        const item = res.items.find((i) => i.id === 'test:circuit:x');
        expect(item?.snoozed).toBe(true);
        expect(
            res.items.filter((i) => i.id.startsWith('test:') && !i.acked && !i.snoozed),
        ).toHaveLength(0);
    });

    it('resolved items surface in resolvedHistory under includeOps', async () => {
        await deriveThenRead(fixed);
        // Next cycle derives nothing → the item resolves and stamps resolved_at.
        await deriveThenRead(() => Promise.resolve([]));
        const ops = await deriveThenRead(() => Promise.resolve([]), true);
        expect(ops.resolvedHistory?.some((i) => i.id === 'test:circuit:x')).toBe(true);
    });

    it('optional-integration info items keep the verdict healthy and their ack sticks across re-derive', async () => {
        // Mirrors a fresh, correctly-set-up install with no optional keys: three
        // `info` nudges (Last.fm / Discogs / MDBList) and NOTHING else. info must
        // never degrade the verdict, and the constant 'missing' fingerprint means
        // an operator's ack survives the next derivation.
        const optional = (): Promise<DerivedAlert[]> =>
            Promise.resolve([
                {
                    id: 'test:optional-integration:lastfm',
                    fingerprint: 'missing',
                    type: 'optional-integration',
                    severity: 'info',
                    title: 'Last.fm is not configured (optional)',
                    actions: [],
                },
                {
                    id: 'test:optional-integration:mdblist',
                    fingerprint: 'missing',
                    type: 'optional-integration',
                    severity: 'info',
                    title: 'MDBList is not configured (optional)',
                    actions: [],
                },
            ]);

        const res = await deriveThenRead(optional);
        // info-only board → still healthy.
        expect(res.verdict).toBe('healthy');
        expect(res.items.find((i) => i.id === 'test:optional-integration:lastfm')).toBeTruthy();

        // Ack with the constant 'missing' fingerprint, then re-derive identically.
        const ok = await ackAttention(sql, 'test:optional-integration:lastfm', 'missing', 'denis');
        expect(ok).toBe(true);
        const after = await deriveThenRead(optional);
        const item = after.items.find((i) => i.id === 'test:optional-integration:lastfm');
        expect(item?.acked).toBe(true);
        // Verdict stays healthy and the acked item is no longer unread.
        expect(after.verdict).toBe('healthy');
        expect(
            after.items.filter((i) => i.id === 'test:optional-integration:lastfm' && !i.acked),
        ).toHaveLength(0);
    });

    it('includeOps adds activity + recentlyAdded; default omits them', async () => {
        const base = await deriveThenRead(() => Promise.resolve([]));
        expect(base.activity).toBeUndefined();
        expect(base.recentlyAdded).toBeUndefined();

        const ops = await deriveThenRead(() => Promise.resolve([]), true);
        expect(ops.activity).toBeDefined();
        expect(typeof ops.activity?.running).toBe('number');
        expect(Array.isArray(ops.recentlyAdded)).toBe(true);
    });

    it('registers the optional-dependency source: a warn finding becomes a warning alert linking to health', async () => {
        // Real derive over the test DB (no persistence — deriveAttention only reads).
        // Other Valkey/DB-backed sources may fail in the test env; they degrade into
        // failedPrefixes and never affect the mocked optional-dependency finding.
        const { alerts } = await deriveAttention(sql);
        const dep = alerts.find((a) => a.id === 'optional-dependency:sonic-embedder');
        expect(dep).toBeDefined();
        expect(dep?.severity).toBe('warning');
        expect(dep?.type).toBe('degraded-component');
        expect(dep?.fingerprint).toBe('down');
        expect(dep?.sourceRef).toBe('/admin/system/health#dependencies');
        expect(dep?.title).toBe('Music embedder is unreachable');
    });

    it('a cold (warming) source stays protected but is reported as warming, not failed', async () => {
        vi.mocked(getCachedDependencyChecks).mockRejectedValueOnce(
            new DependencyChecksWarmingError(),
        );
        const outcome = await deriveAttention(sql);
        expect(outcome.failedPrefixes).toContain('optional-dependency:');
        expect(outcome.warmingPrefixes).toContain('optional-dependency:');
    });

    it('a genuinely failing source is protected and NOT reported as warming', async () => {
        vi.mocked(getCachedDependencyChecks).mockRejectedValueOnce(new Error('probe crashed'));
        const outcome = await deriveAttention(sql);
        expect(outcome.failedPrefixes).toContain('optional-dependency:');
        expect(outcome.warmingPrefixes).not.toContain('optional-dependency:');
    });

    it('an interval-limited source reuses its last result until the interval passes', async () => {
        const id = 'music-hygiene:music-track-no-artist';
        await sql`DELETE FROM media_items WHERE title = 'attention-interval-orphan-track'`;
        // The title carries the count; the fingerprint is bucketed and may not move.
        const title = (o: DeriveOutcome): string | null =>
            o.alerts.find((a) => a.id === id)?.title ?? null;
        const before = title(await deriveAttention(sql));

        // A parentless track with a file is a track-without-artist finding, so
        // the count moves once it is recounted.
        await sql`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('attention-interval-orphan-track', 'track', 'active', true)`;
        try {
            expect(title(await deriveAttention(sql))).toBe(before);

            resetAttentionSourceMemo();
            const recounted = title(await deriveAttention(sql));
            expect(recounted).not.toBeNull();
            expect(recounted).not.toBe(before);
        } finally {
            await sql`DELETE FROM media_items WHERE title = 'attention-interval-orphan-track'`;
        }
    });

    // Finding: "MUSIC-PROVIDER NOTIFICATION NOISE" — a Movies & TV-only install
    // (no music library, no music content) must not nag about Last.fm/Discogs,
    // which are music-scoped integrations.
    describe('optional-integration source: music-scoped gating', () => {
        beforeEach(async () => {
            // Guarantee a clean baseline regardless of what earlier test files left
            // behind in this shared test DB: no music library/content, and no
            // lingering plugin_secrets rows for the music-scoped integrations under
            // test (a leftover LASTFM_API_KEY/DISCOGS_TOKEN row would make the
            // integration look "configured" and mask the gating behavior).
            await sql.unsafe(
                'TRUNCATE TABLE media_embeddings, media_file_items, media_files, media_items, library_paths, library_groups CASCADE',
            );
            await sql`
                DELETE FROM plugin_secrets
                 WHERE (plugin_id = 'music-popularity' AND key = 'LASTFM_API_KEY')
                    OR (plugin_id IN ('artist-enrichment', 'album-enrichment') AND key = 'DISCOGS_TOKEN')
            `;
        });

        it('suppresses Last.fm and Discogs when no music library or content exists', async () => {
            const { alerts } = await deriveAttention(sql);
            const ids = alerts.map((a) => a.id);
            expect(ids).not.toContain('optional-integration:lastfm');
            expect(ids).not.toContain('optional-integration:discogs');
        });

        it('surfaces Last.fm and Discogs once a music library is configured', async () => {
            const group = await createLibraryGroup(sql, { name: 'Attention Gate Test Group' });
            await createLibraryPath(sql, {
                path: '/test-attention-music-gate/music',
                media_type: 'music',
                library_group_id: group.id,
            });

            const { alerts } = await deriveAttention(sql);
            const ids = alerts.map((a) => a.id);
            expect(ids).toContain('optional-integration:lastfm');
            expect(ids).toContain('optional-integration:discogs');
        });
    });
});
