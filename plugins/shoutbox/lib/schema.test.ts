// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { ensureSchema, __resetSchemaGuardForTests } from './schema.js';

describe('ensureSchema', () => {
    it('runs the CREATE statements once per process', async () => {
        __resetSchemaGuardForTests();
        const sql = vi.fn(async () => []) as unknown as (
            s: TemplateStringsArray,
        ) => Promise<unknown[]>;
        await ensureSchema(sql);
        await ensureSchema(sql);
        expect((sql as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    });
});
