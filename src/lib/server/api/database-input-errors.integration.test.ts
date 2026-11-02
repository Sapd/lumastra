// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { mount } from './mount.js';
import { defineEndpoint } from './define.js';

// Real server errors: a mocked sql cannot prove which SQLSTATE PostgreSQL emits.
describe('mount database input errors (Integration)', () => {
    let sql: postgres.ReservedSql;
    const id = '00000000-0000-4000-8000-000000000001';
    beforeAll(async () => {
        sql = await getTestDb().reserve();
        await sql`CREATE TEMP TABLE input_error_parents (id uuid PRIMARY KEY)`;
        await sql`CREATE TEMP TABLE input_error_values (
            id uuid PRIMARY KEY, qty integer CHECK (qty > 0),
            parent_id uuid REFERENCES input_error_parents(id)
        )`;
        await sql`INSERT INTO input_error_values (id, qty) VALUES (${id}, 1)`;
    });
    afterAll(async () => {
        if (sql) {
            await sql`DROP TABLE IF EXISTS input_error_values, input_error_parents`;
            sql.release();
        }
        await closeTestDb();
    });

    it.each([
        ['22P02', 422, () => sql`SELECT ${'not-a-uuid'}::uuid`],
        ['22003', 422, () => sql`SELECT ${'2147483648'}::integer`],
        [
            '23514',
            422,
            () => sql`INSERT INTO input_error_values (id, qty) VALUES (${crypto.randomUUID()}, -1)`,
        ],
        [
            '23503',
            409,
            () =>
                sql`INSERT INTO input_error_values (id, qty, parent_id) VALUES (${crypto.randomUUID()}, 1, ${crypto.randomUUID()})`,
        ],
        ['23505', 409, () => sql`INSERT INTO input_error_values (id, qty) VALUES (${id}, 1)`],
    ] as const)('maps real SQLSTATE %s to %s', async (code, status, query) => {
        // Capture and rethrow the actual driver error through the real mount pipeline.
        const def = defineEndpoint({
            auth: { kind: 'public' },
            handlers: {
                GET: async () => {
                    try {
                        await query();
                    } catch (err) {
                        expect(err).toMatchObject({ code });
                        throw err;
                    }
                    throw new Error('Expected database rejection');
                },
            },
        });
        const url = new URL('http://localhost/api/test');
        const event = {
            url,
            request: new Request(url),
            params: {},
            locals: {},
        } as unknown as RequestEvent;
        const response = await mount(def, { surface: 'internal' }).GET!(event);
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({
            code: status === 422 ? 'validation_failed' : 'conflict',
        });
    });
});
