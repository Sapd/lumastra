// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    AttentionItem,
    AttentionTrend,
    AttentionSeverity,
    AttentionType,
    AttentionVerdict,
} from '$lib/schemas/api-attention-responses';
import { countBucketDidNotGrow } from './count-bucket.js';
import type {
    AlertRow,
    AttentionRenderMap,
    DerivedAlert,
    PersistedProjection,
    ReconcileResult,
    UpsertAlert,
} from './types.js';

/**
 * Alert grace: `class-no-leader` and `subsystem-dead` reason codes are prone to
 * false-CRITICAL during cold-start or event-loop stalls — the worker is healthy
 * and continuously re-acquires/re-beats between stalls, but the health-check
 * samples during a gap and emits `critical`.  A continuously-absent condition
 * (genuinely no leader / dead subsystem) stays absent for minutes; a flapping
 * one keeps recovering and re-fires with a reset `first_seen` each time.
 *
 * Grace rule: hold the severity at `warning` while the alert has been continuously
 * active for less than ALERT_GRACE_MS.  After the grace window the severity escalates
 * to `critical` (sustained outage confirmed).
 *
 * Applied in `reconcile()` by fingerprint + id prefix so only `adaptTaskLiveness`
 * outputs for these two specific codes are graced — all other alert types are
 * unaffected.
 */
const ALERT_GRACE_MS = 120_000; // 2 minutes

/** Fingerprints (= reason codes) that receive the alert grace. */
const GRACE_FINGERPRINTS = new Set<string>(['class-no-leader', 'subsystem-dead']);

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
};
/** Rank lookup that never yields undefined (a corrupt/unknown severity sorts last,
 *  and can never produce a NaN comparison that breaks sort or the escalation test). */
const rankOf = (s: string): number => SEVERITY_RANK[s] ?? 99;

/** True while a row's snooze window is still open (lexical ISO-UTC compare is safe). */
function snoozeOpen(snoozedUntil: string | null, nowIso: string): boolean {
    return snoozedUntil != null && snoozedUntil > nowIso;
}

/** Rebuild a client-facing item from a persisted row — used for (a) carry-forward when a
 *  source could not be re-derived, and (b) the resolved-history list. Actions/term are not
 *  persisted, so we synthesise a single "investigate" action from source_ref. */
/**
 * Build the trend for one alert, or `undefined` when there is nothing honest to say.
 *
 * Returns undefined for a scalar alert (no count at all) and on the FIRST tick of
 * an incident, where `previous` would have to be invented. Reporting "flat"
 * there would be a claim about a comparison that was never made — the same class
 * of lie as a signpost page implying it checked something.
 *
 * `direction` and `sinceFirst` are both reported because they answer different
 * questions and can disagree: a draining backlog ticks upward sometimes, and
 * showing only the instantaneous direction would read as a regression during a
 * recovery. That disagreement is exactly what an operator staring at a 23-hour-old
 * CRITICAL needs to see.
 */
export function trendFor(
    current: number | null | undefined,
    prev: number | null,
    first: number | null,
): AttentionTrend | undefined {
    if (current === null || current === undefined) return undefined;
    if (prev === null || first === null) return undefined;
    return {
        direction: current < prev ? 'falling' : current > prev ? 'rising' : 'flat',
        current,
        previous: prev,
        first,
        sinceFirst: current < first ? 'better' : current > first ? 'worse' : 'same',
    };
}

export function itemFromRow(row: AlertRow, nowIso: string): AttentionItem {
    const snoozed = snoozeOpen(row.snoozed_until, nowIso);
    return {
        id: row.id,
        fingerprint: row.fingerprint,
        type: row.type as AttentionType,
        // The persisted domain, not a re-derivation from `type` — a producer
        // that stated its own is the whole reason the column exists.
        domain: row.domain,
        severity: row.severity as AttentionSeverity,
        title: row.title,
        detail: row.detail ?? undefined,
        sourceRef: row.source_ref ?? undefined,
        actions: row.source_ref
            ? [
                  {
                      kind: 'investigate',
                      label: 'Investigate',
                      href: row.source_ref,
                  },
              ]
            : [],
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        acked: row.status === 'acked',
        snoozed,
        snoozedUntil: snoozed ? (row.snoozed_until ?? undefined) : undefined,
        resolvedAt: row.resolved_at ?? undefined,
        trend: trendFor(row.count, row.count_prev, row.count_first),
    };
}

/**
 * Merge freshly-derived alerts against the persisted rows.
 * - first_seen is preserved for items already known.
 * - An ack is carried while the live fingerprint equals acked_fingerprint, or —
 *   for the count-BAND fingerprints aggregate alerts use — while the live band is
 *   no larger than the acked one. Any other change re-activates the item (new
 *   incident under the same stable id). Severity escalation also drops the ack.
 *   A band that SHRANK must not re-activate:
 *   that would un-ack an operator precisely because their backlog improved.
 * - Persisted items absent from the new derivation are resolved — UNLESS their id
 *   falls under a `protectedPrefix`, meaning their signal source failed this cycle
 *   and "absent" must be read as "unknown". Those are carried forward unchanged.
 * - verdict is driven by UNACKED critical/warning; info never degrades.
 */
export function reconcile(
    derived: DerivedAlert[],
    existing: AlertRow[],
    nowIso: string,
    protectedPrefixes: string[] = [],
): ReconcileResult {
    const isProtected = (id: string): boolean => protectedPrefixes.some((p) => id.startsWith(p));
    const byId = new Map<string, AlertRow>();
    for (const r of existing) byId.set(r.id, r);

    const upserts: UpsertAlert[] = [];
    const items: AttentionItem[] = [];

    for (const d of derived) {
        const prior = byId.get(d.id);

        // Fix 15 (OSS): also defeat snooze carry-forward when the prior row was resolved.
        // A snooze placed on an alert's prior resolved incarnation must NOT silently
        // suppress the re-fired alert. `resolveAlerts` also clears snoozed_until as
        // defense-in-depth, but doing both is safer against partial-write races.
        const priorWasResolved = prior?.status === 'resolved';

        // `first_seen` tracks the START OF THE CURRENT ACTIVE INCARNATION.  When the
        // alert was previously resolved and has just re-fired, the DB row still carries
        // the old `first_seen` from the prior incarnation (the ON CONFLICT clause in
        // upsertAlerts does not update first_seen).  Reset it to `nowIso` so that:
        //  (a) the UI shows the current incident's start time, not a prior one, and
        //  (b) the alert-grace duration check below correctly measures time since the
        //      current active period began, not since some historical flap.
        const firstSeen = !prior || priorWasResolved ? nowIso : prior.first_seen;

        // Alert grace: for `class-no-leader` and `subsystem-dead` fingerprints on
        // `tasks:` liveness alerts, hold severity at `warning` until the condition has
        // been CONTINUOUSLY absent for at least ALERT_GRACE_MS.  A transient flap
        // (leader re-acquired / heartbeat re-beat then missing again) resets
        // `first_seen` to `nowIso` each time the alert re-fires after resolving, so
        // the grace window restarts and the alert never reaches `critical`.
        // A sustained, continuous absence accumulates time in `first_seen` and
        // escalates to `critical` once the grace expires.
        const isGraceEligible =
            d.severity === 'critical' &&
            // `tasks:` since the liveness bridge started namespacing by domain.
            // Only the task-domain fingerprints (class-no-leader, subsystem-dead)
            // are grace-eligible, so this stays a single prefix — but it MUST
            // track the bridge: left as `task-liveness:` it matched nothing and
            // every leader flap escalated straight to critical.
            d.id.startsWith('tasks:') &&
            GRACE_FINGERPRINTS.has(d.fingerprint);
        const activeMs = Date.parse(nowIso) - Date.parse(firstSeen);
        const gracedSeverity: AttentionSeverity =
            isGraceEligible && activeMs < ALERT_GRACE_MS ? 'warning' : d.severity;

        const escalated = prior != null && rankOf(gracedSeverity) < rankOf(prior.severity);
        // A higher effective severity requires fresh acknowledgement, even if
        // the count or fingerprint is unchanged. Compare after applying grace.
        // Count-bearing alerts (dead-letter / stuck / failed-run-spike) hold the ack
        // against the count WATERMARK, not the coarse count-band fingerprint: while the
        // live count stays at or below the acked level the ack holds (members draining,
        // or jittering within a band, stay quiet), but the moment a genuinely new member
        // pushes the count past the watermark the ack drops and the alert re-surfaces.
        //
        // Count-LESS alerts hold the ack by fingerprint. Plain equality is the right
        // rule for a scalar fingerprint (`open`, `class-no-leader`) — any change is a
        // different incident. It is the WRONG rule for a count-BAND fingerprint,
        // because equality is symmetric and cannot tell a backlog that grew from one
        // that shrank: an operator who acked "1,234 track titles match their file name"
        // (`1001-10000`) and then re-tagged down to 50 (`21-100`) had the item come back
        // unacked BECAUSE the situation improved. So a band that did not GROW also
        // holds the ack, against the band the ack was taken at (`acked_fingerprint` is
        // carried forward unchanged below, so the watermark does not ratchet downward
        // with the count). `countBucketDidNotGrow` returns false for any fingerprint
        // that is not a band, which leaves every scalar alert on plain equality.
        // Backing up this key was already acknowledged. First use changes the
        // reminder's urgency, not the key the operator agreed to back up.
        const backupAckHeld =
            d.id === 'settings:master-key:generated' && prior?.acked_fingerprint === d.fingerprint;
        const ackHeld =
            (!escalated || backupAckHeld) &&
            prior?.status === 'acked' &&
            (d.count != null
                ? prior.acked_count != null && d.count <= prior.acked_count
                : prior.acked_fingerprint === d.fingerprint ||
                  countBucketDidNotGrow(prior.acked_fingerprint, d.fingerprint));

        const status: 'active' | 'acked' = ackHeld ? 'acked' : 'active';

        const snoozeHeld =
            !escalated && !priorWasResolved && snoozeOpen(prior?.snoozed_until ?? null, nowIso);
        const snoozedUntil = snoozeHeld ? (prior?.snoozed_until ?? null) : null;

        upserts.push({
            id: d.id,
            fingerprint: d.fingerprint,
            type: d.type,
            // Omitting this silently routes every producer-stated domain
            // through `domainForType(type)` instead, which lands a storage
            // problem on 'system'. `UpsertAlert.domain` is optional, so the
            // omission compiled and every adapter-level test still passed.
            domain: d.domain,
            severity: gracedSeverity,
            title: d.title,
            detail: d.detail ?? null,
            source_ref: d.sourceRef ?? null,
            status,
            first_seen: firstSeen,
            last_seen: nowIso,
            acked_at: ackHeld ? (prior?.acked_at ?? null) : null,
            acked_by: ackHeld ? (prior?.acked_by ?? null) : null,
            acked_fingerprint: ackHeld ? (prior?.acked_fingerprint ?? null) : null,
            // Live count refreshed every cycle; the watermark is preserved only while the
            // ack holds (dropped to null on re-activation, re-snapshotted on the next ack).
            count: d.count ?? null,
            acked_count: ackHeld ? (prior?.acked_count ?? null) : null,
            snoozed_until: snoozedUntil,
        });

        items.push({
            id: d.id,
            fingerprint: d.fingerprint,
            type: d.type,
            domain: d.domain,
            severity: gracedSeverity,
            title: d.title,
            detail: d.detail,
            sourceRef: d.sourceRef,
            term: d.term,
            actions: d.actions,
            firstSeen,
            lastSeen: nowIso,
            acked: ackHeld,
            snoozed: snoozeHeld,
            snoozedUntil: snoozeHeld ? (snoozedUntil ?? undefined) : undefined,
            // Computed against the PRIOR row on purpose: the upsert that rolls
            // count_prev forward has not run yet in this tick, so `prior.count`
            // is still last tick's value — which is precisely `previous`. A
            // re-activated alert (prior resolved) reports nothing, because its
            // trend columns were cleared and this is a new incident.
            trend:
                prior && prior.status !== 'resolved'
                    ? trendFor(d.count, prior.count, prior.count_first ?? prior.count)
                    : undefined,
        });
    }

    const derivedIds = new Set(derived.map((d) => d.id));

    // Persisted rows absent from this derivation: resolve them, EXCEPT those under a
    // protected prefix (their source failed) — carry those forward as last-known items.
    const resolveIds: string[] = [];
    for (const r of existing) {
        if (r.status === 'resolved' || derivedIds.has(r.id)) continue;
        if (isProtected(r.id)) {
            items.push(itemFromRow(r, nowIso));
        } else {
            resolveIds.push(r.id);
        }
    }

    const { unreadCount, verdict } = summarize(items);

    return { upserts, resolveIds, items, unreadCount, verdict };
}

/**
 * Sort in place by severity and compute the badge count + verdict.
 *
 * Shared by `reconcile` (derive path, in the task) and `projectPersisted` (read
 * path, in the request) so the two can never disagree about what the operator
 * sees. They MUST agree: the task decides what is written, the read path decides
 * what is rendered, and a divergence here would show a verdict no cycle produced.
 *
 * `compare` is optional so the read path can add a deterministic tiebreak — a
 * plain `SELECT` has no inherent order, whereas the derive path's array order is
 * meaningful (it is source order) and a stable sort preserves it.
 */
export function summarize(
    items: AttentionItem[],
    compare?: (a: AttentionItem, b: AttentionItem) => number,
): { unreadCount: number; verdict: AttentionVerdict } {
    items.sort((a, b) => rankOf(a.severity) - rankOf(b.severity) || (compare ? compare(a, b) : 0));

    // An item drops out of the badge/verdict if it's acked OR currently snoozed; it still
    // renders (dimmed) in the list.
    const unread = items.filter((i) => !i.acked && !i.snoozed);
    const unreadCount = unread.length;

    let verdict: AttentionVerdict = 'healthy';
    if (unread.some((i) => i.severity === 'critical')) verdict = 'critical';
    else if (unread.some((i) => i.severity === 'warning')) verdict = 'degraded';

    return { unreadCount, verdict };
}

/**
 * Build the client-facing board from persisted rows and any process-local live notices.
 *
 * Slice 1 moved derivation into the `problem-derive` task, so a request no longer
 * has adapter output in hand. Everything the operator acts on (severity, ack,
 * snooze, first/last seen, counts) is a column, so this is a pure projection of
 * what the last cycle wrote. Resolved rows are excluded: they belong to
 * `resolvedHistory`, not the board — the same rule `reconcile` applies when it
 * skips them while walking `existing`.
 *
 * `render` supplies the two fields the table cannot hold (typed `actions[]`, the
 * glossary `term`), and only where its `fingerprint` still matches the row —
 * otherwise the incident changed since that render and its scoped actions
 * (`itemId`, `runId`, …) may point at something that is no longer the problem.
 * An id with no usable render falls back to `itemFromRow`'s investigate action.
 */
export function projectPersisted(
    rows: AlertRow[],
    nowIso: string,
    render: AttentionRenderMap = {},
    liveItems: AttentionItem[] = [],
): PersistedProjection {
    const items: AttentionItem[] = [...liveItems];
    /** Source order from the publishing cycle; unrendered ids sort after rendered ones. */
    const orderOf = new Map<string, number>();

    for (const row of rows) {
        if (row.status === 'resolved') continue;
        const item = itemFromRow(row, nowIso);
        const entry = render[row.id];
        if (entry && entry.fingerprint === row.fingerprint) {
            item.actions = entry.actions;
            item.term = entry.term;
            orderOf.set(row.id, entry.order);
        }
        items.push(item);
    }

    const orderRank = (id: string): number => orderOf.get(id) ?? Number.MAX_SAFE_INTEGER;
    const { unreadCount, verdict } = summarize(
        items,
        (a, b) => orderRank(a.id) - orderRank(b.id) || a.id.localeCompare(b.id),
    );

    return { items, unreadCount, verdict };
}
