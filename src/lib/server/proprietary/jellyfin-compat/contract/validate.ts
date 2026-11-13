// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Validates a /j JSON response against the jellyfin-sdk-kotlin contract digest.
 * Severity follows ApiSerializer: coerceInputValues rescues null/unknown-enum only
 * where the property has a default; isLenient=false rejects strings for numbers
 * and booleans; DateTime never fails; UUIDs must be hyphenated or 32 lowercase hex.
 */
import type { ContractDigest, PropertyContract } from './build-digest';
import { getAllowlist, getContractDigest } from './digest';

export type ViolationKind = 'missing' | 'null' | 'type' | 'int32' | 'enum' | 'uuid';
export interface Violation {
    pointer: string;
    schema: string;
    property: string;
    kind: ViolationKind;
    severity: 'error' | 'warn';
    versions: string[];
    detail?: string;
}
export interface AllowEntry {
    schema: string;
    property: string;
    clientNames?: string[];
    reason: string;
}
export interface ValidationResult {
    violations: Violation[];
    unmatched: boolean;
    schema: string | null;
    route: string | null;
}

const MAX_DEPTH = 12;
const UUID_HYPHENATED =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_COMPACT = /^[0-9a-f]{32}$/;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

function jsonTypeOf(v: unknown): string {
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function allowed(
    allowlist: AllowEntry[],
    schema: string,
    property: string,
    clientName?: string,
): boolean {
    return allowlist.some(
        (a) =>
            a.schema === schema &&
            a.property === property &&
            (!a.clientNames ||
                (clientName !== undefined &&
                    a.clientNames.some((c) => clientName.toLowerCase().includes(c.toLowerCase())))),
    );
}

export function validateAgainstSchema(
    digest: ContractDigest,
    schema: string,
    body: unknown,
    opts: { clientName?: string; allowlist?: AllowEntry[]; arrayLimit?: number } = {},
): Violation[] {
    const out: Violation[] = [];
    const allowlist = opts.allowlist ?? getAllowlist();
    const arrayLimit = opts.arrayLimit ?? Number.POSITIVE_INFINITY;

    const checkValue = (
        c: PropertyContract,
        v: unknown,
        p: string,
        depth: number,
        base: Omit<Violation, 'kind' | 'severity'>,
    ): void => {
        const t = jsonTypeOf(v);
        if (c.type) {
            const ok = c.type === t || (c.type === 'number' && t === 'integer');
            if (!ok) {
                out.push({
                    ...base,
                    kind: 'type',
                    severity: 'error',
                    detail: `expected ${c.type}, got ${t}`,
                });
                return;
            }
        }
        if (c.format === 'int32' && typeof v === 'number' && (v < INT32_MIN || v > INT32_MAX)) {
            out.push({ ...base, kind: 'int32', severity: 'error', detail: String(v) });
        }
        if (
            c.format === 'uuid' &&
            typeof v === 'string' &&
            !UUID_HYPHENATED.test(v) &&
            !UUID_COMPACT.test(v)
        ) {
            out.push({ ...base, kind: 'uuid', severity: 'error', detail: v.slice(0, 40) });
        }
        if (c.enum && typeof v === 'string' && !c.enum.includes(v)) {
            out.push({
                ...base,
                kind: 'enum',
                severity: c.hasDefault ? 'warn' : 'error',
                detail: v,
            });
        }
        if (c.child) {
            if (Array.isArray(v)) {
                const n = Math.min(v.length, arrayLimit);
                for (let i = 0; i < n; i++) walk(c.child, v[i], `${p}/${i}`, depth + 1);
            } else {
                walk(c.child, v, p, depth + 1);
            }
        }
    };

    const walk = (schemaName: string, value: unknown, pointer: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        const props = digest.schemas[schemaName];
        if (!props || value === null || typeof value !== 'object' || Array.isArray(value)) return;
        const obj = value as Record<string, unknown>;
        for (const [prop, c] of Object.entries(props)) {
            if (allowed(allowlist, schemaName, prop, opts.clientName)) continue;
            const p = `${pointer}/${prop}`;
            const v = obj[prop];
            const base = { pointer: p, schema: schemaName, property: prop, versions: c.required };
            if (v === undefined) {
                if (c.required.length > 0)
                    out.push({ ...base, kind: 'missing', severity: 'error' });
                continue;
            }
            if (v === null) {
                if (c.required.length > 0) out.push({ ...base, kind: 'null', severity: 'error' });
                else if (c.hasDefault) out.push({ ...base, kind: 'null', severity: 'warn' });
                continue;
            }
            checkValue(c, v, p, depth, base);
        }
    };

    if (schema.endsWith('[]')) {
        const item = schema.slice(0, -2);
        if (!Array.isArray(body)) {
            out.push({
                pointer: '',
                schema,
                property: '',
                kind: 'type',
                severity: 'error',
                versions: [],
                detail: `expected array, got ${jsonTypeOf(body)}`,
            });
        } else {
            const n = Math.min(body.length, arrayLimit);
            for (let i = 0; i < n; i++) walk(item, body[i], `/${i}`, 0);
        }
        return out;
    }
    walk(schema, body, '', 0);
    return out;
}

interface CompiledRoute {
    re: RegExp;
    method: string;
    path: string;
    schema: string | null;
}
let compiled: CompiledRoute[] = [];
let compiledFor: ContractDigest | null = null;

export function matchRoute(
    digest: ContractDigest,
    method: string,
    path: string,
): { path: string; schema: string | null } | null {
    if (compiledFor !== digest) {
        compiled = digest.routes.map((r) => ({
            ...r,
            re: new RegExp(
                '^' +
                    r.path
                        .split(/\{[^}]+\}/)
                        .map((s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
                        .join('[^/]+') +
                    '$',
                'i',
            ),
        }));
        compiledFor = digest;
    }
    const stripped = path.replace(/^\/j(?=\/|$)/i, '') || '/';
    const m = method.toUpperCase();
    const hits = compiled.filter((r) => r.method.toUpperCase() === m && r.re.test(stripped));
    hits.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
    return hits[0] ? { path: hits[0].path, schema: hits[0].schema } : null;
}

export function validateJellyfinResponse(
    method: string,
    path: string,
    body: unknown,
    opts: { clientName?: string; arrayLimit?: number } = {},
): ValidationResult {
    const digest = getContractDigest();
    const route = matchRoute(digest, method, path);
    if (!route) return { violations: [], unmatched: true, schema: null, route: null };
    if (!route.schema) return { violations: [], unmatched: false, schema: null, route: route.path };
    return {
        violations: validateAgainstSchema(digest, route.schema, body, opts),
        unmatched: false,
        schema: route.schema,
        route: route.path,
    };
}
