// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parity guard: every method a def DOCUMENTS must actually be IMPLEMENTED.
 *
 * The OpenAPI generator builds the published spec from `def.docs`, while the
 * server only answers the methods present in `def.handlers` (re-exported by the
 * route's `+server.ts`). Nothing tied those two together, so a `docs.DELETE`
 * with no `handlers.DELETE` produced a spec — and a generated client — that
 * confidently emitted a call the server answers with 405.
 *
 * That is exactly what happened to `music/tracks/{id}/{like,dislike}`: both
 * documented a DELETE that was never written, so there was no way to un-like a
 * track on any client, on any environment, for as long as the docs had existed.
 * A 405 from a documented path is invisible to every check we run — the spec is
 * self-consistent, the types compile, and the route file looks fine on its own.
 *
 * This test reads the def sources statically rather than importing them: these
 * modules pull in services (DB, cache, task registry) at module scope, and
 * importing all ~600 of them to read two object literals is both slow and prone
 * to side effects.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DEFS_ROOT = resolve(__dirname, 'defs');

/**
 * Defs whose documented method is implemented OUTSIDE `handlers` — a
 * hand-written export in the route's `+server.ts`. Legitimate, but it must be
 * an explicit, justified exception rather than a silent hole.
 *
 * Format: `<def path relative to defs/>` → methods → why.
 */
const ROUTE_LEVEL_IMPLEMENTATIONS: Record<string, Record<string, string>> = {
    'catalog/media-id.ts': {
        DELETE:
            'routes/api/v1/media/[id]/+server.ts exports a hand-rolled DELETE that ' +
            'enforces the media:admin scope and delegates to the admin route.',
    },
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Strip comments and string/template literals so brace counting is reliable. */
function stripCommentsAndStrings(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            out += ' ';
            continue;
        }
        if (c === '/' && n === '/') {
            const end = src.indexOf('\n', i);
            i = end < 0 ? src.length : end;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (src[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            out += '""';
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** Extract the body of a top-level `key: { ... }` object literal. */
function objectLiteralBody(src: string, key: string): string | null {
    const match = src.search(new RegExp(`\\b${key}\\s*:\\s*\\{`));
    if (match < 0) return null;
    const start = src.indexOf('{', match);
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return src.slice(start + 1, i);
}

/** HTTP-method keys declared at the TOP level of an object-literal body. */
function topLevelMethodKeys(body: string | null): string[] {
    if (body === null) return [];
    // Keep only depth-0 characters, so nested objects/functions can't contribute.
    let depth = 0;
    let shallow = '';
    for (const ch of body) {
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        else if (depth === 0) shallow += ch;
        if (depth === 0 && (ch === '{' || ch === '(' || ch === '[')) shallow += ' ';
    }
    const found = new Set<string>();
    for (const m of shallow.matchAll(
        /(?:^|[,;])\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*:/g,
    )) {
        found.add(m[1]);
    }
    return [...found];
}

function collectDefFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectDefFiles(full, acc);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
}

describe('def docs/handlers method parity', () => {
    const files = collectDefFiles(DEFS_ROOT).filter((f) =>
        readFileSync(f, 'utf8').includes('defineEndpoint('),
    );

    it('finds the def corpus', () => {
        // Sanity: if the glob breaks, the whole guard silently passes.
        expect(files.length).toBeGreaterThan(100);
    });

    it('documents no method it does not implement', () => {
        const violations: string[] = [];

        for (const file of files) {
            const src = stripCommentsAndStrings(readFileSync(file, 'utf8'));
            const documented = topLevelMethodKeys(objectLiteralBody(src, 'docs'));
            const implemented = topLevelMethodKeys(objectLiteralBody(src, 'handlers'));
            const rel = relative(DEFS_ROOT, file);
            const allowed = ROUTE_LEVEL_IMPLEMENTATIONS[rel] ?? {};

            for (const method of documented) {
                if (implemented.includes(method)) continue;
                if (allowed[method]) continue;
                violations.push(
                    `${rel}: docs.${method} has no handlers.${method} — the spec advertises ` +
                        `${method} but the server will answer 405.`,
                );
            }
        }

        expect(violations, violations.join('\n')).toEqual([]);
    });

    it('keeps the route-level allowlist honest', () => {
        // A stale allowlist entry would mask a real regression later.
        for (const [rel, methods] of Object.entries(ROUTE_LEVEL_IMPLEMENTATIONS)) {
            const src = stripCommentsAndStrings(readFileSync(join(DEFS_ROOT, rel), 'utf8'));
            const documented = topLevelMethodKeys(objectLiteralBody(src, 'docs'));
            const implemented = topLevelMethodKeys(objectLiteralBody(src, 'handlers'));
            for (const method of Object.keys(methods)) {
                expect(HTTP_METHODS).toContain(method);
                expect(
                    documented.includes(method) && !implemented.includes(method),
                    `${rel}: allowlisted ${method} is no longer a docs-without-handler case — ` +
                        `remove the ROUTE_LEVEL_IMPLEMENTATIONS entry.`,
                ).toBe(true);
            }
        }
    });
});
