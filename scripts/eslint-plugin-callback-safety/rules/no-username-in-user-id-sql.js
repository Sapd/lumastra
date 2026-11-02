// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-username-in-user-id-sql
 *
 * Since migration 16.46.0 re-keyed every user-data table, the `user_id`
 * (and `act_as_user`, `owner_user_id`) columns are `uuid REFERENCES users(id)`,
 * NOT the mutable username. Binding a username string into one of those columns
 * — or comparing such a column to a username in JS — is invisible to the
 * TypeScript compiler when it happens in raw `` sql`...` `` interpolation or a
 * `row.user_id === username` expression, yet it silently breaks at runtime:
 * either `invalid input syntax for type uuid` or (worse) a comparison that is
 * always false, so the user's data reads back empty / authorization is denied.
 *
 * This rule flags the two compiler-blind shapes:
 *   1. `` sql`... user_id = ${x} ...` `` where `x`'s source text mentions
 *      `username` (e.g. `${username}`, `${user.username}`, `${locals.user.username}`).
 *   2. `someRow.user_id === username` / `!==` (a uuid column compared to a username).
 *
 * The fix is to bind/compare the user's `users.id` UUID (a branded `UserId`):
 * `locals.user.userId`, or resolve `getUserIdByUsername(sql, username)` first.
 *
 * Intentional exceptions — the few columns deliberately LEFT as TEXT
 * (`user_stream_policies.user_id`/`updated_by`, `hls_playback_tokens.user_id`,
 * `service_tokens.created_by`, `task_webhook_hooks.created_by`) genuinely store
 * a username/sentinel; on those rare sites add
 * `// eslint-disable-next-line callback-safety/no-username-in-user-id-sql`.
 */

const USER_ID_COLS = '(?:user_id|act_as_user|owner_user_id)';
// preceding-quasi ends with `<col> =` / `<col> IN (` / `<col> !=` / `<col> <>`
const SQL_BIND_RE = new RegExp(`\\b${USER_ID_COLS}\\s*(?:=|!=|<>|IN\\s*\\()\\s*$`, 'i');
const USERNAME_RE = /\busername\b/i;
const USERID_RE = /\buser_?id\b/i; // allow `userId`/`user_id` expressions (already the UUID)
const COL_PROPS = new Set(['user_id', 'act_as_user', 'owner_user_id']);
// Static-SQL column-to-column join `<col> = <alias>.username` (or reverse) —
// e.g. `LEFT JOIN user_profiles up ON up.user_id = u.username`. No `${}`
// interpolation, so it lives entirely inside one quasi.
const SQL_COL_JOIN_RE = new RegExp(
    `\\b${USER_ID_COLS}\\s*=\\s*[a-z_][a-z0-9_]*\\.username\\b` +
        `|\\b[a-z_][a-z0-9_]*\\.username\\s*=\\s*(?:[a-z_][a-z0-9_]*\\.)?${USER_ID_COLS}\\b`,
    'i',
);

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow binding/comparing a username against a re-keyed uuid user_id column (mig 16.46.0) — bind the users.id UUID instead',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            sqlBind:
                'Binding `{{expr}}` into a uuid `user_id` column (re-keyed in mig 16.46.0). A username here fails at runtime / never matches — bind the users.id UUID (`locals.user.userId`, or `getUserIdByUsername(sql, username)`). If this column is an intentional TEXT exception, add an eslint-disable comment.',
            jsCompare:
                'Comparing a uuid `user_id` column to `{{expr}}` (a username). Post-mig-16.46.0 `user_id` is a UUID — compare against the users.id UUID (`locals.user.userId`).',
            sqlJoin:
                'SQL joins/compares a uuid `user_id` column to a `.username` column (post-mig-16.46.0 `user_id` is a UUID, not a username — `uuid = text` errors at runtime / 500s). Join on `users.id` instead (e.g. `ON up.user_id = u.id`).',
        },
    },

    create(context) {
        const sourceCode = context.sourceCode || context.getSourceCode();

        function isSqlTag(node) {
            if (node.type === 'Identifier') return /^(?:sql|tx|trx)$/.test(node.name);
            if (
                node.type === 'MemberExpression' &&
                node.property &&
                node.property.type === 'Identifier' &&
                node.property.name === 'sql'
            ) {
                return true;
            }
            return false;
        }

        // The expression text "looks like a username" if it mentions `username`
        // and does NOT look like an already-correct userId/uuid expression.
        function looksLikeUsername(text) {
            return USERNAME_RE.test(text) && !USERID_RE.test(text);
        }

        return {
            TaggedTemplateExpression(node) {
                if (!isSqlTag(node.tag)) return;
                const { quasis, expressions } = node.quasi;
                for (let i = 0; i < expressions.length; i++) {
                    const before = (quasis[i] && quasis[i].value && quasis[i].value.raw) || '';
                    if (!SQL_BIND_RE.test(before)) continue;
                    const expr = expressions[i];
                    const text = sourceCode.getText(expr);
                    if (looksLikeUsername(text)) {
                        context.report({ node: expr, messageId: 'sqlBind', data: { expr: text } });
                    }
                }
                // Static-SQL column-to-column join (`up.user_id = u.username`).
                for (const q of quasis) {
                    const raw = (q && q.value && q.value.raw) || '';
                    if (SQL_COL_JOIN_RE.test(raw)) {
                        context.report({ node, messageId: 'sqlJoin' });
                        break;
                    }
                }
            },
            BinaryExpression(node) {
                if (node.operator !== '===' && node.operator !== '!==') return;
                const sides = [
                    [node.left, node.right],
                    [node.right, node.left],
                ];
                for (const [maybeCol, other] of sides) {
                    if (
                        maybeCol.type === 'MemberExpression' &&
                        maybeCol.property &&
                        maybeCol.property.type === 'Identifier' &&
                        COL_PROPS.has(maybeCol.property.name)
                    ) {
                        const text = sourceCode.getText(other);
                        if (looksLikeUsername(text)) {
                            context.report({
                                node,
                                messageId: 'jsCompare',
                                data: { expr: text },
                            });
                            return;
                        }
                    }
                }
            },
        };
    },
};
