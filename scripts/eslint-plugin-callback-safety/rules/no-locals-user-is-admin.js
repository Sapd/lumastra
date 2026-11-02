// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-locals-user-is-admin
 *
 * In server code, admin authority is the CREDENTIAL's: `localsIsAdmin(locals)`
 * (`$lib/server/auth/locals-admin`), never `locals.user.isAdmin`. Scope: every
 * `src/**` TypeScript file except tests (GUARD N in eslint.config.cjs).
 *
 * ## Why this rule exists (spec 2026-10-07-auth-route-policy-design §5.1)
 *
 * `locals.user.isAdmin` is the OWNER's live admin status. For a token caller it
 * ignores the credential: an admin's OAuth device token, a read-only PAT or a
 * sandboxed service token has `locals.user.isAdmin === true` while its principal
 * (deriveIsAdmin: owner is admin AND the token carries an admin scope) is
 * non-admin. About twenty v1 handlers read the former, so such a token could
 * mint an admin PAT (fixed 1d115e8629), delete other users' comments and
 * annotations, read other users' stats and private watch parties, cancel other
 * users' sessions, or authorize an admin Jellyfin Quick Connect session.
 * `principal ?? user` fallbacks are flagged too: every resolveAuth branch sets
 * a principal, so a missing one must mean "not admin", not "ask the user row".
 *
 * ## What is flagged
 *
 * Reading `isAdmin` from `locals.user` in any spelling:
 *   locals.user.isAdmin, event.locals.user?.isAdmin, locals.user!.isAdmin,
 *   const u = locals.user; u.isAdmin, const { user } = locals; user?.isAdmin,
 *   const { isAdmin } = locals.user, (locals.user ?? x).isAdmin,
 *   ({ locals: { user } }) => user.isAdmin, and a helper parameter typed
 *   `App.Locals['user']` or `UserContext` (the shape of the pre-fix
 *   canAccessAnnotationType). An untyped helper parameter is not followed.
 *
 * Passing `locals.user` to a content-access helper (checkMediaAccess,
 * toLibraryAccessUser, ...) is NOT flagged: library and age visibility are the
 * user's own and those helpers are reviewed separately.
 *
 * ## Exceptions
 *
 * Option `allow`: `[{ file: '<path suffix>', reason: '<why>' }]`. A file on
 * the list may read `locals.user.isAdmin`; the reason is required so the
 * exception explains itself in eslint.config.cjs (GUARD N).
 */

function normalise(filename) {
    return String(filename).replace(/\\/g, '/');
}

/** Strip `x!` and `(x as T)` wrappers. */
function unwrap(node) {
    let n = node;
    while (
        n &&
        (n.type === 'TSNonNullExpression' ||
            n.type === 'TSAsExpression' ||
            n.type === 'ChainExpression')
    ) {
        n = n.expression;
    }
    return n;
}

function propName(member) {
    if (!member || member.type !== 'MemberExpression') return null;
    if (!member.computed && member.property.type === 'Identifier') return member.property.name;
    if (member.computed && member.property.type === 'Literal') return String(member.property.value);
    return null;
}

/** `locals` or `<anything>.locals`. */
function isLocals(node) {
    const n = unwrap(node);
    if (!n) return false;
    if (n.type === 'Identifier') return n.name === 'locals';
    return propName(n) === 'locals';
}

/**
 * `locals.user` / `event.locals.user` (any optional / non-null spelling), also
 * behind `??` / `||` (`locals.user ?? fallback`).
 */
function isLocalsUser(node) {
    const n = unwrap(node);
    if (!n) return false;
    if (n.type === 'LogicalExpression') return isLocalsUser(n.left) || isLocalsUser(n.right);
    return propName(n) === 'user' && isLocals(n.object);
}

/** Does this ObjectPattern bind `user` (from a `locals` object) to `name`? */
function patternBindsUser(pattern, name) {
    return pattern.properties.some(
        (p) =>
            p.type === 'Property' &&
            !p.computed &&
            p.key.type === 'Identifier' &&
            p.key.name === 'user' &&
            p.value.type === 'Identifier' &&
            p.value.name === name,
    );
}

/** Does this parameter pattern destructure `{ locals: { user } }` into `name`? */
function paramBindsLocalsUser(pattern, name) {
    if (!pattern || pattern.type !== 'ObjectPattern') return false;
    return pattern.properties.some(
        (p) =>
            p.type === 'Property' &&
            !p.computed &&
            p.key.type === 'Identifier' &&
            p.key.name === 'locals' &&
            p.value.type === 'ObjectPattern' &&
            patternBindsUser(p.value, name),
    );
}

/** A parameter annotated `App.Locals['user']` (or `UserContext`): it IS locals.user. */
function isUserTypedParam(identifier) {
    const ann = identifier.typeAnnotation && identifier.typeAnnotation.typeAnnotation;
    if (!ann) return false;
    const text = (t) => {
        if (!t) return '';
        if (t.type === 'TSTypeReference') {
            const n = t.typeName;
            return n.type === 'Identifier' ? n.name : `${n.left.name}.${n.right.name}`;
        }
        return '';
    };
    const candidates = ann.type === 'TSUnionType' ? ann.types : [ann];
    return candidates.some((t) => {
        if (t.type === 'TSIndexedAccessType') {
            const idx = t.indexType;
            return (
                text(t.objectType) === 'App.Locals' &&
                idx.type === 'TSLiteralType' &&
                idx.literal.value === 'user'
            );
        }
        return text(t) === 'UserContext';
    });
}

/** Does this identifier resolve to a variable or parameter bound to `locals.user`? */
function isAliasOfLocalsUser(context, identifier) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    let scope = sourceCode.getScope ? sourceCode.getScope(identifier) : context.getScope();
    while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) {
            return variable.defs.some((def) => {
                if (def.type === 'Parameter') {
                    // ({ locals: { user } }) => user.isAdmin
                    if (paramBindsLocalsUser(def.node.params?.[def.index ?? 0], identifier.name)) {
                        return true;
                    }
                    // function f(user: App.Locals['user']) { user.isAdmin }
                    return def.name.type === 'Identifier' && isUserTypedParam(def.name);
                }
                if (def.type !== 'Variable') return false;
                const declarator = def.node;
                if (!declarator.init) return false;
                // const u = locals.user
                if (declarator.id.type === 'Identifier') return isLocalsUser(declarator.init);
                // const { user } = locals   /   const { user: u } = event.locals
                if (declarator.id.type === 'ObjectPattern' && isLocals(declarator.init)) {
                    return patternBindsUser(declarator.id, identifier.name);
                }
                return false;
            });
        }
        scope = scope.upper;
    }
    return false;
}

/** The owner's admin flag: `isAdmin`, renamed `ownerIsAdmin` (UserContext). */
const OWNER_FLAG_NAMES = new Set(['isAdmin', 'ownerIsAdmin']);

const MESSAGE =
    'Admin authority comes from the credential: use `localsIsAdmin(locals)` ' +
    '($lib/server/auth/locals-admin), which reads the principal. ' +
    "`locals.user.isAdmin` is the owner's admin status, true for an admin's device token " +
    'or low-scope PAT whose principal is non-admin (spec 2026-10-07 §5.1).';

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Forbid reading locals.user.isAdmin in server code',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    allow: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                file: { type: 'string', minLength: 1 },
                                reason: { type: 'string', minLength: 10 },
                            },
                            required: ['file', 'reason'],
                            additionalProperties: false,
                        },
                    },
                },
                additionalProperties: false,
            },
        ],
        messages: { userIsAdmin: MESSAGE },
    },

    create(context) {
        const filename = normalise(context.filename ?? context.getFilename());
        const allow = (context.options[0] && context.options[0].allow) || [];
        if (allow.some((entry) => filename.endsWith(entry.file))) return {};

        return {
            MemberExpression(node) {
                // `ownerIsAdmin` is the same owner flag under its 2026-10-13 name.
                if (!OWNER_FLAG_NAMES.has(propName(node))) return;
                const object = unwrap(node.object);
                if (!object) return;
                if (isLocalsUser(object)) {
                    context.report({ node, messageId: 'userIsAdmin' });
                    return;
                }
                if (object.type === 'Identifier' && isAliasOfLocalsUser(context, object)) {
                    context.report({ node, messageId: 'userIsAdmin' });
                }
            },
            // const { isAdmin } = locals.user
            VariableDeclarator(node) {
                if (node.id.type !== 'ObjectPattern' || !node.init || !isLocalsUser(node.init))
                    return;
                for (const p of node.id.properties) {
                    if (
                        p.type === 'Property' &&
                        !p.computed &&
                        p.key.type === 'Identifier' &&
                        OWNER_FLAG_NAMES.has(p.key.name)
                    ) {
                        context.report({ node: p, messageId: 'userIsAdmin' });
                    }
                }
            },
        };
    },
};
