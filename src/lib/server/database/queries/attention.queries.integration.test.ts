// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    readAllAlerts,
    upsertAlerts,
    resolveAlerts,
    ackAlert,
    countActiveManualRuns,
    getRecentlyAddedForOps,
    loadRepeatedSubsystemEvents,
    loadUncleanExits,
    cleanupResolvedAlerts,
    RESOLVED_ALERT_HISTORY_CAP,
    loadJellyfinUnlinkedUsers,
} from './attention.queries.js';
import type { UpsertAlert } from '../../services/attention/types.js';

const NOW = '2026-06-05T12:00:00.000Z';

function up(over: Partial<UpsertAlert> = {}): UpsertAlert {
    return {
        id: 'test:circuit:x',
        fingerprint: 'open:5',
        type: 'circuit-open',
        severity: 'critical',
        title: 'x circuit open',
        detail: null,
        source_ref: null,
        status: 'active',
        first_seen: NOW,
        last_seen: NOW,
        acked_at: null,
        acked_by: null,
        acked_fingerprint: null,
        count: null,
        acked_count: null,
        snoozed_until: null,
        ...over,
    };
}

describe('attention.queries', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:%'`;
    });

    it('upserts then reads back', async () => {
        await upsertAlerts(sql, [up()]);
        const rows = (await readAllAlerts(sql)).filter((r) => r.id.startsWith('test:'));
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('active');
    });

    it('upsert preserves PK and overwrites mutable fields', async () => {
        await upsertAlerts(sql, [up({ title: 'first' })]);
        await upsertAlerts(sql, [up({ title: 'second', last_seen: '2026-06-05T13:00:00.000Z' })]);
        const rows = (await readAllAlerts(sql)).filter((r) => r.id.startsWith('test:'));
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('second');
    });

    it('resolveAlerts flips status to resolved', async () => {
        await upsertAlerts(sql, [up()]);
        await resolveAlerts(sql, ['test:circuit:x']);
        const rows = (await readAllAlerts(sql)).filter((r) => r.id.startsWith('test:'));
        expect(rows[0].status).toBe('resolved');
    });

    it('ackAlert only acks when fingerprint matches', async () => {
        await upsertAlerts(sql, [up({ fingerprint: 'open:5' })]);
        const ok = await ackAlert(sql, 'test:circuit:x', 'open:5', 'denis');
        expect(ok).toBe(true);
        const stale = await ackAlert(sql, 'test:circuit:x', 'open:9', 'denis');
        expect(stale).toBe(false);
        const rows = (await readAllAlerts(sql)).filter((r) => r.id.startsWith('test:'));
        expect(rows[0].status).toBe('acked');
        expect(rows[0].acked_fingerprint).toBe('open:5');
    });

    it('ackAlert snapshots the live count into acked_count (watermark)', async () => {
        await upsertAlerts(sql, [up({ id: 'test:dl:probe', count: 3, acked_count: null })]);
        const ok = await ackAlert(sql, 'test:dl:probe', 'open:5', 'denis');
        expect(ok).toBe(true);
        const row = (await readAllAlerts(sql)).find((r) => r.id === 'test:dl:probe');
        // acked_count is captured server-side from the row's live count, not the client.
        expect(row?.acked_count).toBe(3);
        expect(row?.count).toBe(3);
    });
});

describe('attention.queries — Fix 14/15/bulk upsert', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:%'`;
    });

    it('Fix 14 — re-fire clears resolved_at: a re-active alert cannot carry a non-null resolved_at', async () => {
        // Insert, then resolve the alert.
        await upsertAlerts(sql, [up()]);
        await resolveAlerts(sql, ['test:circuit:x']);
        const resolvedRows = (await readAllAlerts(sql)).filter((r) => r.id === 'test:circuit:x');
        expect(resolvedRows[0].status).toBe('resolved');
        expect(resolvedRows[0].resolved_at).not.toBeNull();

        // Re-fire the same alert via upsertAlerts (same id, same fingerprint).
        await upsertAlerts(sql, [up({ title: 're-fired title' })]);
        const reFireRows = (await readAllAlerts(sql)).filter((r) => r.id === 'test:circuit:x');
        expect(reFireRows).toHaveLength(1);
        // Fix 14: resolved_at must be cleared when a previously-resolved alert re-fires.
        expect(reFireRows[0].resolved_at).toBeNull();
        expect(reFireRows[0].status).toBe('active');
    });

    it('Fix 15 — resolveAlerts clears snoozed_until so the snooze cannot suppress a re-fire', async () => {
        const FUTURE = '2099-01-01T00:00:00.000Z';
        // Insert with a future snooze, then resolve it.
        await upsertAlerts(sql, [up({ snoozed_until: FUTURE })]);
        const before = (await readAllAlerts(sql)).find((r) => r.id === 'test:circuit:x');
        expect(before?.snoozed_until).not.toBeNull();

        await resolveAlerts(sql, ['test:circuit:x']);
        const after = (await readAllAlerts(sql)).find((r) => r.id === 'test:circuit:x');
        // Fix 15: snoozed_until is cleared on resolution so a future re-fire is not silently suppressed.
        expect(after?.snoozed_until).toBeNull();
        expect(after?.resolved_at).not.toBeNull();
        expect(after?.status).toBe('resolved');
    });

    it('bulk upsert inserts all rows in one call with correct column values including nullable fields', async () => {
        const alertA = up({
            id: 'test:bulk:a',
            fingerprint: 'open',
            title: 'Alert A',
            detail: 'some detail',
            source_ref: '/admin/system/health',
        });
        const alertB = up({
            id: 'test:bulk:b',
            fingerprint: 'half-open',
            title: 'Alert B',
            detail: null,
            source_ref: null,
        });

        await upsertAlerts(sql, [alertA, alertB]);

        const rows = (await readAllAlerts(sql)).filter((r) => r.id.startsWith('test:bulk:'));
        expect(rows).toHaveLength(2);

        const rowA = rows.find((r) => r.id === 'test:bulk:a');
        expect(rowA?.fingerprint).toBe('open');
        expect(rowA?.title).toBe('Alert A');
        expect(rowA?.detail).toBe('some detail');
        expect(rowA?.source_ref).toBe('/admin/system/health');
        expect(rowA?.status).toBe('active');

        const rowB = rows.find((r) => r.id === 'test:bulk:b');
        expect(rowB?.fingerprint).toBe('half-open');
        expect(rowB?.title).toBe('Alert B');
        // Nullable fields land as null, not undefined or empty string.
        expect(rowB?.detail).toBeNull();
        expect(rowB?.source_ref).toBeNull();
    });
});

describe('attention.queries — ops extras', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('countActiveManualRuns returns a non-negative number', async () => {
        const n = await countActiveManualRuns(sql);
        expect(typeof n).toBe('number');
        expect(n).toBeGreaterThanOrEqual(0);
    });

    it('getRecentlyAddedForOps returns rows newest-first, capped, with ISO addedAt', async () => {
        const rows = await getRecentlyAddedForOps(sql, 10);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeLessThanOrEqual(10);
        for (const r of rows) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.title).toBe('string');
            expect(typeof r.mediaType).toBe('string');
            expect(r.mediaType === 'movie' || r.mediaType === 'episode').toBe(true);
            expect(typeof r.addedAt).toBe('string');
            expect(r.addedAt.endsWith('Z')).toBe(true);
            // New episode-context fields — null for movies, possibly populated for episodes.
            // We don't require seeded episodes, so we just assert the field is present on the type
            // and its value is either null or the expected type when present.
            expect(r.seriesTitle === null || typeof r.seriesTitle === 'string').toBe(true);
            expect(r.seriesId === null || typeof r.seriesId === 'string').toBe(true);
            if (r.seriesTitle !== null) expect(r.seriesId).not.toBeNull();
            expect(r.seasonNumber === null || typeof r.seasonNumber === 'number').toBe(true);
            expect(r.episodeNumber === null || typeof r.episodeNumber === 'number').toBe(true);
        }
        const ts = rows.map((r) => Date.parse(r.addedAt));
        expect(ts).toEqual([...ts].sort((a, b) => b - a));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary guard.
//
// This began as a drift guard on admin_attention_alerts_type_check: every
// AttentionTypeSchema value had to be insertable against the live CHECK. That
// constraint is the failure that hit prod 2026-07-15 — 'unmatched-files' was
// added to the enum + adapters without a constraint migration, the first such
// alert threw 23514, and the WHOLE attention block went unavailable (verdict
// degraded, "0 items" in yellow, "Status check unavailable").
//
// Migration 16.231.0 DROPPED that constraint and opened the vocabulary
// (`domain`), so the class of failure above can no longer happen. The guard is
// inverted accordingly: what must now hold is that a value outside the legacy
// enum still inserts. If that stops being true, someone has re-closed the
// vocabulary with a new CHECK and reintroduced the four-artifact tax — do not
// "fix" it by extending the constraint.
// ─────────────────────────────────────────────────────────────────────────────
describe('attention.queries — alert-type vocabulary guard', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:drift:%'`;
        await closeTestDb();
    });

    it('accepts every AttentionTypeSchema value', async () => {
        const { AttentionTypeSchema } = await import('$lib/schemas/api-attention-responses.js');
        const now = new Date().toISOString();
        const alerts: UpsertAlert[] = AttentionTypeSchema.options.map((type) => ({
            id: `test:drift:${type}`,
            fingerprint: 'drift',
            type,
            severity: 'info',
            title: `drift guard ${type}`,
            detail: null,
            source_ref: null,
            status: 'active',
            first_seen: now,
            last_seen: now,
            acked_at: null,
            acked_by: null,
            acked_fingerprint: null,
            count: null,
            acked_count: null,
            snoozed_until: null,
        }));
        // Threw 23514 (check_violation) whenever an enum value was missing from
        // the DB constraint — the exact prod failure this used to guard against.
        await expect(upsertAlerts(sql, alerts)).resolves.not.toThrow();
    });

    it('accepts a type outside the legacy enum (the constraint is gone)', async () => {
        const now = new Date().toISOString();
        const alerts: UpsertAlert[] = [
            {
                id: 'test:drift:open-vocabulary',
                fingerprint: 'drift',
                // Deliberately not an AttentionTypeSchema member. Under the old
                // CHECK this threw 23514; a new producer therefore needed a
                // migration before it could raise anything at all.
                type: 'plugin-failure',
                severity: 'info',
                title: 'drift guard open vocabulary',
                detail: null,
                source_ref: null,
                status: 'active',
                first_seen: now,
                last_seen: now,
                acked_at: null,
                acked_by: null,
                acked_fingerprint: null,
                count: null,
                acked_count: null,
                snoozed_until: null,
            },
        ];
        await expect(upsertAlerts(sql, alerts)).resolves.not.toThrow();

        // The column the vocabulary moved to exists and is never null, so a row
        // written by a producer that has not adopted `domain` yet still has one.
        const [row] = await sql<{ domain: string | null }[]>`
            SELECT domain FROM admin_attention_alerts WHERE id = 'test:drift:open-vocabulary'
        `;
        expect(row?.domain).toBe('system');
    });
});

describe('attention.queries — repeated-recovery restart grace', () => {
    let sql: postgres.Sql;
    const INSTANCE = 'test-grace-node';

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        // Deploy waves use cluster-wide history; do not leave this suite's
        // versions behind for the unclean-exit queries that run next.
        await sql`DELETE FROM cluster_node_events WHERE instance_id = ${INSTANCE}`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM audit_log WHERE category = 'test-grace'`;
        await sql`DELETE FROM cluster_node_events WHERE instance_id = ${INSTANCE}`;
    });

    /** Write one subsystem recovery event `minutesAgo` in the past. */
    async function recovery(minutesAgo: number): Promise<void> {
        await sql`
            INSERT INTO audit_log (instance_id, source, category, action, severity, summary, detail, ts)
            VALUES (${INSTANCE}, 'subsystem', 'test-grace', 'orphans-reclaimed', 'warn', 'reclaimed 1',
                    '{}'::jsonb, NOW() - make_interval(mins => ${minutesAgo}))
        `;
    }
    /**
     * Write an 'online' node event `minutesAgo` in the past, carrying `version`.
     * A version unique to this call simulates a genuine deploy (its
     * first-ever-seen timestamp is exactly this event's `created_at`, so it
     * reads as "a new build just went out"); reusing an already-seeded version
     * simulates the SAME build restarting — a crash loop, not a deploy.
     */
    async function nodeEvent(minutesAgo: number, version: string): Promise<void> {
        await sql`
            INSERT INTO cluster_node_events (instance_id, event_type, created_at, version)
            VALUES (${INSTANCE}, 'online', NOW() - make_interval(mins => ${minutesAgo}), ${version})
        `;
    }
    const load = () => loadRepeatedSubsystemEvents(sql, ['orphans-reclaimed'], 3);

    it('counts recoveries that happened while the cluster was stable', async () => {
        for (const m of [600, 500, 400, 300]) await recovery(m);

        const rows = (await load()).filter((r) => r.category === 'test-grace');

        expect(rows).toHaveLength(1);
        expect(rows[0].cnt).toBe(4);
    });

    it('ignores recoveries that follow a node restart carrying a NEW version', async () => {
        // 🔴 The false alarm this exists to kill: a deploy SIGTERMs a worker
        // mid-run, its runs cannot drain inside the stop grace, and the
        // reconciler reclaims them minutes later. That is the system working,
        // not a fault — but counting it turned the alert into a
        // deploy-frequency meter that fired "×19 in 24 h" on a day when
        // nothing was wedged at all. Each wave here is a genuinely NEW,
        // never-seen-before version — a real deploy.
        for (const m of [600, 500, 400, 300]) {
            await nodeEvent(m + 5, `v-deploy-stable-${m}`);
            await recovery(m);
        }

        const rows = (await load()).filter((r) => r.category === 'test-grace');

        expect(rows).toHaveLength(0);
    });

    it('still fires when only some recoveries are restart-related', async () => {
        await nodeEvent(605, 'v-deploy-partial');
        await recovery(600); // excused by the restart
        for (const m of [500, 400, 300] as const) await recovery(m); // genuine

        const rows = (await load()).filter((r) => r.category === 'test-grace');

        expect(rows).toHaveLength(1);
        expect(rows[0].cnt).toBe(3);
    });

    it('does not excuse a recovery that PRECEDES the restart', async () => {
        // Order matters: a node going down AFTER the recovery cannot explain it.
        for (const m of [600, 500, 400] as const) await recovery(m);
        await nodeEvent(100, 'v-deploy-precedes');

        const rows = (await load()).filter((r) => r.category === 'test-grace');

        expect(rows[0]?.cnt).toBe(3);
    });

    it('does NOT excuse a same-VERSION restart — a crash loop, not a deploy', async () => {
        // 🔴 Regression for the bug this grace introduced: the excusing node
        // event used to need only ANY transition nearby, so a crash-restarting
        // instance (same build coming back up, no code change) got the exact
        // same excuse as a real deploy. Seed the "version has been running for
        // a while" baseline first, then four more same-version restarts paired
        // with recoveries — none of them a deploy — must all still count.
        const LONG_LIVED_VERSION = 'v-already-deployed';
        await nodeEvent(700, LONG_LIVED_VERSION); // this version's first-ever appearance
        for (const m of [600, 500, 400, 300]) {
            await nodeEvent(m + 5, LONG_LIVED_VERSION); // same build restarting
            await recovery(m);
        }

        const rows = (await load()).filter((r) => r.category === 'test-grace');

        expect(rows).toHaveLength(1);
        expect(rows[0].cnt).toBe(4);
    });
});

describe('attention.queries — loadUncleanExits', () => {
    let sql: postgres.Sql;
    const INSTANCE = 'test-unclean-node';

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await sql`DELETE FROM cluster_node_events WHERE instance_id LIKE 'test-unclean-%'`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM cluster_node_events WHERE instance_id LIKE 'test-unclean-%'`;
    });

    /** One 'online' row `minutesAgo` in the past, as recordInstanceStart writes it. */
    async function start(
        minutesAgo: number,
        version: string | null,
        reason: 'start' | 'restart' | 'restart_unclean' = 'restart_unclean',
        instance = INSTANCE,
    ): Promise<void> {
        await sql`
            INSERT INTO cluster_node_events
                (instance_id, event_type, role, hostname, version, reason, created_at)
            VALUES (${instance}, 'online', 'worker', 'media-1', ${version}, ${reason},
                    NOW() - make_interval(mins => ${minutesAgo}))
        `;
    }
    const load = async () =>
        (await loadUncleanExits(sql, 2)).filter((r) => r.instanceId.startsWith('test-unclean-'));

    it('counts repeated unclean exits of a long-running build', async () => {
        await start(2000, 'v-old', 'start'); // first seen more than a day ago
        for (const m of [600, 400, 200]) await start(m, 'v-old');

        const rows = await load();

        expect(rows).toEqual([
            { instanceId: INSTANCE, cnt: 3, role: 'worker', hostname: 'media-1' },
        ]);
    });

    it('ignores clean restarts and anything older than 24 hours', async () => {
        await start(2000, 'v-old', 'start');
        await start(1500, 'v-old'); // older than 24 h
        await start(600, 'v-old', 'restart'); // graceful
        await start(300, 'v-old');

        expect(await load()).toEqual([]);
    });

    it('excuses unclean restarts inside a deploy wave of a new version', async () => {
        // A deploy whose old process outlives its stop grace is SIGKILLed; the new
        // build then comes up as restart_unclean. Two deploys, each a new version.
        await start(2000, 'v-old', 'start');
        await start(600, 'v-deploy-a');
        await start(300, 'v-deploy-b');

        expect(await load()).toEqual([]);
    });

    it('excuses rollback restarts in the current v1 deploy wave after v1 → v2 → v1', async () => {
        await start(2000, 'v1', 'start');
        await start(600, 'v2');
        await start(300, 'v1');
        await start(290, 'v1');

        expect(await load()).toEqual([]);
    });

    it('counts crashes after the rollback wave without counting the rollback restarts', async () => {
        await start(2000, 'v1', 'start');
        await start(600, 'v2');
        await start(300, 'v1');
        await start(290, 'v1');
        await start(200, 'v1');
        await start(100, 'v1');

        expect(await load()).toEqual([
            { instanceId: INSTANCE, cnt: 2, role: 'worker', hostname: 'media-1' },
        ]);
    });

    it('still counts the same new build dying again after its deploy wave', async () => {
        await start(2000, 'v-old', 'start');
        await start(600, 'v-new'); // the deploy itself: excused
        await start(400, 'v-new'); // 200 min later: a crash, not a deploy
        await start(200, 'v-new');

        const rows = await load();

        expect(rows).toHaveLength(1);
        expect(rows[0].cnt).toBe(2);
    });

    it('leaves out an instance that is no longer running', async () => {
        await start(2000, 'v-old', 'start');
        for (const m of [600, 400]) await start(m, 'v-old');
        await sql`
            INSERT INTO cluster_node_events (instance_id, event_type, reason, created_at)
            VALUES (${INSTANCE}, 'offline', 'stop', NOW() - make_interval(mins => 100))
        `;

        expect(await load()).toEqual([]);
    });

    it('excuses a restart just inside the deploy-wave window but not just outside it', async () => {
        await start(2000, 'v-old', 'start');
        // v-edge first came online 300 min ago (the deploy itself, excused).
        await start(300, 'v-edge');
        await start(241, 'v-edge'); // 59 min after first sighting: still the wave
        await start(239, 'v-edge'); // 61 min after: a crash
        await start(100, 'v-edge'); // a crash

        const rows = await load();

        expect(rows).toHaveLength(1);
        expect(rows[0].cnt).toBe(2);
    });

    it('never excuses a row without a version, and groups per instance', async () => {
        await start(500, null);
        await start(300, null);
        await start(400, null, 'restart_unclean', 'test-unclean-other');

        const rows = await load();

        expect(rows.map((r) => [r.instanceId, r.cnt])).toEqual([[INSTANCE, 2]]);
    });
});

describe('attention.queries — cleanupResolvedAlerts (retention, §5.5)', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'test:%'`;
    });

    it('deletes only resolved rows older than the retention window, never active/acked ones', async () => {
        await upsertAlerts(sql, [
            up({ id: 'test:ret:old' }),
            up({ id: 'test:ret:young' }),
            up({ id: 'test:ret:acked' }),
        ]);
        await resolveAlerts(sql, ['test:ret:old', 'test:ret:young']);
        await ackAlert(sql, 'test:ret:acked', 'open:5', 'denis');

        // Backdate the old resolved row past the retention window; the other
        // resolved row stays fresh, and the acked row is never resolved at all.
        await sql`
            UPDATE admin_attention_alerts
               SET resolved_at = now() - INTERVAL '45 days'
             WHERE id = 'test:ret:old'
        `;

        const result = await cleanupResolvedAlerts(sql);
        expect(result.deletedByAge).toBe(1);
        expect(result.deletedByCap).toBe(0);

        const remaining = (await readAllAlerts(sql))
            .filter((r) => r.id.startsWith('test:ret:'))
            .map((r) => r.id)
            .sort();
        // The acked row (never resolved) and the fresh resolved row survive;
        // only the aged-out resolved row is gone.
        expect(remaining).toEqual(['test:ret:acked', 'test:ret:young']);
    });

    it('caps resolved history at RESOLVED_ALERT_HISTORY_CAP rows, evicting the oldest first', async () => {
        // This suite shares `admin_attention_alerts` with other integration
        // suites that may be resolving their own alerts "now" concurrently,
        // and the cap sweep is deliberately table-wide (not prefix-scoped —
        // that's the real behaviour under test). Rather than assume this
        // batch is the only resolved data in the table, backdate it a full
        // day into the past (so it is unambiguously older than anything
        // another suite resolves around the same wall-clock moment) and
        // derive the expected eviction count from the actual pre-cleanup
        // total instead of hardcoding it.
        const EXTRA = 5;
        const total = RESOLVED_ALERT_HISTORY_CAP + EXTRA;
        const items = Array.from({ length: total }, (_, i) =>
            up({ id: `test:cap:${String(i).padStart(4, '0')}`, fingerprint: `open:${i}` }),
        );
        await upsertAlerts(sql, items);
        await resolveAlerts(
            sql,
            items.map((i) => i.id),
        );

        // Spread resolved_at across distinct, strictly increasing minutes so
        // oldest-first eviction is deterministic within this batch: id index
        // 0 is the oldest, index `total - 1` the newest — all still well
        // inside the 30-day age window, so only the cap pass fires.
        await sql`
            UPDATE admin_attention_alerts a
               SET resolved_at = now() - INTERVAL '1 day'
                                - (${total}::int - (right(a.id, 4))::int) * INTERVAL '1 minute'
             WHERE a.id LIKE 'test:cap:%'
        `;

        const [{ count: totalResolvedBefore }] = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM admin_attention_alerts WHERE status = 'resolved'
        `;
        const expectedDeleted = Math.max(0, totalResolvedBefore - RESOLVED_ALERT_HISTORY_CAP);

        const result = await cleanupResolvedAlerts(sql);
        expect(result.deletedByAge).toBe(0);
        expect(result.deletedByCap).toBe(expectedDeleted);

        const remaining = (await readAllAlerts(sql))
            .filter((r) => r.id.startsWith('test:cap:'))
            .map((r) => r.id);
        expect(remaining).toHaveLength(total - expectedDeleted);
        // Whatever got evicted must be a contiguous oldest-prefix of this batch.
        for (let i = 0; i < expectedDeleted; i++) {
            expect(remaining).not.toContain(`test:cap:${String(i).padStart(4, '0')}`);
        }
        for (let i = expectedDeleted; i < total; i++) {
            expect(remaining).toContain(`test:cap:${String(i).padStart(4, '0')}`);
        }
    });

    it('leaves a resolved row alone when it is neither aged out nor over the cap', async () => {
        await upsertAlerts(sql, [up({ id: 'test:ret:keep' })]);
        await resolveAlerts(sql, ['test:ret:keep']);

        const result = await cleanupResolvedAlerts(sql);
        expect(result.deletedByAge).toBe(0);
        expect(result.deletedByCap).toBe(0);

        const remaining = (await readAllAlerts(sql)).filter((r) => r.id === 'test:ret:keep');
        expect(remaining).toHaveLength(1);
    });
});

describe('attention.queries — loadJellyfinUnlinkedUsers', () => {
    let sql: postgres.Sql;
    const JELLYFIN = 'jellyfin-watch-sync';

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await sql`DELETE FROM task_history WHERE task_id = 'watch-sync-pull'`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id = 'watch-sync-pull'`;
    });

    /** A finished watch-sync-pull run that completed `minutesAgo`, with this task meta. */
    async function pullRun(
        id: string,
        opts: { minutesAgo: number; state?: string; meta: postgres.JSONValue },
    ): Promise<void> {
        const completedAt = new Date(Date.now() - opts.minutesAgo * 60_000);
        await sql`
            INSERT INTO task_history (
                id, task_id, label, state, input, scope, trigger, actor,
                started_at, completed_at, processing_version, result
            ) VALUES (
                ${id}, 'watch-sync-pull', 'Watch sync pull', ${opts.state ?? 'completed'},
                ${sql.json({})}, ${sql.json({})},
                ${sql.json({ kind: 'schedule' })}, ${sql.json({ kind: 'system' })},
                ${new Date(completedAt.getTime() - 30_000)}, ${completedAt}, '1',
                ${sql.json({ success: true, result: { summary: 'Pull', meta: opts.meta } })}
            )
        `;
    }

    /** Task meta for a run that pulled Jellyfin and skipped `names` (count defaults to their length). */
    function jellyfinMeta(names: string[], count = names.length): postgres.JSONValue {
        return {
            usersSkippedNoLumastraAccount: count,
            skippedNoLumastraAccountByProvider: { [JELLYFIN]: names },
            skippedNoLumastraAccountCountByProvider: { [JELLYFIN]: count },
        };
    }

    it('reports the Jellyfin accounts the newest pull skipped', async () => {
        await pullRun('test-jfu-old', { minutesAgo: 20, meta: jellyfinMeta(['alice']) });
        await pullRun('test-jfu-new', { minutesAgo: 5, meta: jellyfinMeta(['alice', 'bob']) });

        expect(await loadJellyfinUnlinkedUsers(sql)).toEqual({ count: 2, names: ['alice', 'bob'] });
    });

    it('keeps the notice when a newer pull did not run Jellyfin', async () => {
        await pullRun('test-jfu-jf', { minutesAgo: 20, meta: jellyfinMeta(['alice']) });
        await pullRun('test-jfu-other', {
            minutesAgo: 5,
            meta: {
                usersSkippedNoLumastraAccount: 0,
                skippedNoLumastraAccountByProvider: { trakt: [] },
                skippedNoLumastraAccountCountByProvider: { trakt: 0 },
            },
        });

        expect(await loadJellyfinUnlinkedUsers(sql)).toEqual({ count: 1, names: ['alice'] });
    });

    it('keeps the last good notice across user-list failures until a real pull clears it', async () => {
        const { watchSyncEngine } = await import('../../services/watch-sync-engine.service.js');
        const { watchSyncPullTask } = await import('../../tasks/builtin/native/watch-sync-pull.js');
        const runPull = vi.spyOn(watchSyncEngine, 'runPull');
        try {
            await pullRun('test-jfu-good', { minutesAgo: 20, meta: jellyfinMeta(['alice']) });
            for (const [index, pulled] of [false, false, true].entries()) {
                // A /Users failure in the linked-users gate is a graceful skip;
                // the overall task completes, but its Jellyfin account list is unknown.
                runPull.mockResolvedValueOnce([
                    {
                        provider: JELLYFIN,
                        pulled,
                        movies: { imported: 0, skipped: 0 },
                        episodes: { imported: 0, skipped: 0, seriesResolved: 0 },
                        resumeItems: { imported: 0, skipped: 0 },
                        totalFromProvider: 0,
                        totalResolved: 0,
                        totalUpserted: 0,
                        totalSkippedNoMatch: 0,
                        totalBuffered: 0,
                        usersSkippedNoLumastraAccount: 0,
                        skippedUnavailable: false,
                        errors: [],
                        durationMs: 0,
                    },
                ]);
                const output = await watchSyncPullTask.execute(
                    mockContext<Record<string, unknown>>({ sql, input: {} }),
                );
                expect(output.success).toBe(true);
                expect(output.result).toBeDefined();
                await pullRun(`test-jfu-attempt-${index}`, {
                    minutesAgo: 10 - index,
                    meta: JSON.parse(JSON.stringify(output.result!.meta)) as postgres.JSONValue,
                });

                expect(await loadJellyfinUnlinkedUsers(sql)).toEqual(
                    pulled ? { count: 0, names: [] } : { count: 1, names: ['alice'] },
                );
            }
        } finally {
            runPull.mockRestore();
        }
    });

    it('clears the notice once a pull that ran Jellyfin skipped nobody', async () => {
        await pullRun('test-jfu-jf-old', { minutesAgo: 20, meta: jellyfinMeta(['alice']) });
        await pullRun('test-jfu-jf-new', { minutesAgo: 5, meta: jellyfinMeta([]) });

        expect(await loadJellyfinUnlinkedUsers(sql)).toEqual({ count: 0, names: [] });
    });

    it('reads only the Jellyfin list, never another provider', async () => {
        await pullRun('test-jfu-mixed', {
            minutesAgo: 5,
            meta: {
                usersSkippedNoLumastraAccount: 3,
                skippedNoLumastraAccountByProvider: {
                    trakt: ['bob', 'carol'],
                    [JELLYFIN]: ['alice'],
                },
                skippedNoLumastraAccountCountByProvider: { trakt: 2, [JELLYFIN]: 1 },
            },
        });

        expect(await loadJellyfinUnlinkedUsers(sql)).toEqual({ count: 1, names: ['alice'] });
    });

    it('reports the true count when the stored names are capped', async () => {
        const names = Array.from({ length: 50 }, (_, i) => `user-${i}`);
        await pullRun('test-jfu-capped', { minutesAgo: 5, meta: jellyfinMeta(names, 60) });

        const result = await loadJellyfinUnlinkedUsers(sql);

        expect(result.count).toBe(60);
        expect(result.names).toHaveLength(50);
    });

    it('ignores runs older than an hour and runs that did not complete', async () => {
        await pullRun('test-jfu-stale', { minutesAgo: 90, meta: jellyfinMeta(['alice']) });
        await pullRun('test-jfu-failed', {
            minutesAgo: 5,
            state: 'failed',
            meta: jellyfinMeta(['bob']),
        });

        expect(await loadJellyfinUnlinkedUsers(sql)).toEqual({ count: 0, names: [] });
    });
});
