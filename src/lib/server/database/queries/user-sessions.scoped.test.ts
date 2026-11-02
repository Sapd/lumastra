// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

// Assert the query filters by BOTH id AND user_id (IDOR guard). We capture the
// tagged-template interpolations the query passes.
describe('revokeUserSessionByIdScoped', () => {
    it('constrains the UPDATE to id AND user_id', async () => {
        const calls: Array<{ text: string; values: unknown[] }> = [];
        const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push({ text: strings.join('?'), values });
            return Promise.resolve([{ id: 'row-1' }]);
        }) as unknown as import('postgres').Sql;

        const { revokeUserSessionByIdScoped } = await import('./user-sessions.queries.js');
        const n = await revokeUserSessionByIdScoped(sql, 'row-1', 'uid-alice');

        expect(n).toBe(1);
        const { text, values } = calls[0];
        expect(text).toMatch(/WHERE\s+id =/i);
        expect(text).toMatch(/AND\s+user_id =/i);
        expect(text.indexOf('id =')).toBeLessThan(text.indexOf('user_id ='));

        // Positional: a WHERE id=${userId} AND user_id=${id} swap must fail this.
        expect(values[0]).toBe('row-1');
        expect(values[1]).toBe('uid-alice');
    });
});
