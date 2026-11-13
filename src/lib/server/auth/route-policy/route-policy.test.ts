// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route policy table covers every route, explains every opening, and shows
 * every change in review.
 *
 * - coverage: every route id × method in src/routes resolves to exactly one rule
 *   (no ties, no unmatched ids; `(enterprise)` ids are registered separately);
 * - every `public` / `token-surface` row carries a reason;
 * - every token-surface route references one of its rule's authenticators —
 *   the only check that sees a forgotten `withJellyfinAuth`, because such a
 *   row allows every request at the hooks level;
 * - no dead rules;
 * - loosening (admin → user, user → public, anything → token-surface) needs a
 *   `loosens:` reason on the rule;
 * - route-policy.snapshot.txt lists every row. After a route or rule change:
 *       npx vitest run src/lib/server/auth/route-policy -u
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listRouteFiles } from '../route-tree.test-helpers.js';
import {
    createPolicyTable,
    isPrivateRouteId,
    normalizeRouteId,
    policyForMethod,
    strictness,
    type RoutePolicy,
    type RouteRule,
} from './policy.js';
import { ROUTE_POLICY_RULES } from './rules.js';

const SNAPSHOT = join(__dirname, 'route-policy.snapshot.txt');
const HANDLER_NAMES = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'fallback'];

/** Resolve a relative `from '…'` specifier of `file` to a .ts file, if it exists. */
function resolveRelative(file: string, spec: string): string | null {
    let target = resolve(dirname(file), spec);
    if (!target.endsWith('.ts')) target = target.replace(/\.js$/, '') + '.ts';
    return existsSync(target) ? target : null;
}

/**
 * Handler names a route module exports: declarations, destructured
 * `export const { GET } = …`, `export { GET } from '…'`, and `export * from '…'`
 * (followed, two levels deep).
 */
function exportedHandlers(file: string, depth = 0): string[] {
    const src = readFileSync(file, 'utf8');
    const names = new Set<string>();
    for (const m of src.matchAll(/export\s+(?:const|let|async\s+function|function)\s+(\w+)/g)) {
        names.add(m[1]);
    }
    for (const m of src.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) {
        for (const part of m[1].split(','))
            names.add(
                part
                    .trim()
                    .split(/\s*:\s*/)
                    .pop()!
                    .trim(),
            );
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(','))
            names.add(
                part
                    .trim()
                    .split(/\s+as\s+/)
                    .pop()!
                    .trim(),
            );
    }
    if (depth < 2) {
        for (const m of src.matchAll(/export\s*\*\s*from\s*'(\.[^']+)'/g)) {
            const target = resolveRelative(file, m[1]);
            if (target) for (const n of exportedHandlers(target, depth + 1)) names.add(n);
        }
    }
    return HANDLER_NAMES.filter((n) => names.has(n));
}

/** Source text without comments, so a symbol named only in a comment does not count. */
function code(file: string): string {
    return readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The file plus every module it re-exports from, and every sibling route
 * handler it imports (`import { GET as x } from '../stream/+server'`, a route
 * that wraps another route's handler), two levels deep, comments stripped.
 * Only `+server` imports are followed: the imported route is itself a row of
 * this table, so its own authenticator is checked there.
 */
function sourcesOf(file: string, depth = 0): string[] {
    const src = code(file);
    const out = [src];
    if (depth >= 2) return out;
    for (const m of src.matchAll(/export\s*(?:\{[^}]*\}|\*)\s*from\s*'(\.[^']+)'/g)) {
        const target = resolveRelative(file, m[1]);
        if (target) out.push(...sourcesOf(target, depth + 1));
    }
    for (const m of src.matchAll(/import\s*\{[^}]*\}\s*from\s*'(\.[^']*\/\+server)'/g)) {
        const target = resolveRelative(file, m[1]);
        if (target) out.push(...sourcesOf(target, depth + 1));
    }
    return out;
}

/**
 * Called, imported, or re-exported as a handler (`export { handleX as GET } from`).
 * A wrapper applied as `withX(handler)` is a call too.
 */
function references(text: string, symbol: string): boolean {
    return (
        new RegExp(`\\b${symbol}\\s*\\(`).test(text) ||
        new RegExp(`(?:import|export)\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`).test(text)
    );
}

interface Row {
    id: string;
    method: string;
    policy: RoutePolicy;
    rule: RouteRule;
    file: string;
}

const table = createPolicyTable(ROUTE_POLICY_RULES);
const routeFiles = listRouteFiles().filter((f) => !isPrivateRouteId(f.id));

const rows: Row[] = [];
const unmatched: string[] = [];
const ties: string[] = [];
{
    const methodsById = new Map<string, Map<string, string>>();
    for (const f of routeFiles) {
        let methods: string[] = [];
        if (f.name.startsWith('+server')) {
            methods = exportedHandlers(f.file).map((m) => (m === 'fallback' ? '*' : m));
        } else if (/^\+page(@[^.]*)?(\.server)?\.(ts|js|svelte)$/.test(f.name)) {
            methods = ['GET'];
            if (
                f.name.includes('.server.') &&
                /export\s+const\s+actions\b/.test(readFileSync(f.file, 'utf8'))
            ) {
                methods.push('POST');
            }
        }
        const byMethod = methodsById.get(f.id) ?? new Map<string, string>();
        for (const m of methods) if (!byMethod.has(m)) byMethod.set(m, f.file);
        methodsById.set(f.id, byMethod);
    }
    for (const [id, byMethod] of [...methodsById].sort(([a], [b]) => a.localeCompare(b))) {
        if (byMethod.size === 0) continue; // layout-only directory: not a route
        const match = table.match(id);
        if (!match) {
            unmatched.push(id);
            continue;
        }
        if (match.tie) ties.push(`${id}: ${match.rule.pattern} vs ${match.tie.pattern}`);
        for (const [method, file] of [...byMethod].sort(([a], [b]) => a.localeCompare(b))) {
            const policy = policyForMethod(match.rule, method === '*' ? 'PATCH' : method);
            rows.push({ id, method, policy, rule: match.rule, file });
        }
    }
}

function snapshotText(): string {
    return (
        rows.map((r) => `${r.id} ${r.method} ${r.policy}  <- ${r.rule.pattern}`).join('\n') + '\n'
    );
}

describe('route policy table', () => {
    it('finds the route tree (sanity)', () => {
        expect(rows.length).toBeGreaterThan(1000);
    });

    it('every route id resolves to exactly one rule', () => {
        expect(unmatched, 'route ids without a rule: add a row to rules.ts').toEqual([]);
        expect(ties, 'rules that tie for the same route id').toEqual([]);
    });

    it('every public and token-surface rule carries a reason', () => {
        const missing = ROUTE_POLICY_RULES.filter((r) => {
            const policies = typeof r.policy === 'string' ? [r.policy] : Object.values(r.policy);
            return policies.some((p) => strictness(p) === 0) && !r.reason;
        }).map((r) => r.pattern);
        expect(missing).toEqual([]);
    });

    it('every rule matches at least one route id', () => {
        const used = new Set(rows.map((r) => r.rule));
        const dead = ROUTE_POLICY_RULES.filter((r) => !used.has(r)).map((r) => r.pattern);
        expect(dead, 'dead rules: remove them or fix the pattern').toEqual([]);
    });

    it('every token-surface route references one of its authenticators', () => {
        const missing: string[] = [];
        for (const r of rows) {
            if (!r.policy.startsWith('token-surface:') || !r.file.endsWith('+server.ts')) continue;
            const symbols = r.rule.authenticators ?? [];
            const text = sourcesOf(r.file).join('\n');
            if (!symbols.some((s) => references(text, s))) {
                missing.push(
                    `${r.id} ${r.method} (expects one of: ${symbols.join(', ') || 'none listed'})`,
                );
            }
        }
        expect(
            missing,
            'token-surface routes with no authenticator: wrap them, or give them a public row with a reason',
        ).toEqual([]);
    });

    it('a looser policy than the committed snapshot needs a `loosens` reason', () => {
        if (!existsSync(SNAPSHOT)) return;
        const before = new Map<string, string>();
        for (const line of readFileSync(SNAPSHOT, 'utf8').split('\n')) {
            const [id, method, policy] = line.split(' ');
            if (id && method && policy) before.set(`${id} ${method}`, policy);
        }
        const loosened: string[] = [];
        for (const r of rows) {
            const old = before.get(`${r.id} ${r.method}`) as RoutePolicy | undefined;
            if (!old || r.rule.loosens) continue;
            const toTokenSurface =
                r.policy.startsWith('token-surface:') && !old.startsWith('token-surface:');
            if (strictness(r.policy) < strictness(old) || (toTokenSurface && old !== 'public')) {
                loosened.push(`${r.id} ${r.method}: ${old} -> ${r.policy}`);
            }
        }
        expect(loosened, 'add `loosens: <reason>` to the rule if this is intended').toEqual([]);
    });

    it('matches the snapshot', async () => {
        await expect(
            snapshotText(),
            'route policy changed: run `npx vitest run src/lib/server/auth/route-policy -u` ' +
                'and commit the snapshot with your route',
        ).toMatchFileSnapshot(SNAPSHOT);
    });
});

describe('route id normalisation', () => {
    it.each([
        ['/admin/(enterprise)/courses/[id]', '/admin/courses/[]'],
        ['/api/v1/media/[id=uuid]/images/[role]', '/api/v1/media/[]/images/[]'],
        ['/(proprietary)/j/[...path]', '/j/[...]'],
        ['/p/[featureId]/[[page]]', '/p/[]/[[]]'],
        ['/', '/'],
    ])('%s -> %s', (id, expected) => {
        expect(normalizeRouteId(id)).toBe(expected);
    });

    it('matches on segment boundaries only', () => {
        const t = createPolicyTable([{ pattern: '/api/admin/**', policy: 'admin-scoped' }]);
        expect(t.match('/api/admin')).not.toBeNull();
        expect(t.match('/api/admin/users')).not.toBeNull();
        expect(t.match('/api/administrator')).toBeNull();
        expect(t.match('/api/admin-foo/x')).toBeNull();
    });

    it('prefers more literal segments, then exact over subtree', () => {
        const t = createPolicyTable([
            { pattern: '/api/v1/**', policy: 'user' },
            { pattern: '/api/v1/*/[]/images/**', policy: 'token-surface:signed', reason: 'x' },
            { pattern: '/api/v1/media', policy: 'public', reason: 'x' },
            { pattern: '/api/v1/media/**', policy: 'admin-scoped' },
        ]);
        expect(t.match('/api/v1/media/[id]/images/[role]')?.rule.policy).toBe(
            'token-surface:signed',
        );
        expect(t.match('/api/v1/media')?.rule.policy).toBe('public');
        expect(t.match('/api/v1/media/[id]')?.rule.policy).toBe('admin-scoped');
        expect(t.match('/api/v1/people')?.rule.policy).toBe('user');
    });

    it('a per-method rule: own method, HEAD -> GET, then *, then the strictest', () => {
        const rule: RouteRule = {
            pattern: '/x',
            policy: { GET: 'token-surface:signed', DELETE: 'admin' },
            reason: 'x',
        };
        expect(policyForMethod(rule, 'GET')).toBe('token-surface:signed');
        expect(policyForMethod(rule, 'HEAD')).toBe('token-surface:signed');
        expect(policyForMethod(rule, 'PUT')).toBe('admin');
        expect(policyForMethod({ ...rule, policy: { GET: 'public', '*': 'user' } }, 'POST')).toBe(
            'user',
        );
    });
});


describe('bootstrap policy', () => {
    const table = createPolicyTable(ROUTE_POLICY_RULES);
    it.each(['GET', 'HEAD'])('%s discovery is public and its browser mirror requires a user', (method) => {
        expect(policyForMethod(table.match('/api/v1/server')!.rule, method)).toBe('public');
        expect(policyForMethod(table.match('/api/server')!.rule, method)).toBe('user');
    });
    it.each(['/api/v1/server', '/api/v1/server/', '/api/v1//server'])(
        '%s normalizes to the same policy', (routeId) => {
            expect(table.match(routeId)?.rule).toBe(table.match('/api/v1/server')?.rule);
        },
    );
    it.each(['/api/v1/%73erver', '/api/v1/server/notice'])(
        '%s is not a discovery route id', (routeId) => {
            expect(policyForMethod(table.match(routeId)!.rule, 'GET')).toBe('user');
        },
    );
});
