// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { findExpiredUploadSessions } from './upload-sessions.queries';

// ---------------------------------------------------------------------------
// Tests for upload-sessions.queries
// ---------------------------------------------------------------------------

describe('findExpiredUploadSessions', () => {
    it('returns all statuses past the cutoff — not restricted to uploading/assembling/failed', async () => {
        // The fix: queued and aborted rows must also be swept so successful uploads
        // do not accumulate DB rows indefinitely.
        const capturedSql: string[] = [];

        // Build a tagged-template mock that records the SQL strings it receives
        function mockSql(strings: TemplateStringsArray, ..._values: unknown[]): unknown {
            const query = strings.reduce((acc, str, i) => acc + (i > 0 ? `$${i}` : '') + str, '');
            capturedSql.push(query);
            return Promise.resolve([]);
        }
        // postgres.Sql is a tagged template function
        const sql = mockSql as unknown as import('postgres').Sql;

        await findExpiredUploadSessions(sql, new Date('2026-01-01'), 10);

        expect(capturedSql).toHaveLength(1);
        const query = capturedSql[0];
        // Must NOT restrict to specific statuses (the bug was filtering out 'queued'/'aborted')
        expect(query).not.toContain('status IN');
        // Must still filter by expires_at
        expect(query).toContain('expires_at');
        // Must still have an ORDER and LIMIT
        expect(query).toContain('ORDER BY');
        expect(query).toContain('LIMIT');
    });
});
