// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// audit-log.ts — best-effort writer for the audit_log feed (source='subsystem').
//
// The unified feed of AUTONOMOUS subsystem actions: reconciler reclaims,
// backpressure rollups, circuit-breaker transitions, leader changes, dispatcher
// dead-letters, boot-recovery completes. Writers are COARSE (per-sweep /
// per-transition / per-rollup) — NEVER per-job — so the table stays bounded
// (plus a 30-day prune on the reconciler tick).
//
// Subsystem writes use getTaskDb() (task pool), and every write is best-effort:
// a Postgres failure logs and continues, never throwing into a tick.
//
// Since migration 16.107.0, `system_audit_log` no longer exists. All subsystem
// audit rows are written to `audit_log` with source='subsystem'. The admin
// audit rows (source='admin') are written by src/lib/server/utils/audit-log.ts.

import { getTaskDb } from '$lib/server/database/connection.js';
import { config, ADMIN_AUDIT_LOG_RETENTION_DAYS } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    insertAuditEvent,
    pruneAuditEvents,
    pruneBootRecoveryLog,
    type AuditSeverity,
} from '$lib/server/database/queries/observability.queries.js';
import { pruneAdminAuditEvents } from '$lib/server/database/queries/admin-audit.queries.js';

const log = Logger.for('AuditLog');

export interface AuditEvent {
    category:
        | 'reconciler'
        | 'backpressure'
        | 'circuit-breaker'
        | 'leader'
        | 'dispatcher'
        | 'stage-sweep'
        | 'boot-recovery';
    action: string;
    severity: AuditSeverity;
    summary: string;
    detail?: Record<string, unknown>;
}

/**
 * Append one subsystem audit-log row (source='subsystem'). Best-effort — a
 * missing task pool or a Postgres failure is logged and swallowed so a
 * subsystem tick never breaks on it.
 */
export async function appendAuditEvent(event: AuditEvent): Promise<void> {
    try {
        const sql = getTaskDb();
        if (!sql) return;
        await insertAuditEvent(sql, {
            instanceId: config.INSTANCE_ID,
            category: event.category,
            action: event.action,
            severity: event.severity,
            summary: event.summary,
            detail: event.detail,
        });
    } catch (err) {
        log.warn('appendAuditEvent failed (best-effort)', {
            category: event.category,
            action: event.action,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Prune audit_log rows + boot_recovery_log rows.
 * Piggybacked on the reconciler tick (leader-gated, 30s). Best-effort.
 *
 * audit_log source='subsystem': 30-day retention (fixed).
 * audit_log source='admin':     ADMIN_AUDIT_LOG_RETENTION_DAYS (default 90, min 7).
 * boot_recovery_log:            30-day retention (fixed).
 */
export async function pruneAuditLog(): Promise<void> {
    try {
        const sql = getTaskDb();
        if (!sql) return;
        const auditDeleted = await pruneAuditEvents(sql);
        const bootDeleted = await pruneBootRecoveryLog(sql);
        const adminAuditDeleted = await pruneAdminAuditEvents(sql, ADMIN_AUDIT_LOG_RETENTION_DAYS);
        if (auditDeleted > 0 || bootDeleted > 0 || adminAuditDeleted > 0) {
            log.info('pruned observability history', {
                auditDeleted,
                bootDeleted,
                adminAuditDeleted,
            });
        }
    } catch (err) {
        log.warn('pruneAuditLog failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
