// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toWebLoginViews } from '$lib/server/utils/web-logins-util.js';

describe('toWebLoginViews', () => {
    it('marks the current session and never leaks token_hash', () => {
        const rows = [
            {
                id: 'a',
                token_hash: 'HASH_A',
                created_at: new Date('2026-01-01'),
                last_used_at: null,
                user_agent: 'UA',
                ip: '1.1.1.1',
            },
            {
                id: 'b',
                token_hash: 'HASH_B',
                created_at: new Date('2026-01-02'),
                last_used_at: new Date('2026-01-03'),
                user_agent: null,
                ip: null,
            },
        ];
        const views = toWebLoginViews(rows as never, 'HASH_A');
        expect(views[0]).toMatchObject({ id: 'a', current: true, userAgent: 'UA' });
        expect(views[1]).toMatchObject({ id: 'b', current: false });
        // token_hash must not appear on any view
        expect(JSON.stringify(views)).not.toContain('HASH_');
    });
});
