// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-direct-sql-begin rule.
 *
 * The rule is path-scoped to services/** and plugins/**. We exercise both
 * applicable paths (where it should fire) and exempt paths (where it should
 * stay silent), plus the eslint-disable-next-line override.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-direct-sql-begin');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const SERVICE_PATH = '/repo/src/lib/server/services/foo.service.ts';
const PLUGIN_PATH = '/repo/src/lib/server/plugins/builtin/sync/bar.plugin.ts';
const QUERIES_PATH = '/repo/src/lib/server/database/queries/foo.queries.ts';
const HELPER_PATH = '/repo/src/lib/server/database/with-tx.ts';
const TEST_PATH = '/repo/src/lib/server/services/foo.service.test.ts';
const ROUTE_PATH = '/repo/src/routes/api/foo/+server.ts';

ruleTester.run('no-direct-sql-begin', rule, {
    valid: [
        // ── outside the applicable paths (queries/, helper itself, routes, tests) ──
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: QUERIES_PATH,
        },
        {
            code: `await sql.savepoint(async (tx) => { /* noop */ });`,
            filename: QUERIES_PATH,
        },
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: HELPER_PATH,
        },
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: TEST_PATH,
        },
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: ROUTE_PATH,
        },
        // ── inside applicable paths but not a SQL handle ──
        {
            // A non-sql object happens to have a begin method — the receiver
            // name doesn't look like a SQL handle, so we don't fire.
            code: `await tracer.begin('span');`,
            filename: SERVICE_PATH,
        },
        {
            // Array splice etc. — also not flagged.
            code: `await pipeline.savepoint('foo');`,
            filename: SERVICE_PATH,
        },
        // ── eslint-disable-next-line overrides ──
        // RuleTester runs the rule under the synthetic id `rule-to-test/...`,
        // so we use that prefix here. Real callsites use the real plugin name.
        {
            code: `
                // eslint-disable-next-line rule-to-test/no-direct-sql-begin
                await sql.begin(async (tx) => { /* noop */ });
            `,
            filename: SERVICE_PATH,
        },
        // ── correct usage — withTx helper ──
        {
            code: `
                import { withTx } from '$lib/server/database/with-tx';
                await withTx(sql, async (tx) => { /* noop */ });
            `,
            filename: SERVICE_PATH,
        },
    ],
    invalid: [
        // ── services/** ──
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        {
            code: `await sql.savepoint(async (tx) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'savepoint' } }],
        },
        {
            code: `await this.sql.begin(async (tx) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        {
            // Renamed handle still flagged as long as the name looks SQL-y.
            code: `await reservedSql.begin(async (tx) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        {
            code: `await tx.savepoint(async (sp) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'savepoint' } }],
        },
        // ── plugins/** ──
        {
            code: `await sql.begin(async (tx) => { /* noop */ });`,
            filename: PLUGIN_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        {
            code: `await ctx.dbContext.sql.begin(async (tx) => { /* noop */ });`,
            filename: PLUGIN_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        // ── broadened heuristic: conn / pg prefixes ──
        {
            // dbClient contains neither "sql" nor the old terms but is caught
            // by the "client" fragment already in the heuristic.
            code: `await dbClient.begin(async (tx) => { /* noop */ });`,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
        {
            // pgConn is now flagged because "pg" and "conn" were added in Fix 2.
            code: `await pgConn.begin(async (tx) => { /* noop */ });`,
            filename: PLUGIN_PATH,
            errors: [{ messageId: 'directBegin', data: { method: 'begin' } }],
        },
    ],
});

// Valid: a receiver name that is not in the heuristic list — rule deliberately
// skips it. This confirms the name-based heuristic boundary.
ruleTester.run('no-direct-sql-begin (non-SQL receiver is skipped)', rule, {
    valid: [
        {
            // "someUnrelatedName" matches none of the heuristic terms, so the
            // rule stays silent even though it is inside a services path.
            code: `await someUnrelatedName.begin(async () => {});`,
            filename: SERVICE_PATH,
        },
    ],
    invalid: [],
});

console.log('  ✅ no-direct-sql-begin: all tests passed');
