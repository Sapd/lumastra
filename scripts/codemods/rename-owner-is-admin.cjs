// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Codemod: rename the credential OWNER's admin flag from `isAdmin` to
 * `ownerIsAdmin` on `UserContext` (src/lib/server/types.ts) and `UserPermissions`
 * (src/lib/server/auth.ts) and `SubsonicAuthContext`, so nothing can read it as "this request is admin".
 * The request's admin verdict is `localsIsAdmin(locals)`.
 *
 * Symbol-based (ts-morph / the TypeScript language service), not a text
 * replace: every reference the type checker ties to those two properties is
 * renamed, and nothing else (Principal.isAdmin, LibraryAccessUser.isAdmin,
 * AppUserInfo.isAdmin, DB rows and API schemas keep their names).
 *
 * Two hazards a rename cannot see, reported by --scan and by --apply before it
 * writes anything (exit 2 when unexpected ones exist):
 *   H1  an OPTIONAL `isAdmin` in a type a UserContext/UserPermissions can be
 *       passed to: after the rename the value still type-checks there but its
 *       `isAdmin` is silently undefined.
 *   H2  an object literal that spreads such a value AND sets `isAdmin`: after
 *       the rename the spread brings `ownerIsAdmin`, and a reader of the renamed
 *       field no longer sees the override.
 * Known, reviewed hits are listed in EXPECTED_* below with the reason.
 *
 * Test fixtures that build locals by hand (`locals: { user: { isAdmin } }`,
 * `locals.user.isAdmin = x`) are untyped, so the checker cannot follow them; in
 * test files only, those exact shapes are renamed too.
 *
 * ts-morph is not a project dependency. Run on the runner, from the app root:
 *   npm i --prefix /tmp/tsm ts-morph@27 >/dev/null
 *   NODE_PATH=/tmp/tsm/node_modules node scripts/codemods/rename-owner-is-admin.cjs --scan
 *   NODE_PATH=/tmp/tsm/node_modules node scripts/codemods/rename-owner-is-admin.cjs --apply
 * (svelte-kit sync must have run: tsconfig.json extends .svelte-kit/tsconfig.json.)
 */

'use strict';

const path = require('node:path');
const { Project, Node, SyntaxKind } = require('ts-morph');

const ROOT = path.resolve(__dirname, '../..');
const NEW_NAME = 'ownerIsAdmin';
const TARGETS = [
    { file: 'src/lib/server/types.ts', iface: 'UserContext' },
    { file: 'src/lib/server/auth.ts', iface: 'UserPermissions' },
    // Subsonic's own auth context carries the same owner flag into
    // toLibraryAccessUser (found by H3).
    { file: 'src/lib/server/subsonic-compat/types.ts', iface: 'SubsonicAuthContext' },
];

/**
 * H1 sinks that READ THE OWNER FLAG of a UserContext they are handed: renamed
 * together with UserContext. Key: `<file>:<declaration>:<holder>`.
 */
const LINKED_SINKS = new Set([
    'src/lib/server/auth/locals-admin.ts:AdminDecisionLocals:user',
    'src/lib/server/admin/admin-action-gate.ts:AdminActionLocals:user',
    'src/lib/server/auth/admin-route-gate.ts:AdminGateEvent:user',
    'src/lib/server/auth/route-policy/shadow.ts:user:as',
    'src/lib/server/cache/library-group-permissions-cache.ts:toLibraryAccessUser:localsUser',
    'src/lib/server/proprietary/jellyfin-compat/access-context.ts:JellyfinAccessUser:JellyfinAccessUser',
    'src/lib/server/proprietary/jellyfin-compat/library-views-utils.ts:LibraryViewUser:LibraryViewUser',
]);

/** Reviewed H1 sinks that keep `isAdmin`: every caller passes an explicit value. */
const EXPECTED_H1 = new Map([
    [
        'src/lib/server/auth/locals-admin.ts:AdminDecisionLocals:principal',
        'the principal verdict, not the owner flag',
    ],
    [
        'src/lib/server/admin/admin-action-gate.ts:AdminActionLocals:principal',
        'the principal verdict',
    ],
    ['src/lib/server/auth/admin-route-gate.ts:AdminGateEvent:principal', 'the principal verdict'],
    [
        'src/lib/api/schema.d.ts:operations:"application/json"',
        'generated OpenAPI types, never handed a UserContext',
    ],
    [
        'src/lib/components/music/music-track-menu.ts:MusicTrackMenuOptions:MusicTrackMenuOptions',
        'client menu options, never a UserContext',
    ],
    [
        'src/lib/server/navigation/visible-nav-items.ts:NavViewer:NavViewer',
        'the layout passes the verdict as isAdmin',
    ],
    [
        'src/lib/server/plugins/runtime/widget-metadata.ts:listPluginNavEntries:user',
        'the layout passes the verdict as isAdmin',
    ],
    [
        'src/lib/server/services/active-sessions-view.service.ts:SessionViewer:SessionViewer',
        'callers pass an explicit isAdmin',
    ],
]);
/** Literals that spread a UserContext and set `isAdmin` on purpose (after the rename). */
const EXPECTED_H2 = new Map([
    [
        'src/routes/+layout.server.ts',
        'page data and nav viewer get the verdict as isAdmin for the client',
    ],
    ['src/routes/admin/+layout.server.ts', 'page data gets the verdict as isAdmin for the client'],
]);

const mode = process.argv.includes('--apply') ? 'apply' : 'scan';

const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
});
const rel = (sf) => path.relative(ROOT, sf.getFilePath());
const isTestFile = (p) => /\.(test|spec|integration\.test)\.ts$|test-helpers\.ts$/.test(p);

/** Fresh on every call: a rename rebuilds the program and invalidates nodes and types. */
function targetInterfaces() {
    return TARGETS.map(({ file, iface }) =>
        project.getSourceFileOrThrow(path.join(ROOT, file)).getInterfaceOrThrow(iface),
    );
}

function isTargetProp(sig) {
    return targetInterfaces().some((i) => i.getProperties().includes(sig));
}

/** Can a UserContext/UserPermissions value be assigned to this type? */
function receivesTarget(type) {
    const tc = project.getTypeChecker().compilerObject;
    return targetInterfaces().some((i) =>
        tc.isTypeAssignableTo(i.getType().compilerType, type.compilerType),
    );
}

function declName(node) {
    const owner = node.getFirstAncestor(
        (a) =>
            Node.isFunctionDeclaration(a) ||
            Node.isMethodDeclaration(a) ||
            Node.isInterfaceDeclaration(a) ||
            Node.isTypeAliasDeclaration(a) ||
            Node.isVariableDeclaration(a) ||
            Node.isArrowFunction(a),
    );
    if (!owner) return '<module>';
    const n = typeof owner.getName === 'function' ? owner.getName() : undefined;
    return n ?? `${owner.getKindName()}@${owner.getStartLineNumber()}`;
}

/** What holds the type literal: the property/parameter name, `as`, or the interface. */
function holderName(sig) {
    const container = sig.getParent();
    if (Node.isInterfaceDeclaration(container)) return container.getName();
    let holder = container && container.getParent();
    // `{ … } | null | undefined`, `({ … })`: the holder is above the wrapper types.
    while (holder && (Node.isUnionTypeNode(holder) || Node.isParenthesizedTypeNode(holder))) {
        holder = holder.getParent();
    }
    if (!holder) return '?';
    if (Node.isAsExpression(holder)) return 'as';
    if (typeof holder.getName === 'function') return holder.getName() ?? '?';
    return holder.getKindName();
}

function scanH1() {
    const hits = [];
    for (const sf of project.getSourceFiles()) {
        const file = rel(sf);
        if (
            file.startsWith('..') ||
            file.includes('node_modules') ||
            file.startsWith('.svelte-kit')
        )
            continue;
        for (const sig of sf.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
            if (sig.getName() !== 'isAdmin' || !sig.hasQuestionToken()) continue;
            if (isTargetProp(sig)) continue;
            const container = sig.getParent();
            if (!container) continue;
            if (!receivesTarget(container.getType())) continue;
            const key = `${file}:${declName(sig)}:${holderName(sig)}`;
            hits.push({ key, line: sig.getStartLineNumber(), test: isTestFile(file), sig });
        }
    }
    return hits;
}

function scanH2() {
    const hits = [];
    for (const sf of project.getSourceFiles()) {
        const file = rel(sf);
        if (
            file.startsWith('..') ||
            file.includes('node_modules') ||
            file.startsWith('.svelte-kit')
        )
            continue;
        for (const lit of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
            const props = lit.getProperties();
            const setsIsAdmin = props.some(
                (p) =>
                    (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) &&
                    p.getName() === 'isAdmin',
            );
            if (!setsIsAdmin) continue;
            const spreadsTarget = props.some(
                (p) => Node.isSpreadAssignment(p) && receivesTarget(p.getExpression().getType()),
            );
            if (!spreadsTarget) continue;
            hits.push({ key: file, line: lit.getStartLineNumber(), test: isTestFile(file) });
        }
    }
    return hits;
}

function report(name, hits, expected) {
    const unexpected = hits.filter((h) => !h.test && !expected.has(h.key));
    for (const h of hits) {
        const tag = h.test ? 'test' : expected.has(h.key) ? 'reviewed' : 'UNEXPECTED';
        console.log(
            `${name} ${tag} ${h.key}:${h.line}${expected.has(h.key) ? ` — ${expected.get(h.key)}` : ''}`,
        );
    }
    return unexpected.length;
}

/**
 * `Pick<UserContext, 'userId' | 'isAdmin'>` / `Omit<…, 'isAdmin'>`: the key is a
 * string literal, which the language-service rename does not touch.
 */
function renamePickKeys() {
    const names = new Set(TARGETS.map((t) => t.iface));
    let n = 0;
    for (const sf of project.getSourceFiles()) {
        const file = rel(sf);
        if (
            file.startsWith('..') ||
            file.includes('node_modules') ||
            file.startsWith('.svelte-kit')
        )
            continue;
        // Collect ranges first, then edit from the end: an edit invalidates nodes.
        const edits = [];
        for (const ref of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
            const typeName = ref.getTypeName().getText();
            if (typeName !== 'Pick' && typeName !== 'Omit') continue;
            const [base, keys] = ref.getTypeArguments();
            if (!base || !keys) continue;
            const baseName = base.getText().replace(/^.*\./, '');
            if (!names.has(baseName)) continue;
            for (const lit of [keys, ...keys.getDescendants()]) {
                if (
                    Node.isLiteralTypeNode(lit) &&
                    lit.getText().replace(/['"]/g, '') === 'isAdmin'
                ) {
                    const q = lit.getText()[0];
                    edits.push([lit.getStart(), lit.getEnd(), `${q}${NEW_NAME}${q}`]);
                }
            }
        }
        edits.sort((x, y) => y[0] - x[0]);
        for (const [start, end, text] of edits) {
            sf.replaceText([start, end], text);
            n++;
        }
    }
    return n;
}

/**
 * Test files whose fixtures are untyped helper objects or casts the checker
 * cannot tie to UserContext (found by typecheck after a first run). In these,
 * every `isAdmin` key, type member and access is the owner flag, except under
 * a `principal`.
 */
const FIXTURE_FILES = [
    'src/lib/server/services/rating-manager.service.test.ts',
    'src/lib/server/services/jellyfin-watchlist-import.service.test.ts',
    'src/lib/server/proprietary/jellyfin-compat/remote-control/sessions-list.test.ts',
    'src/lib/server/proprietary/jellyfin-compat/library-views-utils.integration.test.ts',
    'src/lib/server/api/defs/playlists/[id]/items/bulk.test.ts',
    'src/lib/server/api/defs/admin/devices/index.integration.test.ts',
    'src/lib/server/auth/admin-route-gate.test.ts',
];

function underPrincipal(node) {
    return !!node.getFirstAncestor(
        (a) =>
            (Node.isPropertyAssignment(a) || Node.isPropertySignature(a)) &&
            a.getName() === 'principal',
    );
}

function renameListedFixtures() {
    let n = 0;
    for (const file of FIXTURE_FILES) {
        const sf = project.getSourceFileOrThrow(path.join(ROOT, file));
        const edits = [];
        for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
            if (id.getText() !== 'isAdmin') continue;
            const parent = id.getParent();
            const isKey =
                (Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent)) &&
                parent.getNameNode() === id;
            const isAccess = Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id;
            if (!isKey && !isAccess) continue;
            if (underPrincipal(id)) continue;
            if (isAccess && /\bprincipal\b/.test(parent.getExpression().getText())) continue;
            edits.push([id.getStart(), id.getEnd()]);
        }
        edits.sort((a, b) => b[0] - a[0]);
        for (const [start, end] of edits) {
            sf.replaceText([start, end], NEW_NAME);
            n++;
        }
    }
    return n;
}

/** In test files only: `locals: { user: { isAdmin } }` and `locals.user.isAdmin = …`. */
function renameTestFixtures() {
    let n = 0;
    for (const sf of project.getSourceFiles()) {
        if (!isTestFile(rel(sf))) continue;
        for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
            if (pa.getName() !== 'isAdmin') continue;
            const userLit = pa.getParent();
            const userProp = userLit && userLit.getParent();
            if (!Node.isPropertyAssignment(userProp) || userProp.getName() !== 'user') continue;
            const localsLit = userProp.getParent();
            const localsProp = localsLit && localsLit.getParent();
            if (!Node.isPropertyAssignment(localsProp) || localsProp.getName() !== 'locals')
                continue;
            pa.getNameNode().replaceWithText(NEW_NAME);
            n++;
        }
        for (const pae of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
            if (pae.wasForgotten() || pae.getName() !== 'isAdmin') continue;
            const obj = pae.getExpression();
            if (!Node.isPropertyAccessExpression(obj) || obj.getName() !== 'user') continue;
            const loc = obj.getExpression();
            const locName = Node.isPropertyAccessExpression(loc) ? loc.getName() : loc.getText();
            if (locName !== 'locals') continue;
            pae.getNameNode().replaceWithText(NEW_NAME);
            n++;
        }
    }
    return n;
}

/**
 * H3, after the rename: an argument that still carries `isAdmin` (and no
 * `ownerIsAdmin`) where the parameter now expects `ownerIsAdmin`.
 */
function scanH3() {
    const hits = [];
    const tc = project.getTypeChecker().compilerObject;
    for (const sf of project.getSourceFiles()) {
        const file = rel(sf);
        if (
            file.startsWith('..') ||
            file.includes('node_modules') ||
            file.startsWith('.svelte-kit')
        )
            continue;
        for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            for (const arg of call.getArguments()) {
                const ctx = tc.getContextualType(arg.compilerNode);
                if (!ctx) continue;
                const wants = (t) => t.getProperty && t.getProperty(NEW_NAME);
                const ctxTypes = ctx.isUnion() ? ctx.types : [ctx];
                if (!ctxTypes.some(wants)) continue;
                const argType = arg.getType();
                if (argType.getProperty('isAdmin') && !argType.getProperty(NEW_NAME)) {
                    hits.push({
                        key: file,
                        line: arg.getStartLineNumber(),
                        test: isTestFile(file),
                    });
                }
            }
        }
    }
    return hits;
}

const h1 = scanH1();
let unexpected = 0;
for (const h of h1) {
    const tag = h.test
        ? 'test'
        : LINKED_SINKS.has(h.key)
          ? 'linked'
          : EXPECTED_H1.has(h.key)
            ? 'reviewed'
            : 'UNEXPECTED';
    if (tag === 'UNEXPECTED') unexpected++;
    console.log(`H1 ${tag} ${h.key}:${h.line}`);
}
const missingLinks = [...LINKED_SINKS].filter((k) => !h1.some((h) => h.key === k));
for (const k of missingLinks)
    console.log(`H1 MISSING linked sink ${k} (moved or renamed? update the list)`);
if (unexpected > 0 || missingLinks.length > 0) {
    console.error('H1 review needed before renaming.');
    process.exit(2);
}
if (mode === 'scan') {
    console.log('scan clean (H2/H3 are checked after the rename, in --apply)');
    process.exit(0);
}

// Linked sinks first, one at a time on fresh nodes (a rename invalidates others).
for (;;) {
    const next = scanH1().find((h) => !h.test && LINKED_SINKS.has(h.key));
    if (!next) break;
    next.sig.rename(NEW_NAME, { usePrefixAndSuffixText: true });
    console.log(`renamed sink ${next.key}`);
}
for (const t of TARGETS) {
    const sf = project.getSourceFileOrThrow(path.join(ROOT, t.file));
    sf.getInterfaceOrThrow(t.iface)
        .getPropertyOrThrow('isAdmin')
        .rename(NEW_NAME, { usePrefixAndSuffixText: true });
    console.log(`renamed ${t.iface}.isAdmin -> ${NEW_NAME}`);
}
console.log(`Pick/Omit keys renamed: ${renamePickKeys()}`);
console.log(`test fixtures renamed: ${renameTestFixtures()}`);
console.log(`listed fixture files renamed: ${renameListedFixtures()}`);

const post = report('H2', scanH2(), EXPECTED_H2) + report('H3', scanH3(), new Map());
if (post > 0) {
    console.error(`${post} hazard(s) after the rename: nothing saved.`);
    process.exit(3);
}
project.saveSync();
console.log('saved');
