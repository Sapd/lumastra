// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Audit Log — Zod schemas (single source of truth).
 *
 * `AdminAuditEventRow` represents an audit_log row with source='admin', which has human-actor columns:
 * `actor`, `target`, `outcome`. No `severity` — admin actions are always `info`
 * level by convention; `outcome` covers ok/error/denied.
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 */

import { z } from 'zod';

export const AdminAuditEventRowSchema = z.object({
    id: z.number(),
    ts: z.string(), // ISO timestamp
    instanceId: z.string(),
    actor: z.string(),
    /**
     * Which credential path produced `actor` (R5 attribution): 'pat',
     * 'service_token', 'session', 'forward_auth', 'bearer', 'stream_token',
     * 'jellyfin_compat' (a /j session or /j API key).
     * `null` for rows written before this column existed, and for the rare
     * legacy call site that still passes a bare username string.
     */
    principalKind: z.string().nullable(),
    /**
     * The specific credential's own id (PAT id, service-token id, session id,
     * …) — lets a stolen credential be traced to the exact token, not just
     * the username. `null` for the same reasons as `principalKind`.
     */
    credentialId: z.string().nullable(),
    action: z.string(),
    target: z.string(),
    outcome: z.enum(['ok', 'error', 'denied']),
    detail: z.record(z.string(), z.unknown()),
});
export type AdminAuditEventRow = z.infer<typeof AdminAuditEventRowSchema>;

/**
 * Paginated audit feed — `{ items, page }` envelope per the v1 contract.
 * Cursor paging: `page.nextCursor` carries the next keyset cursor (integer id as
 * string), or is absent when there are no more rows.
 */
export const AdminAuditPageSchema = z.object({
    limit: z.number().int(),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
});
export type AdminAuditPage = z.infer<typeof AdminAuditPageSchema>;

export const AdminAuditFeedResponseSchema = z.object({
    items: z.array(AdminAuditEventRowSchema),
    page: AdminAuditPageSchema,
});
export type AdminAuditFeedResponse = z.infer<typeof AdminAuditFeedResponseSchema>;

export const AdminAuditActorsResponseSchema = z.object({
    actors: z.array(z.string()),
});
export type AdminAuditActorsResponse = z.infer<typeof AdminAuditActorsResponseSchema>;
