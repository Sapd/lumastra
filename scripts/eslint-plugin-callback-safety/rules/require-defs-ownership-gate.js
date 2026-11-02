// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * require-defs-ownership-gate
 *
 * A `{ kind: 'user' }` endpoint whose path carries a dynamic segment must show,
 * somewhere in the file, that the caller is part of the decision.
 *
 * ── Why a lint rule and not an AuthSpec kind ──
 *
 * `enforce()` in mount.ts has no `resourceOwner` kind and is deliberately
 * DB-free, so ownership lives in handlers. The 2026-09-07 IDOR audit read every
 * user-level `[id]`-bearing endpoint and found ZERO unscoped handlers — the
 * mechanism claim was true, the risk claim was not. It also found why a
 * declarative spec would not pay: only ~12 of ~58 endpoints have single-column
 * ownership; the rest need a role lattice, an author-or-admin disjunction, a
 * JWT-claim identity or a capability token, so 46 sites would end up checking by
 * hand anyway behind a spec that implied otherwise.
 *
 * What is worth mechanising is the SHAPE the audit had to check by hand: an
 * endpoint that takes a resource id from the path, is open to any signed-in
 * user, and mentions the caller nowhere. That is the one arrangement in which a
 * cross-user read or write is silent.
 *
 * ── Deliberately narrow ──
 *
 * Only `kind: 'user'`. `admin` and `scope` are gated by the scope itself — an
 * `[id]` there names a resource the caller is authorised to administer, not one
 * they own. Including them was measured first: it flags 104 files, nearly all
 * admin surfaces, which is the noise that gets a rule switched off.
 *
 * With this scope the current tree flags a single-digit number of files, and
 * they are exactly the ones the audit independently identified as open
 * questions. A rule whose baseline is the known findings is worth having; one
 * that needs 100 escape comments is theatre.
 *
 * ── Satisfying the rule ──
 *
 * Reference one of the sanctioned gates (list below), or thread the caller
 * (`locals.user`, `locals.principal`, a `userId`) into the decision, or state
 * why neither applies:
 *
 *     // ownership: <label> — <reason>
 *
 * The comment is greppable on purpose:
 *     grep -rn "ownership:" src/lib/server/api/defs
 * gives the inventory of endpoints that answer on a path id without consulting
 * the caller, which is the list a reviewer actually wants.
 */

/**
 * Gates that carry an ownership or access decision. Derived from what the
 * user-level defs actually import, not from a wish list — a name that is not in
 * use here does not belong in the rule.
 */
const SANCTIONED_GATES = [
    'getUserRole',
    'getPlaylistContext',
    'getPlaylistItemContext',
    'canEdit',
    'canView',
    'checkMediaAccess',
    'withMediaAccess',
    'mediaAccessGate',
    'resolveAndGate',
    'buildSearchAccessContext',
    'searchAccessBoundary',
    'toLibraryAccessUser',
    'filterAccessibleRows',
    'restrictedAccess',
    'resolveEpisodeContext',
    'moduleGateResponse',
    'getEffectiveUser',
];

/** Ways a handler can name the caller directly. */
const CALLER_REFERENCES = [
    'locals.user',
    'locals.principal',
    'userId',
    'principalScopes',
    'effectiveUser',
];

/**
 * `// ownership: <label> — <reason>`; the reason is required, a bare label is not.
 *
 * The whitespace after the colon is HORIZONTAL only (`[^\S\n]`). Written as
 * `\s*` it swallowed the newline and found the "reason" on the following line,
 * so a bare `// ownership:` sitting above the def satisfied the rule. Caught by
 * the bare-label case in this rule's own tests.
 */
const OWNERSHIP_ESCAPE = /^[^\S\n]*(?:\/\/|\*)[^\S\n]*ownership:[^\S\n]*\S+.*\S/im;

/** `auth: { kind: 'user' }`, tolerating whitespace and a trailing comma. */
const USER_AUTH = /auth\s*:\s*\{\s*kind\s*:\s*'user'\s*,?\s*\}/;

/** A `[param]` segment anywhere in the file's path. */
function hasDynamicSegment(filename) {
    return /\[[^\]]+\]/.test(filename);
}

function isDefsFile(filename) {
    const normalized = filename.replace(/\\/g, '/');
    return (
        normalized.includes('/src/lib/server/api/defs/') &&
        normalized.endsWith('.ts') &&
        !/\.(test|spec)\.ts$/.test(normalized)
    );
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'user-level API defs on a dynamic path must consult the caller, or declare why not with an `// ownership:` comment',
        },
        schema: [],
        messages: {
            // NB: no `{{ }}` anywhere in this string — ESLint reads a doubled brace
            // as a message placeholder and refuses to render it. Spelling the
            // AuthSpec out as `auth kind user` avoids that entirely.
            missingGate:
                "This def is `auth kind user` on a path with a dynamic segment, but nothing in the file consults the caller — no ownership/access gate and no reference to locals.user / locals.principal / a userId. Any signed-in user can address another user's resource by id. Gate it (getUserRole, checkMediaAccess, resolveAndGate, getPlaylistContext, …), thread the caller into the query, or declare the exception: `// ownership: <label> — <reason>`.",
        },
    },

    create(context) {
        const filename = context.filename ?? context.getFilename();
        if (!isDefsFile(filename) || !hasDynamicSegment(filename)) return {};

        return {
            'Program:exit'(node) {
                const source = context.sourceCode ?? context.getSourceCode();
                const text = source.getText();

                if (!USER_AUTH.test(text)) return;
                if (OWNERSHIP_ESCAPE.test(text)) return;
                if (SANCTIONED_GATES.some((gate) => text.includes(gate))) return;
                if (CALLER_REFERENCES.some((ref) => text.includes(ref))) return;

                context.report({ node, messageId: 'missingGate' });
            },
        };
    },
};
