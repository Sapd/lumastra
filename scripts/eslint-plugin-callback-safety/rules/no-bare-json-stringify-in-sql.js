// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-bare-json-stringify-in-sql
 *
 * Disallows `${JSON.stringify(x)}` bound directly into a `sql\`...\`` tagged
 * template literal. postgres.js binds the resulting string as TEXT; when the
 * target column is JSONB, PostgreSQL stores it as a JSONB *string scalar*
 * (`jsonb_typeof` returns `'string'`), not as the JSONB object the caller
 * intended. Subsequent `->>'field'` or `?` operators silently fail because
 * the value is a string, not an object.
 *
 * Preprod incident (2026-05-29): 100 % of `task_history.result` (1.06 M rows)
 * was string-encoded for the table's entire history because the runner used
 *   SET result = ${JSON.stringify(result)}
 * instead of
 *   SET result = ${sql.json(result)}
 * The throughput query in `lane-data.ts` then couldn't extract
 * `itemsProcessed`, the `/admin/tasks` ETA was always `null`, and the UI
 * silently dropped the "~Xh to drain" suffix. Four additional sites
 * (orchestrator.ts terminal-write, pending-write-drain.ts replay,
 * hard-kill.ts finalize, series-health.queries.ts upsert) had the same
 * pattern. See commits `faf0400fb`, `a51f74a89`.
 *
 * The fix is one of:
 *   - `${sql.json(value)}`     — postgres.js binary JSONB encoding (preferred)
 *   - `${JSON.stringify(value)}::jsonb` — explicit cast forces text→object
 *
 * Both produce a real JSONB object. Bare `${JSON.stringify(value)}` does not.
 *
 * Scope: only flags `JSON.stringify` calls that appear inside a `sql\`...\``
 * tagged template literal expression. String concatenation, `console.log`,
 * payload serialization for Valkey publish, HTTP body construction, etc.
 * are unaffected.
 *
 * Override: add `// eslint-disable-next-line callback-safety/no-bare-json-stringify-in-sql`
 * on the previous line when the surrounding expression demonstrates a TEXT
 * column (rare — `note`, `last_error TEXT`, etc.) or some other intentional
 * use.
 */

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow bare ${JSON.stringify(x)} inside sql`` tagged templates — use ${sql.json(x)} or add ::jsonb cast to avoid storing a JSONB string scalar instead of an object',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            bareStringify:
                "Bare `${JSON.stringify(...)}` inside a `sql\\`...\\`` template binds as TEXT and lands in a JSONB column as a string scalar (jsonb_typeof = 'string'), not as an object — `->>` and `?` will silently fail. Use `${sql.json(value)}` for proper JSONB encoding, or add an explicit `::jsonb` cast immediately after the placeholder.",
        },
    },

    create(context) {
        // Track whether we are currently inside a `sql\`...\`` template. The
        // listener model visits nodes in source order, so we maintain a depth
        // counter pushed on `sql\`...\`` enter, popped on exit.
        let sqlTemplateDepth = 0;

        function isSqlTag(node) {
            // Plain identifier: `sql\`...\``
            if (node.type === 'Identifier' && node.name === 'sql') return true;
            // Member: `this.sql\`...\``, `tx.sql\`...\``, `opts.sql\`...\``, etc.
            if (
                node.type === 'MemberExpression' &&
                node.property &&
                node.property.type === 'Identifier' &&
                node.property.name === 'sql'
            ) {
                return true;
            }
            // executor-style: `executor\`...\`` / `tag\`...\`` — common in tests
            // and helpers. We deliberately do NOT match these; the rule's job
            // is precise, not broad. If a helper aliases sql, it can rebind to
            // `sql` locally to opt in, or the false negative is acceptable.
            return false;
        }

        function isBareJsonStringify(node) {
            if (node.type !== 'CallExpression') return false;
            const callee = node.callee;
            if (callee.type !== 'MemberExpression') return false;
            if (callee.computed) return false;
            if (callee.object.type !== 'Identifier' || callee.object.name !== 'JSON') {
                return false;
            }
            if (callee.property.type !== 'Identifier' || callee.property.name !== 'stringify') {
                return false;
            }
            return true;
        }

        /**
         * Walk up the AST from a placeholder expression and check whether the
         * NEXT character after the `}` of `${...}` begins a `::jsonb` cast.
         * The token stream gives us the cleanest answer.
         */
        function hasJsonbCastAfter(node) {
            // The template literal closes the placeholder with `}` and continues
            // with the next quasi. Look at the raw text of the next quasi
            // and check if it begins (after optional whitespace) with `::jsonb`.
            // No need to walk the SourceCode tokens — the AST is sufficient.
            // Walk up to find the enclosing TemplateLiteral.
            let cur = node.parent;
            while (cur && cur.type !== 'TemplateLiteral') {
                cur = cur.parent;
            }
            if (!cur || cur.type !== 'TemplateLiteral') return false;
            const idx = cur.expressions.indexOf(getRootExpression(cur, node));
            if (idx === -1) return false;
            const nextQuasi = cur.quasis[idx + 1];
            if (!nextQuasi) return false;
            // Use cooked so escapes resolve; check the immediate prefix.
            const text = (nextQuasi.value && nextQuasi.value.cooked) || '';
            return /^\s*::\s*jsonb\b/i.test(text);
        }

        // Find which top-level placeholder expression `node` is inside, so the
        // cast-check looks at the placeholder's CLOSING `}`, not some inner one.
        function getRootExpression(template, node) {
            for (const expr of template.expressions) {
                let cur = node;
                while (cur) {
                    if (cur === expr) return expr;
                    cur = cur.parent;
                }
            }
            return node;
        }

        return {
            TaggedTemplateExpression(node) {
                if (isSqlTag(node.tag)) sqlTemplateDepth++;
            },
            'TaggedTemplateExpression:exit'(node) {
                if (isSqlTag(node.tag)) sqlTemplateDepth--;
            },
            CallExpression(node) {
                if (sqlTemplateDepth <= 0) return;
                if (!isBareJsonStringify(node)) return;
                if (hasJsonbCastAfter(node)) return;
                context.report({ node, messageId: 'bareStringify' });
            },
        };
    },
};
