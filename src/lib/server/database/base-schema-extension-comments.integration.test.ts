// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The base schema's COMMENT ON EXTENSION needs extension OWNERSHIP. A non-superuser app role on
 * a database whose extensions a DBA/operator pre-created (CloudNativePG, managed Postgres) failed
 * the very first migration with "must be owner of extension pg_trgm". The guarded form must be a
 * no-op for such a role and still set the comment for the owner.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { guardExtensionComments } from './base-schema-extension-comments.js';

const PROBE_ROLE = 'lumastra_ext_comment_probe';
const RAW = "COMMENT ON EXTENSION pg_trgm IS 'probe comment';\n";

describe('guardExtensionComments on a real database', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
        await sql.unsafe(
            `DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN CREATE ROLE ${PROBE_ROLE} NOLOGIN; END IF; END$$`,
        );
    });

    afterAll(async () => {
        await sql.unsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
        await closeTestDb();
    });

    /** Run statements as `role` (or the connecting user) inside a rolled-back transaction. */
    async function runAs(role: string | null, statements: string): Promise<string | null> {
        let comment: string | null = null;
        await sql
            .begin(async (tx) => {
                if (role) await tx.unsafe(`SET LOCAL ROLE ${role}`);
                await tx.unsafe(statements);
                await tx.unsafe('RESET ROLE');
                const [row] = await tx<{ c: string | null }[]>`
                    SELECT obj_description(oid, 'pg_extension') AS c
                    FROM pg_extension WHERE extname = 'pg_trgm'`;
                comment = row?.c ?? null;
                throw new RollbackSignal();
            })
            .catch((error: unknown) => {
                if (!(error instanceof RollbackSignal)) throw error;
            });
        return comment;
    }

    it('the unguarded statement fails for a role that does not own the extension', async () => {
        await expect(runAs(PROBE_ROLE, RAW)).rejects.toThrow(/must be owner of extension/);
    });

    it('the guarded statement is a no-op for that role', async () => {
        const comment = await runAs(PROBE_ROLE, guardExtensionComments(RAW));
        expect(comment).not.toBe('probe comment');
    });

    it('the guarded statement still sets the comment for the owner', async () => {
        const comment = await runAs(null, guardExtensionComments(RAW));
        expect(comment).toBe('probe comment');
    });
});

class RollbackSignal extends Error {}
