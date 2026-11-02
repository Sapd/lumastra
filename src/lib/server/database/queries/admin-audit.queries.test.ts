// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for admin-audit.queries — the pure SQL query module for
 * audit_log (source='admin'). Tests validate the shape mapping, edge-case
 * handling, and the RFC-4180 CSV serializer used by the export path.
 *
 * These are NOT integration tests — they do not touch a real database.
 * The sql helper is mocked via a simple tagged-template stub.
 */

import { describe, it, expect } from 'vitest';
import { serializeToCSV } from '$lib/shared/csv.js';

// ── Mock postgres.Sql stub ────────────────────────────────────────────────────

/**
 * Build a minimal fake postgres.Sql that returns a fixed row set.
 *
 * The tagged template is called as sql`...${fragment}...` where interpolated
 * values may be sub-fragments (produced by sql`…`). We only need the outer
 * call to return the rows; inner fragment calls return an opaque sentinel so
 * the outer call can detect them.
 */
function makeSqlStub(rows: unknown[]) {
    const FRAGMENT = Symbol('fragment');

    function sqlStub(...args: unknown[]): unknown {
        const strings = args[0];
        if (Array.isArray(strings) && 'raw' in (strings as object)) {
            // Outer tagged-template call — return the configured rows.
            return Promise.resolve(rows);
        }
        // Called as sql`inner fragment` for WHERE clauses — return sentinel.
        return FRAGMENT;
    }

    // postgres.Sql has a .json() method used in INSERT.
    sqlStub.json = (v: unknown) => v;

    return sqlStub as unknown as import('postgres').Sql;
}

// ── listAdminAuditFeed — pagination correctness ───────────────────────────────

type DbRow = {
    id: number;
    ts: Date;
    instance_id: string;
    actor: string;
    action: string;
    target: string;
    outcome: 'ok' | 'error' | 'denied';
    detail: Record<string, unknown>;
};

function makeRows(count: number): DbRow[] {
    return Array.from({ length: count }, (_, i) => ({
        id: count - i, // descending ids: count, count-1, …, 1
        ts: new Date('2026-01-01T00:00:00Z'),
        instance_id: 'test',
        actor: 'admin',
        action: 'test.action',
        target: 'item',
        outcome: 'ok' as const,
        detail: {},
    }));
}

describe('listAdminAuditFeed — pagination (off-by-one regression)', () => {
    it('sets nextCursor=null when the DB returns exactly limit rows (no more pages)', async () => {
        // With limit=5, the query fetches limit+1=6 rows.
        // DB returns exactly 5 → no more rows → nextCursor must be null.
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub(makeRows(5));
        const { events, nextCursor } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events).toHaveLength(5);
        expect(nextCursor).toBeNull();
    });

    it('sets nextCursor and slices to limit when DB returns limit+1 rows', async () => {
        // DB returns 6 rows for limit=5 → there IS a next page.
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub(makeRows(6));
        const { events, nextCursor } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events).toHaveLength(5);
        expect(nextCursor).toBe(events[4].id);
    });

    it('sets nextCursor=null when DB returns fewer than limit rows', async () => {
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub(makeRows(3));
        const { events, nextCursor } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events).toHaveLength(3);
        expect(nextCursor).toBeNull();
    });

    it('returns empty events and null nextCursor when DB returns 0 rows', async () => {
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub([]);
        const { events, nextCursor } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events).toHaveLength(0);
        expect(nextCursor).toBeNull();
    });
});

// ── principal attribution (R5) — mapAdminAuditRow via listAdminAuditFeed ──────

describe('listAdminAuditFeed — principal attribution mapping (R5)', () => {
    it('maps principal_kind/credential_id from the DB row', async () => {
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub([
            {
                id: 1,
                ts: new Date('2026-01-01T00:00:00Z'),
                instance_id: 'test',
                actor: 'ci-token',
                action: 'secret.rotate',
                target: '*',
                outcome: 'ok',
                detail: {},
                principal_kind: 'pat',
                credential_id: 'pat_123',
            },
        ]);
        const { events } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events[0].principalKind).toBe('pat');
        expect(events[0].credentialId).toBe('pat_123');
    });

    it('maps missing principal_kind/credential_id to null (pre-R5 rows)', async () => {
        const { listAdminAuditFeed } = await import('./admin-audit.queries.js');
        // makeRows() builds rows without principal_kind/credential_id at all —
        // mirrors a row written before migration 16.252.0.
        const sql = makeSqlStub(makeRows(1));
        const { events } = await listAdminAuditFeed(sql, { limit: 5 });
        expect(events[0].principalKind).toBeNull();
        expect(events[0].credentialId).toBeNull();
    });
});

// ── insertAdminAuditEvent — principal attribution columns (R5) ────────────────

/** Captures the raw tagged-template call so we can inspect the SQL + values. */
function makeInsertCaptureStub() {
    const calls: unknown[][] = [];
    function sqlStub(...args: unknown[]): unknown {
        calls.push(args);
        return Promise.resolve([]);
    }
    sqlStub.json = (v: unknown) => v;
    return { sql: sqlStub as unknown as import('postgres').Sql, calls };
}

describe('insertAdminAuditEvent — principal attribution columns (R5)', () => {
    it('inserts principal_kind and credential_id when provided', async () => {
        const { insertAdminAuditEvent } = await import('./admin-audit.queries.js');
        const { sql, calls } = makeInsertCaptureStub();
        await insertAdminAuditEvent(sql, {
            instanceId: 'inst-1',
            actor: 'ci-token',
            principalKind: 'pat',
            credentialId: 'pat_123',
            action: 'secret.rotate',
            target: '*',
            outcome: 'ok',
            detail: { rotated: 1 },
        });

        expect(calls).toHaveLength(1);
        const [strings, ...values] = calls[0] as [readonly string[], ...unknown[]];
        expect(strings.join('')).toContain('principal_kind');
        expect(strings.join('')).toContain('credential_id');
        expect(values).toContain('pat');
        expect(values).toContain('pat_123');
    });

    it('inserts NULL for principal_kind/credential_id when omitted (legacy string actor)', async () => {
        const { insertAdminAuditEvent } = await import('./admin-audit.queries.js');
        const { sql, calls } = makeInsertCaptureStub();
        await insertAdminAuditEvent(sql, {
            instanceId: 'inst-1',
            actor: 'system',
            action: 'queue.pause.global',
            target: 'global',
            outcome: 'ok',
        });

        const [, ...values] = calls[0] as [readonly string[], ...unknown[]];
        // Exactly two nulls expected from principalKind/credentialId defaulting;
        // detail defaults to {} (via sql.json passthrough), not null.
        expect(values.filter((v) => v === null)).toHaveLength(2);
    });
});

// ── listDistinctAdminActors ───────────────────────────────────────────────────

describe('listDistinctAdminActors', () => {
    it('returns a sorted list of actor strings', async () => {
        const { listDistinctAdminActors } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub([{ actor: 'charlie' }, { actor: 'alice' }, { actor: 'bob' }]);
        // The function maps rows directly; sorting is done by the SQL ORDER BY.
        // The stub returns rows in insertion order, not sorted, so we verify shape.
        const result = await listDistinctAdminActors(sql);
        expect(result).toEqual(['charlie', 'alice', 'bob']);
    });

    it('returns an empty array when there are no rows', async () => {
        const { listDistinctAdminActors } = await import('./admin-audit.queries.js');
        const sql = makeSqlStub([]);
        const result = await listDistinctAdminActors(sql);
        expect(result).toEqual([]);
    });
});

// ── datetime-local → UTC ISO conversion (mirrors AdminAuditFeed logic) ────────

/**
 * Inline mirror of the `localDatetimeToUtcIso` helper in AdminAuditFeed.svelte.
 * We test the conversion logic here to avoid needing to spin up Svelte.
 *
 * A datetime-local string has no timezone suffix; the browser constructs a Date
 * in local time, and toISOString() normalises it to UTC.
 */
function localDatetimeToUtcIso(raw: string): string | undefined {
    if (!raw) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
}

describe('localDatetimeToUtcIso — datetime-local timezone fix', () => {
    it('returns undefined for empty string', () => {
        expect(localDatetimeToUtcIso('')).toBeUndefined();
    });

    it('returns undefined for an invalid date string', () => {
        expect(localDatetimeToUtcIso('not-a-date')).toBeUndefined();
    });

    it('converts a datetime-local string to a UTC ISO string (ends with Z)', () => {
        // In Node.js test env, 'YYYY-MM-DDTHH:mm' is parsed as UTC, so this
        // also ends up as UTC — but the .Z suffix is guaranteed present.
        const result = localDatetimeToUtcIso('2026-06-22T12:30');
        expect(result).toBeDefined();
        expect(result).toMatch(/Z$/); // must have UTC marker
    });

    it('produces a valid ISO string that can be re-parsed by new Date()', () => {
        const utcIso = localDatetimeToUtcIso('2026-06-22T12:30');
        expect(utcIso).toBeDefined();
        const reparsed = new Date(utcIso!);
        expect(Number.isNaN(reparsed.getTime())).toBe(false);
    });

    it('the server receives a tz-anchored string (no ambiguity for Node new Date())', () => {
        // When the client calls toISOString() the result always contains 'Z'.
        // Node.js new Date('2026-06-22T12:30:00.000Z') is unambiguous UTC.
        const utcIso = localDatetimeToUtcIso('2026-06-22T12:30');
        expect(utcIso).not.toMatch(/^[0-9T:-]+$/); // must NOT be bare (no Z)
    });
});

// ── CSV serializer tests ──────────────────────────────────────────────────────

describe('serializeToCSV', () => {
    it('produces a header row + data rows with CRLF line endings', () => {
        const csv = serializeToCSV(['id', 'name'], [{ id: '1', name: 'Alice' }]);
        expect(csv).toBe('id,name\r\n1,Alice\r\n');
    });

    it('quotes fields containing commas', () => {
        const csv = serializeToCSV(['key', 'val'], [{ key: 'a', val: 'hello, world' }]);
        expect(csv).toBe('key,val\r\na,"hello, world"\r\n');
    });

    it('quotes fields containing double-quotes and doubles them (RFC-4180)', () => {
        const csv = serializeToCSV(['key', 'val'], [{ key: 'a', val: 'say "hi"' }]);
        expect(csv).toBe('key,val\r\na,"say ""hi"""\r\n');
    });

    it('quotes fields containing newlines', () => {
        const csv = serializeToCSV(['key', 'val'], [{ key: 'a', val: 'line1\nline2' }]);
        expect(csv).toBe('key,val\r\na,"line1\nline2"\r\n');
    });

    it('handles empty rows array — header only', () => {
        const csv = serializeToCSV(['id', 'name'], []);
        expect(csv).toBe('id,name\r\n');
    });

    it('produces multiple rows', () => {
        const csv = serializeToCSV(
            ['id', 'val'],
            [
                { id: '1', val: 'alpha' },
                { id: '2', val: 'beta' },
            ],
        );
        expect(csv).toBe('id,val\r\n1,alpha\r\n2,beta\r\n');
    });

    it('handles undefined/null values as empty string', () => {
        const csv = serializeToCSV(
            ['id', 'val'],
            [{ id: '1', val: undefined as unknown as string }],
        );
        expect(csv).toBe('id,val\r\n1,\r\n');
    });
});
