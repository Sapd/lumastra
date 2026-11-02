// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the Tier 4 inventory checks against a real PostgreSQL
 * test database.
 *
 * The unit tests cover the pure verdict functions; what they cannot cover is
 * the SQL. `inventory.legacy-secret-envelopes` (security review 2026-09-13,
 * C19) counts BYTEA columns by the raw `enc:v2:` marker the row-bound blobs
 * start with — a predicate no mocked `sql` tag can validate, and one that
 * silently reports "everything is fine" if it is wrong.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *   src/lib/server/services/security-self-check/inventory-checks.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { deriveMasterKey, encrypt, sealSecret } from '$lib/server/crypto/secret-box.js';
import { runInventoryChecks } from './inventory-checks.js';

const KEY = deriveMasterKey('a'.repeat(64));
const PLUGIN_ID = 'test_c19_inventory';

describe('inventory.legacy-secret-envelopes', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        // beforeEach only clears BEFORE a test — without this the last test's
        // legacy row outlives the file and skews every later run on this DB.
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = ${PLUGIN_ID}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = ${PLUGIN_ID}`;
    });

    /** The one finding this file is about. */
    async function envelopeFinding() {
        const findings = await runInventoryChecks(sql);
        const finding = findings.find((f) => f.id === 'inventory.legacy-secret-envelopes');
        expect(finding, 'the legacy-envelope check did not run').toBeDefined();
        // An `error` status means the SQL itself failed — the exact failure this
        // file exists to catch, so say so rather than reading the count.
        expect(finding!.status, finding!.detail).not.toBe('error');
        return finding!;
    }

    /**
     * The plugin-store legacy count the finding reports (0 when the store is
     * not named). The check counts the WHOLE table — plus plugin_user_credentials
     * — so other files' rows on a shared test DB land in it too; tests compare
     * against a baseline taken before their own insert rather than assume empty.
     */
    async function pluginUnboundCount(): Promise<number> {
        const { detail } = await envelopeFinding();
        const m = /plugin_secrets \+ plugin_user_credentials \((\d+)\)/.exec(detail);
        return m ? Number(m[1]) : 0;
    }

    it('does not count a row-bound BYTEA blob', async () => {
        const before = await pluginUnboundCount();
        await sql`
            INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
            VALUES (${PLUGIN_ID}, 'bound', ${encrypt('v', KEY, `plugin_secrets:${PLUGIN_ID}/bound`)}, 1)
        `;

        expect(await pluginUnboundCount()).toBe(before);
    });

    it('counts a legacy unbound BYTEA blob', async () => {
        const before = await pluginUnboundCount();
        await sql`
            INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
            VALUES (${PLUGIN_ID}, 'legacy', ${encrypt('v', KEY)}, 1)
        `;

        expect(await pluginUnboundCount()).toBe(before + 1);
        const finding = await envelopeFinding();
        expect(finding.status).toBe('warn');
        expect(finding.remediation).toMatch(/rotate master key/i);
    });
});

describe('inventory.livetv-plaintext-credentials', () => {
    let sql: postgres.Sql;
    const NAME = 'test_c19_livetv_source';

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM livetv_sources WHERE name = ${NAME}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM livetv_sources WHERE name = ${NAME}`;
    });

    it('treats a row-bound enc:v2 credential as sealed, not as plaintext', async () => {
        // The regression this pins: the rule matched `enc:v1:` literally, so
        // every value upgraded to the row-bound form would have been reported
        // as a plaintext credential.
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, xtream_username, xtream_password)
            VALUES (
                ${id}::uuid, ${NAME}, 'xtream',
                ${sealSecret('u', KEY, `livetv_sources:${id}/xtream_username`)},
                ${sealSecret('p', KEY, `livetv_sources:${id}/xtream_password`)}
            )
        `;

        const findings = await runInventoryChecks(sql);
        const finding = findings.find((f) => f.id === 'inventory.livetv-plaintext-credentials');
        expect(finding!.status).toBe('pass');
    });

    it('still reports a genuinely plaintext credential', async () => {
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, xtream_username, xtream_password)
            VALUES (${crypto.randomUUID()}::uuid, ${NAME}, 'xtream', 'plain-user', 'plain-pass')
        `;

        const findings = await runInventoryChecks(sql);
        const finding = findings.find((f) => f.id === 'inventory.livetv-plaintext-credentials');
        expect(finding!.status).toBe('warn');
    });
});
