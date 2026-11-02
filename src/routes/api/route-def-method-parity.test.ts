// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard: a `+server.ts` that mounts an endpoint def must export exactly the
 * HTTP methods the def has handlers for.
 *
 * `export const { PATCH } = mount(def, …)` over a def with GET and PATCH
 * handlers leaves GET unreachable: SvelteKit answers 405 and the def's handler
 * is dead code. That shipped for `GET /api/v1/devices/{id}/actions/{actionId}`
 * (the sender's "starting on the TV…" poll). Nothing else compares the two
 * lists: the def tests call handlers directly, and the route-policy snapshot
 * only lists the routes that exist.
 *
 * File-based and parse-only (TypeScript AST, no imports of the defs), so it is
 * fast and needs no mocks. Covers the `export const { … } = mount(<def>, …)`
 * form; route files that destructure without exporting, or build the handlers
 * another way, are not compared.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import ts from 'typescript';

const ROUTES_API = resolve(__dirname);
const SRC = resolve(__dirname, '../..');
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Routes that deliberately differ from their def. Each MUST say why. The key is
 * the route dir relative to src/routes/api, the value the expected
 * `exported | handlers` pair, so a further change to either side still fails.
 */
const ALLOWED_MISMATCH: Record<string, { exported: string; handlers: string; why: string }> = {
    'v1/me/music/pinned-genres': {
        exported: 'GET/POST',
        handlers: 'DELETE/GET/POST',
        why: 'DELETE is mounted at v1/me/music/pinned-genres/[genre] so clients send no DELETE body',
    },
    'v1/me/music/pinned-genres/[genre]': {
        exported: 'DELETE',
        handlers: 'DELETE/GET/POST',
        why: 'only the per-genre DELETE is exposed here; GET/POST live on the collection route',
    },
    'v1/watch-together/[code]': {
        exported: 'GET',
        handlers: 'DELETE/GET',
        why: 'ending a session is deliberately not part of the public API (see the route file)',
    },
};

function collectServerFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectServerFiles(full, acc);
        else if (entry.name === '+server.ts') acc.push(full);
    }
    return acc;
}

function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function resolveModule(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('$lib/')) base = join(SRC, 'lib', spec.slice('$lib/'.length));
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return null;
    const candidates = [base.replace(/\.js$/, '.ts'), base + '.ts', join(base, 'index.ts')];
    return candidates.find((c) => existsSync(c)) ?? null;
}

interface Mount {
    exported: string[];
    defIdent: string;
}

/** `export const { A, B } = mount(ident, …)` statements of a route file. */
function findMounts(sf: ts.SourceFile): Mount[] {
    const out: Mount[] = [];
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const decl of stmt.declarationList.declarations) {
            const init = decl.initializer;
            if (!init || !ts.isCallExpression(init)) continue;
            if (!ts.isIdentifier(init.expression) || init.expression.text !== 'mount') continue;
            const first = init.arguments[0];
            if (!first || !ts.isIdentifier(first)) continue;
            if (!ts.isObjectBindingPattern(decl.name)) continue;
            const exported = decl.name.elements.map((el) =>
                (el.propertyName ?? el.name).getText(sf),
            );
            out.push({ exported, defIdent: first.text });
        }
    }
    return out;
}

/** The file a local identifier was imported from (`import { def as x } from …`). */
function importSource(sf: ts.SourceFile, ident: string): { file: string; name: string } | null {
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const named = stmt.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
            if (el.name.text !== ident) continue;
            const file = resolveModule(sf.fileName, stmt.moduleSpecifier.text);
            return file ? { file, name: (el.propertyName ?? el.name).text } : null;
        }
    }
    return null;
}

/** Handler method names of `export const <name> = defineEndpoint({ handlers: {…} })`, or null. */
function defHandlerMethods(file: string, name: string): string[] | null {
    const sf = parse(file);
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
            const init = decl.initializer;
            if (!init || !ts.isCallExpression(init)) return null;
            const arg = init.arguments[0];
            if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
            for (const prop of arg.properties) {
                if (!ts.isPropertyAssignment(prop) || prop.name.getText(sf) !== 'handlers')
                    continue;
                if (!ts.isObjectLiteralExpression(prop.initializer)) return null;
                return prop.initializer.properties
                    .map((p) => (p.name ? p.name.getText(sf) : ''))
                    .filter((n) => HTTP_METHODS.has(n))
                    .sort();
            }
            return null;
        }
    }
    return null;
}

interface Row {
    route: string;
    exported: string[];
    handlers: string[];
}

function collectRows(): Row[] {
    const rows: Row[] = [];
    for (const file of collectServerFiles(ROUTES_API)) {
        const sf = parse(file);
        for (const m of findMounts(sf)) {
            const src = importSource(sf, m.defIdent);
            if (!src) continue;
            const handlers = defHandlerMethods(src.file, src.name);
            if (!handlers) continue;
            rows.push({
                route: relative(ROUTES_API, dirname(file)),
                exported: [...m.exported].sort(),
                handlers,
            });
        }
    }
    return rows;
}

describe('api route files export the methods their def handles', () => {
    const rows = collectRows();

    it('finds the mount corpus', () => {
        // If discovery breaks (parse failure, moved defs) the guard silently passes.
        expect(rows.length).toBeGreaterThan(500);
    });

    it('exports exactly the def handler methods', () => {
        const mismatches = rows
            .filter((r) => r.exported.join(',') !== r.handlers.join(','))
            .filter((r) => {
                const allowed = ALLOWED_MISMATCH[r.route];
                return (
                    !allowed ||
                    allowed.exported !== r.exported.join('/') ||
                    allowed.handlers !== r.handlers.join('/')
                );
            })
            .map(
                (r) =>
                    `${r.route}: exports ${r.exported.join('/')} but the def handles ` +
                    `${r.handlers.join('/')}`,
            );
        expect(mismatches, mismatches.join('\n')).toEqual([]);
    });

    it('keeps the allowlist honest', () => {
        const byRoute = new Map(rows.map((r) => [r.route, r]));
        for (const [route, allowed] of Object.entries(ALLOWED_MISMATCH)) {
            const row = byRoute.get(route);
            expect(row, `ALLOWED_MISMATCH['${route}'] matches no mounted route`).toBeDefined();
            expect(
                row!.exported.join('/') === allowed.exported &&
                    row!.handlers.join('/') === allowed.handlers,
                `ALLOWED_MISMATCH['${route}'] is stale (${row!.exported.join('/')} vs ${row!.handlers.join('/')})`,
            ).toBe(true);
        }
    });
});
