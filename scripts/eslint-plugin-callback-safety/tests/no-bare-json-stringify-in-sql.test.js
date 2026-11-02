// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-bare-json-stringify-in-sql rule.
 *
 * The rule must:
 *   - flag bare ${JSON.stringify(x)} inside any sql`...` tagged template
 *   - accept ${sql.json(x)} (the correct form)
 *   - accept ${JSON.stringify(x)}::jsonb (explicit cast escape hatch)
 *   - leave non-SQL uses of JSON.stringify alone (HTTP body, log lines,
 *     Valkey publish payload, console.log, etc.)
 *   - work for both bare `sql` and member-expression handles like `this.sql`,
 *     `tx.sql`, `opts.sql`.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-bare-json-stringify-in-sql');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('no-bare-json-stringify-in-sql', rule, {
    valid: [
        // ── correct form: sql.json() ─────────────────────────────────────
        {
            code: `await sql\`UPDATE task_history SET result = \${sql.json(value)} WHERE id = \${id}\`;`,
        },
        // member-expression sql handle
        {
            code: `await this.sql\`UPDATE task_history SET error = \${this.sql.json(err)} WHERE id = \${id}\`;`,
        },
        {
            code: `await tx.sql\`INSERT INTO foo (payload) VALUES (\${tx.sql.json(data)})\`;`,
        },

        // ── explicit ::jsonb cast escape hatch ──────────────────────────
        {
            code: `await sql\`UPDATE foo SET payload = \${JSON.stringify(value)}::jsonb WHERE id = \${id}\`;`,
        },
        // Cast with whitespace
        {
            code: `await sql\`UPDATE foo SET payload = \${JSON.stringify(value)} :: jsonb WHERE id = \${id}\`;`,
        },

        // ── non-SQL contexts: rule must NOT fire ────────────────────────
        // HTTP body
        {
            code: `await fetch('https://x.example/hook', { body: JSON.stringify(payload) });`,
        },
        // Valkey/Redis publish payload (Glide accepts strings)
        {
            code: `await client.customCommand(['PUBLISH', 'channel', JSON.stringify({ a: 1 })]);`,
        },
        // Log message
        {
            code: `logger.warn('serialized', { raw: JSON.stringify(input) });`,
        },
        // Template literal that isn't a sql tag
        {
            code: `const s = \`debug: \${JSON.stringify(state)}\`;`,
        },
    ],
    invalid: [
        // ── bare stringify against sql tag ──────────────────────────────
        {
            code: `await sql\`UPDATE task_history SET result = \${JSON.stringify(result)} WHERE id = \${id}\`;`,
            errors: [{ messageId: 'bareStringify' }],
        },
        // Member-expression sql handle
        {
            code: `await this.sql\`UPDATE task_history SET error = \${JSON.stringify(err)} WHERE id = \${id}\`;`,
            errors: [{ messageId: 'bareStringify' }],
        },
        // Multiple bare stringifies in one template should each fire
        {
            code: `await sql\`UPDATE foo SET a = \${JSON.stringify(a)}, b = \${JSON.stringify(b)}\`;`,
            errors: [{ messageId: 'bareStringify' }, { messageId: 'bareStringify' }],
        },
        // INSERT VALUES position
        {
            code: `await sql\`INSERT INTO plugin_failure_events (meta) VALUES (\${JSON.stringify(meta)})\`;`,
            errors: [{ messageId: 'bareStringify' }],
        },
        // Conditional fragment inside template literal
        {
            code: `await sql\`UPDATE foo SET error = \${error ? JSON.stringify(error) : null} WHERE id = \${id}\`;`,
            errors: [{ messageId: 'bareStringify' }],
        },
    ],
});
