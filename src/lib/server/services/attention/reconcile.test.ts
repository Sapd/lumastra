// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { projectPersisted, reconcile } from './reconcile.js';
import { adaptIntegrity, adaptMusicHygiene } from './adapters.js';
import { countBucket } from './count-bucket.js';
import {
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
} from '$lib/shared/music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';
import type { AlertRow, AttentionRenderMap, DerivedAlert } from './types.js';

const NOW = '2026-06-05T12:00:00.000Z';

function derived(over: Partial<DerivedAlert> = {}): DerivedAlert {
    return {
        id: 'circuit:metadata-sync',
        fingerprint: 'open:5',
        type: 'circuit-open',
        domain: 'tasks',
        severity: 'critical',
        title: 'metadata-sync circuit open',
        actions: [],
        ...over,
    };
}

function row(over: Partial<AlertRow> = {}): AlertRow {
    return {
        id: 'circuit:metadata-sync',
        fingerprint: 'open:5',
        type: 'circuit-open',
        domain: 'tasks',
        severity: 'critical',
        title: 'metadata-sync circuit open',
        detail: null,
        source_ref: null,
        status: 'active',
        first_seen: '2026-06-05T11:00:00.000Z',
        last_seen: '2026-06-05T11:59:00.000Z',
        acked_at: null,
        acked_by: null,
        acked_fingerprint: null,
        count: null,
        acked_count: null,
        count_first: null,
        count_prev: null,
        snoozed_until: null,
        resolved_at: null,
        ...over,
    };
}

describe('reconcile', () => {
    it('preserves first_seen for an existing item and refreshes last_seen', () => {
        const r = reconcile([derived()], [row()], NOW);
        expect(r.upserts[0].first_seen).toBe('2026-06-05T11:00:00.000Z');
        expect(r.upserts[0].last_seen).toBe(NOW);
        expect(r.items[0].firstSeen).toBe('2026-06-05T11:00:00.000Z');
    });

    it('uses now for first_seen of a brand-new item', () => {
        const r = reconcile([derived()], [], NOW);
        expect(r.upserts[0].first_seen).toBe(NOW);
        expect(r.upserts[0].status).toBe('active');
    });

    it('marks gone items resolved', () => {
        const r = reconcile([], [row({ status: 'active' })], NOW);
        expect(r.resolveIds).toEqual(['circuit:metadata-sync']);
        expect(r.items).toHaveLength(0);
    });

    it('carries an ack when fingerprint is unchanged', () => {
        const acked = row({
            status: 'acked',
            acked_fingerprint: 'open:5',
            acked_by: 'denis',
        });
        const r = reconcile([derived({ fingerprint: 'open:5' })], [acked], NOW);
        expect(r.upserts[0].status).toBe('acked');
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    it('reopens an acknowledged quarantine backlog when age escalates severity at count one', () => {
        const counts = { 'quarantine-backlog-large': 1 };
        const [young] = adaptIntegrity(counts, { 'quarantine-backlog-large': 'low' });
        const prior = row({
            id: young.id,
            type: young.type,
            severity: young.severity,
            fingerprint: young.fingerprint,
            status: 'acked',
            count: 1,
            acked_count: 1,
            acked_fingerprint: young.fingerprint,
            acked_at: NOW,
            acked_by: 'admin',
        });
        const aged = adaptIntegrity(counts, { 'quarantine-backlog-large': 'medium' });
        const result = reconcile(aged, [prior], NOW);
        expect(result.items[0]).toMatchObject({ severity: 'warning', acked: false });
        expect(result.unreadCount).toBe(1);
        expect(result.verdict).toBe('degraded');
        expect(result.upserts[0]).toMatchObject({
            status: 'active',
            acked_at: null,
            acked_by: null,
            acked_count: null,
            acked_fingerprint: null,
        });
    });

    it('clears an ack when fingerprint changed (incident materially changed)', () => {
        const acked = row({ status: 'acked', acked_fingerprint: 'open:5' });
        const r = reconcile([derived({ fingerprint: 'open:9' })], [acked], NOW);
        expect(r.upserts[0].status).toBe('active');
        expect(r.items[0].acked).toBe(false);
        expect(r.unreadCount).toBe(1);
    });

    // ── Count-watermark ack (dead-letter / stuck / failed-run-spike) ──────────
    // A count-bearing alert holds its ack against the acked_count watermark, not the
    // coarse count-band fingerprint, so new members re-surface and draining ones don't.
    const dlAcked = (acked_count: number, over = {}) =>
        row({
            id: 'dead-letter:probe',
            type: 'dead-letter',
            status: 'acked',
            acked_fingerprint: '2-5',
            acked_count,
            ...over,
        });
    // The real band function, not a copy of it. A local re-implementation kept
    // passing when `COUNT_BUCKETS` grew past `100+` while the adapter it claims to
    // mirror had moved — the count-watermark path ignores the fingerprint, so the
    // divergence would have been silent in exactly the fixtures built from it.
    const band = (n: number): string => countBucket(n);
    const dlDerived = (count: number) =>
        derived({
            id: 'dead-letter:probe',
            type: 'dead-letter',
            fingerprint: band(count),
            count,
        });

    it('holds a count-ack while the count stays at or below the watermark', () => {
        // Acked 3 items; one drains to 2 — still within the band but, more importantly,
        // 2 <= 3, so the ack holds.
        const r = reconcile([dlDerived(2)], [dlAcked(3)], NOW);
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
        expect(r.upserts[0].acked_count).toBe(3); // watermark preserved
        expect(r.upserts[0].count).toBe(2); // live count refreshed
    });

    it('re-surfaces when a NEW member pushes the count past the watermark (same band)', () => {
        // Acked 3, a 4th unrelated item dead-letters → still band "2-5" (fingerprint
        // unchanged) but 4 > 3 → the old count-band scheme would have silently absorbed
        // it; the watermark drops the ack.
        const r = reconcile([dlDerived(4)], [dlAcked(3)], NOW);
        expect(r.items[0].acked).toBe(false);
        expect(r.unreadCount).toBe(1);
        expect(r.upserts[0].acked_count).toBeNull();
    });

    it('does NOT re-surface on improvement even when the band drops', () => {
        // Acked 6 (band "6-20"), operator fixes 5 → count 1 (band "1"): fingerprint
        // changed, but 1 <= 6 so the ack holds — fixing things must not re-ring the bell.
        const r = reconcile([dlDerived(1)], [dlAcked(6, { acked_fingerprint: '6-20' })], NOW);
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    it('count-ack with a null watermark falls through to active (pre-migration row)', () => {
        // A row acked before acked_count existed: cannot hold the watermark, so it
        // re-activates once (operator re-acks → watermark populated).
        const r = reconcile([dlDerived(3)], [dlAcked(null as unknown as number)], NOW);
        expect(r.items[0].acked).toBe(false);
    });

    it('verdict is critical for an unacked critical, ignores info', () => {
        const info = derived({
            id: 'setup:1',
            type: 'setup-incomplete',
            severity: 'info',
            fingerprint: 'x',
        });
        expect(reconcile([derived(), info], [], NOW).verdict).toBe('critical');
        expect(reconcile([info], [], NOW).verdict).toBe('healthy');
    });

    it('verdict is degraded for an unacked warning only', () => {
        const warn = derived({
            id: 'stuck:probe',
            type: 'stuck-items',
            severity: 'warning',
            fingerprint: 'w',
        });
        expect(reconcile([warn], [], NOW).verdict).toBe('degraded');
    });

    it('sorts items critical-first', () => {
        const warn = derived({
            id: 'stuck:probe',
            severity: 'warning',
            fingerprint: 'w',
        });
        const r = reconcile([warn, derived()], [], NOW);
        expect(r.items[0].severity).toBe('critical');
    });

    it('does NOT re-resolve an already-resolved gone item', () => {
        const r = reconcile([], [row({ status: 'resolved' })], NOW);
        expect(r.resolveIds).toEqual([]);
    });

    it('does NOT resolve a gone item under a protected prefix; carries it forward as a last-known item', () => {
        // Simulates the circuit signal source failing: its alert is absent from the
        // derivation, but "couldn't read" must not be mistaken for "resolved".
        const r = reconcile(
            [],
            [
                row({
                    status: 'active',
                    source_ref: '/admin/tasks/x',
                }),
            ],
            NOW,
            ['circuit:'],
        );
        expect(r.resolveIds).toEqual([]);
        expect(r.items).toHaveLength(1);
        expect(r.items[0].id).toBe('circuit:metadata-sync');
        // Synthesised investigate action keeps the carried-forward item actionable.
        expect(r.items[0].actions[0]).toMatchObject({
            kind: 'investigate',
            href: '/admin/tasks/x',
        });
        expect(r.verdict).toBe('critical');
    });

    it('still resolves a gone item whose prefix is NOT protected', () => {
        const r = reconcile([], [row({ status: 'active' })], NOW, ['dead-letter:']);
        expect(r.resolveIds).toEqual(['circuit:metadata-sync']);
        expect(r.items).toHaveLength(0);
    });

    it('carries forward a protected acked item as acked', () => {
        const acked = row({
            status: 'acked',
            source_ref: '/admin/tasks',
        });
        const r = reconcile([], [acked], NOW, ['circuit:']);
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    it('suppresses a snoozed item from unread/verdict but still lists it (snoozed flag set)', () => {
        const FUTURE = '2026-06-05T13:00:00.000Z'; // > NOW
        const snoozed = row({ snoozed_until: FUTURE });
        const r = reconcile([derived()], [snoozed], NOW);
        expect(r.items[0].snoozed).toBe(true);
        expect(r.items[0].snoozedUntil).toBe(FUTURE);
        expect(r.unreadCount).toBe(0);
        expect(r.verdict).toBe('healthy'); // a snoozed critical does not drive the verdict
        expect(r.upserts[0].snoozed_until).toBe(FUTURE); // carried through
    });

    it('an expired snooze does not suppress (and is cleared in the upsert)', () => {
        const PAST = '2026-06-05T11:30:00.000Z'; // < NOW
        const r = reconcile([derived()], [row({ snoozed_until: PAST })], NOW);
        expect(r.items[0].snoozed).toBe(false);
        expect(r.unreadCount).toBe(1);
        expect(r.upserts[0].snoozed_until).toBeNull();
    });

    it('a severity escalation defeats an active snooze (re-surfaces immediately)', () => {
        const FUTURE = '2026-06-05T13:00:00.000Z';
        // Prior was a warning, snoozed; the new derivation is critical → escalation.
        const priorWarn = row({ severity: 'warning', snoozed_until: FUTURE });
        const r = reconcile([derived({ severity: 'critical' })], [priorWarn], NOW);
        expect(r.items[0].snoozed).toBe(false);
        expect(r.unreadCount).toBe(1);
        expect(r.verdict).toBe('critical');
        expect(r.upserts[0].snoozed_until).toBeNull();
    });

    it('snooze (unlike ack) survives a fingerprint change', () => {
        const FUTURE = '2026-06-05T13:00:00.000Z';
        const snoozed = row({ fingerprint: 'open', snoozed_until: FUTURE });
        const r = reconcile([derived({ fingerprint: 'open-changed' })], [snoozed], NOW);
        expect(r.items[0].snoozed).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    it('Fix 15 — snooze is NOT carried forward when the prior row was resolved', () => {
        const FUTURE = '2026-06-05T13:00:00.000Z'; // > NOW
        // A prior row that is resolved AND had a snoozed_until set.
        const resolvedSnoozed = row({
            status: 'resolved',
            snoozed_until: FUTURE,
        });
        // The same alert re-fires in this derivation cycle.
        const r = reconcile([derived()], [resolvedSnoozed], NOW);
        // The re-fired alert must NOT inherit the snooze from a resolved incarnation.
        expect(r.upserts[0].snoozed_until).toBeNull();
        expect(r.items[0].snoozed).toBe(false);
        // The alert should be active and visible in the unread count.
        expect(r.unreadCount).toBe(1);
    });

    it('tolerates an unknown severity (corrupt row) without NaN sort/escalation', () => {
        // A severity absent from the rank map must sort last and not break escalation logic.
        const weird = derived({
            id: 'x:weird',
            severity: 'bogus' as never,
            fingerprint: 'f',
        });
        const r = reconcile([derived(), weird], [], NOW);
        expect(r.items).toHaveLength(2);
        expect(r.items[0].severity).toBe('critical'); // known critical sorts before unknown
        expect(r.items[r.items.length - 1].id).toBe('x:weird'); // unknown last, no NaN scramble
    });

    it('preserves acked_at and acked_by in the upsert when carrying an ack', () => {
        const acked = row({
            status: 'acked',
            acked_fingerprint: 'open:5',
            acked_at: '2026-06-05T11:30:00.000Z',
            acked_by: 'denis',
        });
        const r = reconcile([derived({ fingerprint: 'open:5' })], [acked], NOW);
        expect(r.upserts[0].acked_at).toBe('2026-06-05T11:30:00.000Z');
        expect(r.upserts[0].acked_by).toBe('denis');
        expect(r.upserts[0].acked_fingerprint).toBe('open:5');
    });

    it('resets first_seen to nowIso when the prior row was resolved (re-fire after resolution)', () => {
        // A re-fired alert must start its own incarnation clock fresh so the grace
        // window does not inherit the prior incident's elapsed time.
        const resolvedPrior = row({
            status: 'resolved',
            first_seen: '2026-06-05T10:00:00.000Z', // an hour ago
        });
        const r = reconcile([derived()], [resolvedPrior], NOW);
        // first_seen must be NOW (current incarnation start), not the old incident time.
        expect(r.upserts[0].first_seen).toBe(NOW);
        expect(r.items[0].firstSeen).toBe(NOW);
    });
});

// ── Alert grace (class-no-leader / subsystem-dead) ───────────────────────────
//
// For liveness-bridge alerts in the `tasks:` namespace carrying the
// `class-no-leader` or `subsystem-dead` fingerprint (= HealthReason.code),
// severity is held at `warning` during a 2-minute grace window and only
// escalates to `critical` on sustained absence.
//
// Flap semantics: absent → present → absent → present resets first_seen each
// time the alert re-fires after resolution, so a flapping condition can never
// accumulate enough elapsed time to cross the grace threshold.

describe('reconcile — alert grace (class-no-leader / subsystem-dead)', () => {
    // Simulate a liveness alert as adaptTaskLiveness would emit it (the bridge
    // namespaces leader/heartbeat conditions under `tasks:`).
    const livenessAlert = (code: string): DerivedAlert => ({
        id: `tasks:leader:${code === 'class-no-leader' ? 'embedding' : 'reconciler'}`,
        fingerprint: code,
        type: 'degraded-component',
        domain: 'tasks',
        severity: 'critical',
        title:
            code === 'class-no-leader'
                ? 'No leader elected for resource class `embedding`.'
                : 'reconciler has no heartbeat.',
        actions: [
            {
                kind: 'investigate',
                label: 'View System Health',
                href: '/admin/system/health#components',
            },
        ],
    });

    // A liveness row stored as active since `first_seen`.
    const livenessRow = (
        code: string,
        firstSeenIso: string,
        status: AlertRow['status'] = 'active',
    ): AlertRow => ({
        id: `tasks:leader:${code === 'class-no-leader' ? 'embedding' : 'reconciler'}`,
        fingerprint: code,
        type: 'degraded-component',
        domain: 'tasks',
        severity: 'critical',
        title: 'No leader elected.',
        detail: null,
        source_ref: '/admin/system/health#components',
        status,
        first_seen: firstSeenIso,
        last_seen: firstSeenIso,
        acked_at: null,
        acked_by: null,
        acked_fingerprint: null,
        count: null,
        acked_count: null,
        count_first: null,
        count_prev: null,
        snoozed_until: null,
        resolved_at: null,
    });

    it.each([
        { firstSeen: '2026-06-05T11:59:30.000Z', severity: 'warning', acked: true },
        { firstSeen: '2026-06-05T11:57:00.000Z', severity: 'critical', acked: false },
    ])(
        'holds an ack during grace and clears it on effective escalation: $severity',
        ({ firstSeen, severity, acked }) => {
            const prior = {
                ...livenessRow('class-no-leader', firstSeen, 'acked'),
                severity: 'warning' as const,
                acked_at: firstSeen,
                acked_by: 'admin',
                acked_fingerprint: 'class-no-leader',
            };
            const result = reconcile([livenessAlert('class-no-leader')], [prior], NOW);
            expect(result.items[0]).toMatchObject({ severity, acked });
            expect(result.upserts[0].status).toBe(acked ? 'acked' : 'active');
        },
    );

    it('(a) transient flap — a re-fired grace-eligible alert after resolution stays warning, never critical', () => {
        // The leader was absent, resolved (re-acquired), then absent again.
        // The re-fire should see first_seen = NOW (reset) → age = 0 → grace active → warning.
        const resolvedPrior = livenessRow(
            'class-no-leader',
            '2026-06-05T10:00:00.000Z',
            'resolved',
        );
        // NOW = '2026-06-05T12:00:00.000Z' — 2h after old first_seen, well past grace if inherited.
        const r = reconcile([livenessAlert('class-no-leader')], [resolvedPrior], NOW);

        expect(r.items).toHaveLength(1);
        // Grace is active because first_seen was reset to NOW → age = 0 < 120 000ms.
        expect(r.items[0].severity).toBe('warning');
        expect(r.upserts[0].severity).toBe('warning');
        expect(r.verdict).toBe('degraded'); // not critical
        // first_seen must be NOW (current incarnation), not the 10:00 resolved one.
        expect(r.upserts[0].first_seen).toBe(NOW);
    });

    it('(a) transient flap — multiple flaps never accumulate elapsed time across incarnations', () => {
        // Simulate the second re-fire in a series: resolved prior with very old first_seen.
        const VERY_OLD = '2026-06-04T00:00:00.000Z'; // >24h before NOW
        const resolvedPrior = livenessRow('subsystem-dead', VERY_OLD, 'resolved');
        const r = reconcile([livenessAlert('subsystem-dead')], [resolvedPrior], NOW);

        // Even though the old first_seen is >24h ago, re-fire after resolve → reset → warning.
        expect(r.items[0].severity).toBe('warning');
        expect(r.upserts[0].first_seen).toBe(NOW);
    });

    it('(b) sustained absence — escalates to critical after the grace window (> 2 min)', () => {
        // first_seen is 3 minutes before NOW → activeMs = 180 000ms > 120 000ms → critical.
        const THREE_MIN_AGO = '2026-06-05T11:57:00.000Z';
        const activeRow = livenessRow('class-no-leader', THREE_MIN_AGO, 'active');
        const r = reconcile([livenessAlert('class-no-leader')], [activeRow], NOW);

        expect(r.items[0].severity).toBe('critical');
        expect(r.upserts[0].severity).toBe('critical');
        expect(r.verdict).toBe('critical');
        // first_seen is preserved (continuous active — no reset).
        expect(r.upserts[0].first_seen).toBe(THREE_MIN_AGO);
    });

    it('(b) sustained absence — first second of the grace window is still warning (boundary)', () => {
        // first_seen = exactly 2 minutes before NOW → activeMs = 120 000ms = GRACE → NOT graced.
        const EXACTLY_TWO_MIN_AGO = '2026-06-05T11:58:00.000Z';
        const activeRow = livenessRow('class-no-leader', EXACTLY_TWO_MIN_AGO, 'active');
        const r = reconcile([livenessAlert('class-no-leader')], [activeRow], NOW);
        // activeMs === ALERT_GRACE_MS (not strictly less-than) → critical.
        expect(r.items[0].severity).toBe('critical');
    });

    it('(b) sustained absence — just inside the grace window stays warning (boundary)', () => {
        // first_seen = 1 minute 59 seconds before NOW → activeMs = 119 000ms < 120 000ms → warning.
        const JUST_INSIDE = '2026-06-05T11:58:01.000Z';
        const activeRow = livenessRow('class-no-leader', JUST_INSIDE, 'active');
        const r = reconcile([livenessAlert('class-no-leader')], [activeRow], NOW);
        expect(r.items[0].severity).toBe('warning');
    });

    it('grace does NOT apply outside the `tasks:` namespace (circuit-open unaffected)', () => {
        // A circuit:metadata-sync alert with fingerprint 'open' must never be graced.
        const circuitDerived = derived({ fingerprint: 'open', severity: 'critical' });
        const circuitRow = row({ status: 'active', first_seen: NOW }); // fresh
        const r = reconcile([circuitDerived], [circuitRow], NOW);
        expect(r.items[0].severity).toBe('critical');
    });

    it('grace does NOT apply to subsystem-degraded (only subsystem-dead and class-no-leader)', () => {
        const degradedAlert: DerivedAlert = {
            id: 'tasks:reconciler',
            fingerprint: 'subsystem-degraded',
            type: 'degraded-component',
            severity: 'warning', // degraded is already warning — grace irrelevant
            title: 'reconciler is degraded.',
            actions: [],
        };
        const r = reconcile([degradedAlert], [], NOW);
        expect(r.items[0].severity).toBe('warning');
    });

    it('grace does NOT apply to a brand-new class-no-leader alert WITHOUT the `tasks:` prefix', () => {
        // Ensure the id prefix guard works: same fingerprint under a different id namespace.
        const nonLiveness: DerivedAlert = {
            id: 'other-namespace:leader:embedding',
            fingerprint: 'class-no-leader',
            type: 'degraded-component',
            severity: 'critical',
            title: 'No leader.',
            actions: [],
        };
        const r = reconcile([nonLiveness], [], NOW);
        // No prior row -> firstSeen = NOW -> age = 0ms, BUT the id is not in the
        // liveness `tasks:` namespace -> not graced. Guards the prefix itself:
        // if the grace check ever matched everything, this would go warning.
        expect(r.items[0].severity).toBe('critical');
    });
});

describe('projectPersisted (read path)', () => {
    it('drops resolved rows — they belong to resolvedHistory, not the board', () => {
        const p = projectPersisted(
            [
                row({ id: 'a:1', status: 'active' }),
                row({ id: 'a:2', status: 'resolved', resolved_at: NOW }),
            ],
            NOW,
        );
        expect(p.items.map((i) => i.id)).toEqual(['a:1']);
    });

    it('computes the same verdict/unread rules reconcile does', () => {
        const p = projectPersisted(
            [
                row({ id: 'a:info', severity: 'info' }),
                row({ id: 'a:warn', severity: 'warning' }),
                row({ id: 'a:crit', severity: 'critical' }),
            ],
            NOW,
        );
        expect(p.verdict).toBe('critical');
        expect(p.unreadCount).toBe(3);
        // Sorted critical → warning → info, same as reconcile.
        expect(p.items.map((i) => i.id)).toEqual(['a:crit', 'a:warn', 'a:info']);
    });

    it('an acked or snoozed row leaves the badge but stays on the board', () => {
        const p = projectPersisted(
            [
                row({ id: 'a:acked', status: 'acked' }),
                row({
                    id: 'a:snoozed',
                    severity: 'warning',
                    snoozed_until: '2026-06-05T13:00:00.000Z',
                }),
            ],
            NOW,
        );
        expect(p.items).toHaveLength(2);
        expect(p.unreadCount).toBe(0);
        expect(p.verdict).toBe('healthy');
    });

    it('overlays the sidecar actions/term when the fingerprint still matches', () => {
        const render: AttentionRenderMap = {
            'circuit:metadata-sync': {
                fingerprint: 'open:5',
                order: 0,
                term: 'circuit-breaker',
                actions: [{ kind: 'reset-circuit', label: 'Reset', taskId: 'metadata-sync' }],
            },
        };
        const p = projectPersisted([row({ source_ref: '/admin/tasks' })], NOW, render);
        expect(p.items[0].actions).toEqual([
            { kind: 'reset-circuit', label: 'Reset', taskId: 'metadata-sync' },
        ]);
        expect(p.items[0].term).toBe('circuit-breaker');
    });

    it('discards a sidecar entry whose fingerprint went stale — the incident changed', () => {
        const render: AttentionRenderMap = {
            'circuit:metadata-sync': {
                fingerprint: 'open:2',
                order: 0,
                actions: [{ kind: 'retry-item', label: 'Retry', itemId: 'gone' }],
            },
        };
        const p = projectPersisted(
            [row({ fingerprint: 'open:5', source_ref: '/admin/tasks' })],
            NOW,
            render,
        );
        // Falls back to itemFromRow's synthesised investigate action.
        expect(p.items[0].actions).toEqual([
            { kind: 'investigate', label: 'Investigate', href: '/admin/tasks' },
        ]);
        expect(p.items[0].term).toBeUndefined();
    });

    it('reproduces derivation order within a severity band, unrendered ids last', () => {
        const render: AttentionRenderMap = {
            'a:second': { fingerprint: 'f', order: 1, actions: [] },
            'a:first': { fingerprint: 'f', order: 0, actions: [] },
        };
        const p = projectPersisted(
            [
                row({ id: 'a:unrendered', fingerprint: 'f' }),
                row({ id: 'a:second', fingerprint: 'f' }),
                row({ id: 'a:first', fingerprint: 'f' }),
            ],
            NOW,
            render,
        );
        expect(p.items.map((i) => i.id)).toEqual(['a:first', 'a:second', 'a:unrendered']);
    });

    it('an empty table reads healthy with no items', () => {
        const p = projectPersisted([], NOW);
        expect(p).toEqual({ items: [], unreadCount: 0, verdict: 'healthy' });
    });
});

/**
 * Music hygiene acks, asserted at the reconcile seam rather than left as a
 * property of a comment in the adapter.
 *
 * `count` is not a display field. Its PRESENCE switches `reconcile` from
 * fingerprint-equality ack to a count WATERMARK (`d.count <=
 * prior.acked_count`), which was designed for drainable populations —
 * dead-letter rows, stuck items. A tagging backlog does not drain, so under a
 * watermark an operator who acks "1,234 track titles match their file name"
 * would have that ack dropped the next time a scan imported ONE untagged track,
 * forever.
 *
 * `adaptMusicHygiene` therefore omits `count`. These two cases pin both halves:
 * the omission itself, and the behaviour that omission buys.
 */
describe('reconcile + adaptMusicHygiene ack semantics', () => {
    it('retires old filename-provenance attention instead of manufacturing a review', () => {
        const prior = row({ id: 'music-hygiene:music-title-from-filename', type: 'music-hygiene' });
        const current = adaptMusicHygiene(counts(MUSIC_HYGIENE_TITLE_FROM_FILENAME, 4000));
        const result = reconcile(current, [prior], NOW);
        expect(current).toEqual([]);
        expect(result.resolveIds).toContain(prior.id);
    });
    function counts(finding: string, n: number): MusicHygieneCounts {
        const out = {} as MusicHygieneCounts;
        for (const f of MUSIC_HYGIENE_FINDINGS) out[f] = 0;
        out[finding as keyof MusicHygieneCounts] = n;
        return out;
    }

    const hygieneAlert = (n: number): DerivedAlert => {
        const [alert] = adaptMusicHygiene(counts(MUSIC_HYGIENE_TRACK_NO_ARTIST, n));
        return alert;
    };

    /** An ack row as `ackAlert` would write it for a SCALAR (count-less) alert. */
    const ackedRowFor = (alert: DerivedAlert): AlertRow =>
        row({
            id: alert.id,
            type: alert.type,
            domain: alert.domain,
            severity: alert.severity,
            fingerprint: alert.fingerprint,
            status: 'acked',
            acked_fingerprint: alert.fingerprint,
            acked_by: 'denis',
            count: null,
            acked_count: null,
        });

    it('emits no count, so the ack is held by fingerprint rather than a watermark', () => {
        expect(hygieneAlert(1234).count).toBeUndefined();
    });

    /**
     * Revert-check: add `count` back to `adaptMusicHygiene`'s alert and this
     * fails — `d.count != null` with a null `acked_count` drops the ack, and the
     * operator's accepted backlog re-surfaces after a single new track.
     */
    it('holds an operator ack when a scan adds one more untagged track', () => {
        const acked = ackedRowFor(hygieneAlert(1234));
        const r = reconcile([hygieneAlert(1235)], [acked], NOW);

        expect(r.upserts[0].status).toBe('acked');
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    /**
     * The contrast that proves the omission is load-bearing rather than
     * incidental: the SAME alert with a `count` bolted on loses the ack under
     * the same +1, because reconcile switches to the watermark path.
     */
    it('would lose that ack if the alert carried a count', () => {
        const acked = ackedRowFor(hygieneAlert(1234));
        const withCount: DerivedAlert = { ...hygieneAlert(1235), count: 1235 };
        const r = reconcile([withCount], [acked], NOW);

        expect(r.upserts[0].status).toBe('active');
        expect(r.items[0].acked).toBe(false);
        expect(r.unreadCount).toBe(1);
    });

    /**
     * The other direction, which fingerprint EQUALITY got wrong.
     *
     * Growth across a band was covered ("adds one more untagged track" stays
     * inside `100+`, and the count-bearing contrast above shows what a real
     * escalation looks like). SHRINKING across a band boundary was not — and
     * equality is symmetric, so an operator who acked 1,234 (`100+`) and then
     * spent an afternoon re-tagging down to 50 (`21-100`) had the item come
     * back, unacked, BECAUSE the situation improved. The one behaviour a
     * hygiene backlog must never punish is progress.
     *
     * Revert-check (INVERT, not delete): flip `liveRank <= ackedRank` to `>=`
     * in `countBucketDidNotGrow` and this fails while `re-surfaces when the
     * backlog grows past the acked band` below still passes — that pair is what
     * pins the direction. Deleting the `countBucketDidNotGrow` arm from
     * `reconcile` fails this one alone.
     */
    it('holds the ack when the operator re-tags the backlog down a band', () => {
        const acked = ackedRowFor(hygieneAlert(1234)); // '1001-10000'
        const r = reconcile([hygieneAlert(50)], [acked], NOW); // '21-100'

        expect(hygieneAlert(1234).fingerprint).toBe('1001-10000');
        expect(hygieneAlert(50).fingerprint).toBe('21-100');
        expect(r.upserts[0].status).toBe('acked');
        expect(r.items[0].acked).toBe(true);
        expect(r.unreadCount).toBe(0);
    });

    /**
     * The watermark must not ratchet DOWN with the count, or a backlog that dips
     * to `1` and climbs back to `100+` re-fires an ack the operator never
     * withdrew. `acked_fingerprint` is carried forward unchanged, so the ack is
     * still held against the band it was taken at.
     */
    it('keeps the ack held against the band it was taken at, not the shrunken one', () => {
        const acked = ackedRowFor(hygieneAlert(1234)); // acked at '1001-10000'
        const dipped = reconcile([hygieneAlert(1)], [acked], NOW);
        expect(dipped.upserts[0].acked_fingerprint).toBe('1001-10000');

        const recovered = reconcile(
            [hygieneAlert(1234)],
            [
                {
                    ...acked,
                    fingerprint: '1',
                    acked_fingerprint: dipped.upserts[0].acked_fingerprint,
                },
            ],
            NOW,
        );
        expect(recovered.upserts[0].status).toBe('acked');
    });

    /**
     * A material GROWTH still re-surfaces — that is the whole point of banding
     * rather than acking forever, and it is what makes the shrink case above a
     * discriminating assertion instead of "acks never drop".
     */
    it('re-surfaces when the backlog grows past the acked band', () => {
        const acked = ackedRowFor(hygieneAlert(50)); // '21-100'
        const r = reconcile([hygieneAlert(1234)], [acked], NOW); // '1001-10000'

        expect(r.upserts[0].status).toBe('active');
        expect(r.items[0].acked).toBe(false);
        expect(r.unreadCount).toBe(1);
    });

    /**
     * The inertness guarantee at the seam, not just in `count-bucket.test.ts`:
     * a SCALAR fingerprint keeps plain equality, so a circuit that moved from
     * `open` to `half-open` is a different incident and drops the ack.
     */
    it('leaves scalar fingerprints on plain equality', () => {
        const scalar = (fp: string): DerivedAlert => ({
            id: 'circuit:tmdb-sync',
            fingerprint: fp,
            type: 'circuit-open',
            severity: 'warning',
            title: 'circuit',
            actions: [],
        });
        const acked = row({
            id: 'circuit:tmdb-sync',
            type: 'circuit-open',
            severity: 'warning',
            fingerprint: 'open',
            status: 'acked',
            acked_fingerprint: 'open',
            count: null,
            acked_count: null,
        });

        expect(reconcile([scalar('open')], [acked], NOW).upserts[0].status).toBe('acked');
        expect(reconcile([scalar('half-open')], [acked], NOW).upserts[0].status).toBe('active');
    });
});

it('keeps the backup acknowledgement for the same key when first use raises severity', () => {
    const id = 'settings:master-key:generated';
    const prior = row({
        id,
        severity: 'info',
        status: 'acked',
        fingerprint: 'key-1',
        acked_fingerprint: 'key-1',
    });
    const current = derived({ id, severity: 'warning', fingerprint: 'key-1' });
    expect(reconcile([current], [prior], NOW).items[0].acked).toBe(true);
    expect(reconcile([{ ...current, fingerprint: 'key-2' }], [prior], NOW).items[0].acked).toBe(
        false,
    );
});
