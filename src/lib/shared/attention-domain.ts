// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The attention `domain` vocabulary — free text, deliberately NOT an enum.
 *
 * `AttentionItem.type` was a closed 15-value enum mirrored in four artifacts
 * (Zod schema, generated client, a Postgres CHECK constraint, and the adapters
 * that write it), so every new problem producer cost a migration. `domain`
 * replaces it for grouping and icon selection: a producer names its own domain
 * and nothing has to be widened to accept it (design "Problems as Architecture"
 * §4.3).
 *
 * The consequence every consumer must honour: **a domain you do not recognise
 * is normal, not an error.** Never `switch` exhaustively on it; look it up and
 * fall back. `prettifyDomain` below is that fallback, following the same
 * pattern `services/attention/labels.ts`'s `prettify()` established for unknown
 * pipeline-stage ids.
 *
 * Pure and dependency-free (types only) so server and client share ONE mapping,
 * exactly like `attention-section-map.ts`. The dependency direction is
 * shared → schemas.
 */

import {
    ATTENTION_DOMAIN_FALLBACK,
    type AttentionItem,
    type AttentionType,
} from '$lib/schemas/api-attention-responses.js';

/**
 * Legacy `type` → `domain`.
 *
 * This is the SAME map migration 16.231.0 backfills the `domain` column with.
 * They have to agree: a row written before the migration and an item rendered
 * after it must land in the same domain. Keep both in step until `type` is
 * removed.
 *
 * Note that the vocabulary is wider than the admin nav sections — `storage`,
 * `livetv`, `cluster` and `setup` are domains, not `AdminSectionId`s. Domain
 * answers "which subsystem is this?", the section map answers "which nav dot
 * lights up?", and they are deliberately not the same question.
 */
export const DOMAIN_BY_ATTENTION_TYPE: Record<AttentionType, string> = {
    'circuit-open': 'tasks',
    'dead-letter': 'tasks',
    'stuck-items': 'tasks',
    'failed-run-spike': 'tasks',
    'overdue-schedule': 'tasks',
    'repeated-recovery': 'tasks',
    'needs-reidentification': 'library',
    'unmatched-files': 'library',
    integrity: 'library',
    'file-health': 'storage',
    'livetv-import': 'livetv',
    'optional-integration': 'settings',
    'cluster-key-mismatch': 'cluster',
    'setup-incomplete': 'setup',
    'degraded-component': 'system',
};

/** Domain for a legacy `type`. Unknown/future values fall back, never throw. */
export function domainForType(type: string): string {
    return DOMAIN_BY_ATTENTION_TYPE[type as AttentionType] ?? ATTENTION_DOMAIN_FALLBACK;
}

/**
 * The domain to treat an item as belonging to: what the producer stated, else
 * derived from the deprecated `type`.
 *
 * The `type` arm is what keeps this change additive — the derivation code has
 * not started emitting `domain` yet, so every item today resolves through the
 * map above and lands exactly where the migration's backfill put its row.
 */
export function domainForItem(item: Pick<AttentionItem, 'type' | 'domain'>): string {
    const stated = item.domain?.trim();
    return stated ? stated : domainForType(item.type);
}

/** An item guaranteed to carry a domain — what the serialization boundary emits. */
export type AttentionItemWithDomain = AttentionItem & { domain: string };

/**
 * Stamp the resolved domain onto an item.
 *
 * `AttentionItem` is the producing shape (`domain` optional, filled by the
 * schema default at parse time); `AdminStatusPayload` is the wire shape
 * (`domain` required). This function is the only bridge between them, so the
 * type checker — not a reviewer — is what guarantees the boundary populates a
 * real domain instead of letting every item degrade to the `system` default.
 */
export function withAttentionDomain(item: AttentionItem): AttentionItemWithDomain {
    return { ...item, domain: domainForItem(item) };
}

/** Display names for the domains that exist today. Additive; never exhaustive. */
const DOMAIN_LABELS: Record<string, string> = {
    storage: 'Storage',
    library: 'Library',
    tasks: 'Tasks',
    system: 'System',
    settings: 'Settings',
    livetv: 'Live TV',
    cluster: 'Cluster',
    setup: 'Setup',
    auth: 'Authentication',
    transcoding: 'Transcoding',
    network: 'Network',
    plugins: 'Plugins',
    updates: 'Updates',
};

/**
 * Human label for a domain, with a safe fallback for one this build has never
 * heard of — the whole point of an open vocabulary is that a plugin can raise a
 * problem under `backup` or `gpu` and the UI still renders a word rather than a
 * blank or a crash. Mirrors `labels.ts:prettify()`: strip separators, title-case,
 * and never collapse to the empty string.
 */
export function prettifyDomain(domain: string): string {
    const known = DOMAIN_LABELS[domain];
    if (known) return known;
    const base = domain.replace(/[-_]+/g, ' ').trim();
    if (!base) return domain || 'unknown';
    return base.charAt(0).toUpperCase() + base.slice(1);
}
