// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    AttentionAction,
    AttentionItem,
    AttentionSeverity,
    AttentionType,
    AttentionVerdict,
} from '$lib/schemas/api-attention-responses';

/**
 * Outcome of one derivation cycle.
 *
 * `failedPrefixes` lists the id-namespace prefixes whose signal source could not
 * be read this cycle (e.g. the circuit query threw). Alerts under a protected
 * prefix MUST NOT be resolved — we couldn't observe them, so "absent from the
 * derivation" means "unknown", not "gone". This is what prevents a transient
 * signal-source failure from flipping the whole board to a false "healthy".
 */
export interface DeriveOutcome {
    alerts: DerivedAlert[];
    failedPrefixes: string[];
    /** Subset of `failedPrefixes` that failed only because a cache is still warming after boot. */
    warmingPrefixes?: string[];
}

/** What an adapter emits, before persistence merges in first_seen/ack. */
export interface DerivedAlert {
    id: string;
    fingerprint: string;
    type: AttentionType;
    /**
     * The domain this problem belongs to (design §4.3) — free text, not the
     * closed `type` enum, so a new subsystem can raise a problem without a
     * schema change and without picking a near-miss enum member.
     *
     * Omit and the deprecated `type` decides, via `DOMAIN_BY_ATTENTION_TYPE`.
     * Every existing adapter omits it, which is why adding this is additive.
     */
    domain?: string;
    severity: AttentionSeverity;
    title: string;
    detail?: string;
    sourceRef?: string;
    term?: string;
    actions: AttentionAction[];
    /**
     * Member count for aggregate alerts (dead-letter / stuck / failed-run-spike).
     * When present, reconcile holds an ack against this count watermark rather than
     * the coarse count-band fingerprint, so a genuinely new member re-surfaces the
     * alert while draining members keep it quiet. Omit for scalar alerts (circuits,
     * schedules, component/playback health) — those keep fingerprint-based ack.
     */
    count?: number;
}

/** A row as stored in admin_attention_alerts. */
export interface AlertRow {
    id: string;
    fingerprint: string;
    type: string;
    /** NOT NULL in the DB since 16.231.0; now selected, so always present. */
    domain: string;
    severity: string;
    title: string;
    detail: string | null;
    source_ref: string | null;
    status: 'active' | 'acked' | 'resolved';
    first_seen: string;
    last_seen: string;
    acked_at: string | null;
    acked_by: string | null;
    acked_fingerprint: string | null;
    /** Live member count (null for scalar alerts). */
    count: number | null;
    /** Member count snapshotted at ack time; the watermark ack is held against. */
    acked_count: number | null;
    /** Count when this incident first fired; survives every tick until it resolves. */
    count_first: number | null;
    /** Count one tick ago. Null on the first tick of an incident. */
    count_prev: number | null;
    snoozed_until: string | null;
    resolved_at: string | null;
}

/** A row to upsert (write-through of the current derivation). */
export interface UpsertAlert {
    id: string;
    fingerprint: string;
    type: string;
    /** Producer-stated domain; falls back to `domainForType(type)` on write. */
    domain?: string;
    severity: string;
    title: string;
    detail: string | null;
    source_ref: string | null;
    status: 'active' | 'acked';
    first_seen: string;
    last_seen: string;
    acked_at: string | null;
    acked_by: string | null;
    acked_fingerprint: string | null;
    count: number | null;
    acked_count: number | null;
    snoozed_until: string | null;
}

/**
 * Presentation fields an alert carries that the `admin_attention_alerts` table
 * cannot hold — the typed `actions[]` and the glossary `term`.
 *
 * Slice 1 moved derivation off the read path, so the read path no longer has an
 * adapter's output in hand: it projects persisted rows. `itemFromRow` can only
 * synthesise a single "investigate" action from `source_ref`, which would silently
 * strip every reset-circuit / bulk-retry / release-stuck button from the bell —
 * a UI regression, not a refactor. Persisting them would need a schema change,
 * which this slice explicitly does not take (design §11: "Slices 0 and 1 — none").
 *
 * So the derive cycle publishes them as a short sidecar next to the alert table
 * (see `attention-cache.ts`), keyed by alert id and guarded by `fingerprint`:
 * a stale render for a changed incident is discarded rather than attached to it,
 * the same guard `ackAlert`/`snoozeAlert` use. The sidecar is best-effort — when
 * it is missing (Valkey down, first derive after a flush) items degrade to the
 * `itemFromRow` action set rather than failing.
 */
export interface AttentionRenderEntry {
    /** The fingerprint this render was produced for. Mismatch ⇒ discard. */
    fingerprint: string;
    /** Position in the derivation output, so the read path can reproduce source order. */
    order: number;
    /** Glossary key for the headline jargon. */
    term?: string;
    /** The typed, scoped actions the adapter emitted. */
    actions: AttentionAction[];
}

/** Sidecar payload: alert id → its presentation fields. */
export type AttentionRenderMap = Record<string, AttentionRenderEntry>;

/** What the read path renders: a projection of the persisted rows, no writes. */
export interface PersistedProjection {
    items: AttentionItem[];
    unreadCount: number;
    verdict: AttentionVerdict;
}

export interface ReconcileResult {
    upserts: UpsertAlert[];
    resolveIds: string[];
    items: AttentionItem[];
    unreadCount: number;
    verdict: AttentionVerdict;
}

// Re-export for convenience — callers that only need the types file don't
// need to import from the schema directly.
export type { AttentionAction, AttentionItem, AttentionSeverity, AttentionType, AttentionVerdict };
