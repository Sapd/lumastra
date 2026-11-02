// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-direct-sql-begin
 *
 * Warns when service or plugin code calls `sql.begin(` or `sql.savepoint(`
 * directly. These calls crash at runtime when `sql` is a `ReservedSql`
 * (yielded by `sql.reserve()`), because postgres-js attaches `.begin` /
 * `.savepoint` to different Sql variants — despite the TypeScript types
 * claiming inheritance.
 *
 * The original incident (commit `de3943d8d`) caused ~41k Jellyfin episodes
 * in preprod to be created without TMDB external IDs, masked by an empty
 * `catch{}` reporting a misleading "external ID conflict" warning. A second
 * occurrence in the media-probe plugin caused 0% probe success across
 * thousands of files preprod-wide.
 *
 * Fix: use `withTx(sql, fn)` from `$lib/server/database/with-tx`. It detects
 * the variant at runtime and dispatches to `begin` / `savepoint` / manual
 * `BEGIN`/`COMMIT`/`ROLLBACK` as appropriate.
 *
 * Scope: only flags files under `src/lib/server/services/**` and
 * `src/lib/server/plugins/**`. Query modules
 * (`src/lib/server/database/queries/**`) are skipped because they typically
 * receive a top-level Sql and an AST-level "could be ReservedSql" check is
 * not feasible.
 *
 * Override: add `// eslint-disable-next-line callback-safety/no-direct-sql-begin`
 * on the line above the call when it is genuinely safe (e.g. inside the
 * helper itself, or in a context where a ReservedSql can never flow).
 */

const APPLICABLE_PATH_FRAGMENTS = ['/src/lib/server/services/', '/src/lib/server/plugins/'];

// Files that are themselves the helper / its tests, or were intentionally
// vetted as safe. Only the helper file itself should ever appear here without
// a per-line eslint-disable comment.
const EXEMPT_PATH_FRAGMENTS = [
    '/src/lib/server/database/with-tx.ts',
    '.test.ts',
    '.spec.ts',
    '.integration.test.ts',
];

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow direct sql.begin() / sql.savepoint() in services and plugins; use withTx() helper instead',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            directBegin:
                'Direct call to `sql.{{method}}()` is unsafe in services/plugins — it crashes when called with a ReservedSql (from `sql.reserve()`). Use `withTx(sql, fn)` from `$lib/server/database/with-tx` instead — it handles ReservedSql safely. See commit de3943d8d for the original bug.',
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename?.() || '';

        // Normalise to forward slashes for cross-platform path matching
        const normalised = filename.replace(/\\/g, '/');

        const isApplicable = APPLICABLE_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (!isApplicable) {
            return {};
        }

        const isExempt = EXEMPT_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (isExempt) {
            return {};
        }

        /**
         * Match any CallExpression whose callee is a MemberExpression with
         * a property name of "begin" or "savepoint". We intentionally do NOT
         * restrict the receiver name to "sql" — services frequently use
         * `tx.begin`, `this.sql.begin`, `reservedSql.begin`, etc. The cost
         * of a false positive on an unrelated `.begin(` is very low because
         * the ESLint disable comment is one line.
         */
        function check(node) {
            const callee = node.callee;
            if (!callee || callee.type !== 'MemberExpression') return;
            if (callee.computed) return;
            const prop = callee.property;
            if (!prop || prop.type !== 'Identifier') return;
            if (prop.name !== 'begin' && prop.name !== 'savepoint') return;

            // Skip Array#splice-style false positives — restrict to receivers
            // that look like SQL handles. This is a name-based heuristic and
            // will miss receivers with non-conventional names (e.g. a bare
            // `handle` or `connection`). W1.2 / future migrations should retire
            // this rule once all sql.begin callsites in services/plugins are
            // migrated to withTx.
            if (!receiverLooksLikeSql(callee.object)) return;

            context.report({
                node: callee.property,
                messageId: 'directBegin',
                data: { method: prop.name },
            });
        }

        function receiverLooksLikeSql(obj) {
            if (!obj) return false;
            if (obj.type === 'Identifier') {
                const n = obj.name.toLowerCase();
                return (
                    n.includes('sql') ||
                    n.includes('pg') ||
                    n.includes('conn') ||
                    n === 'tx' ||
                    n === 'db' ||
                    n.includes('reserved') ||
                    n.includes('client')
                );
            }
            if (obj.type === 'MemberExpression') {
                // this.sql, this.db, foo.sql, foo.tx, etc.
                if (obj.property && obj.property.type === 'Identifier') {
                    const n = obj.property.name.toLowerCase();
                    if (
                        n.includes('sql') ||
                        n.includes('pg') ||
                        n.includes('conn') ||
                        n === 'tx' ||
                        n === 'db' ||
                        n.includes('reserved') ||
                        n.includes('client')
                    ) {
                        return true;
                    }
                }
                // Recurse for chained access like ctx.dbContext.sql
                return receiverLooksLikeSql(obj.object);
            }
            if (obj.type === 'ChainExpression') {
                return receiverLooksLikeSql(obj.expression);
            }
            return false;
        }

        return {
            CallExpression: check,
        };
    },
};
