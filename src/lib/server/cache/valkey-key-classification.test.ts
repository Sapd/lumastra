// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Classification guard for the two-instance Valkey split. Every call of a keyed
// valkey.ts helper (cacheGet, setEx, hSet, …) routes by the key's prefix: a
// coordination prefix lands on the noeviction task instance, anything else on
// the evictable, optional cache. A NEW key whose loss is dangerous (a lost
// lock, rate limit, revocation marker, single-use transaction, live party …)
// would silently default to the evictable cache. This test makes that a
// conscious choice: it statically scans src/**/*.ts for keyed-helper calls,
// resolves the literal head of the key argument, and requires every head to be
// either a coordination prefix (COORDINATION_KEY_PREFIXES in valkey.ts) or
// listed in CACHE_ONLY_KEY_PREFIXES below with the reason its loss is harmless.
//
// Resolution is static and best effort: string / template literals, a
// same-file `const NAME = '…'`, `NAME + …`, a leading `${NAME}` in a template,
// a same-file key builder (`fooKey(x)`, `KEYS.FOO(x)`). Arguments that cannot
// be resolved are skipped and counted, not failed.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { coordinationKeyPrefixes } from './valkey.js';

/**
 * Key prefixes that deliberately stay on the evictable cache instance (or in
 * memory when CACHE_URL is unset). Every entry must be safe to lose at any time:
 * a pure cache, a recomputable value, or a short-TTL metric.
 */
const CACHE_ONLY_KEY_PREFIXES: readonly string[] = [
    // Read-through / recomputable caches.
    'trending:', // trending lists, rebuilt on the next miss
    'v1:admin:', // rendered admin attention payload, recomputed on demand
    // Resource-pressure clocks: losing them only restarts the 10-minute clock (a
    // process-local copy covers a flush), never raises or resolves an item on its own.
    'v3:attention:resource-pressure-since',
    'admin:ingest:page:', // admin ingest page snapshot
    'ffmpeg:stats:', // cached ffmpeg capability probe, re-probed on a miss
    'v1:transcode:gpu-non-hw-decodable', // GPU capability verdict, re-detected
    // Display-only state: losing it blanks a badge or progress bar, nothing decides on it.
    'v1:abr:', // adaptive-bitrate badge for Active Streams (see adaptive-playback-state)
    'device:session:v1:', // play-session client app / player name for the admin session list
    'v1:file-scanner:', // scan progress and watcher heartbeat status shown in the admin UI
    'v1:keyframe-probe-progress:', // keyframe probe progress display
    // TTL'd metrics, recomputed by every pod on its next tick.
    'bandwidth:pod:v1:',
    'bandwidth:history:v1:',
    // Best-effort throttles / dedup whose loss costs one repeated cheap action.
    'v1:jf:stream-limit-notice:', // "stream limit reached" notice dedup
    'v1:stream-limit:recheck:', // throttle on stream-limit reconciliation; admission still enforces
    'preview:autodisabled', // load-breaker cool-off; the next admission under load re-trips it
    'oauth:refresh:replay:v1:', // retry grace for a lost rotation response; a miss rotates again (see rotate())
    'v1:sonic:', // embedder crash-suspect sets and engine-broken marker; documented best-effort
    'v1:artwork-backfill:budget:', // hourly provider-call budget; fail-open by design, resets next hour
];

const KEYED_HELPERS: ReadonlySet<string> = new Set([
    'cacheGet',
    'cacheGetOrThrow',
    'getDel',
    'cacheSet',
    'cacheDel',
    'cacheExists',
    'getKeyTtlSeconds',
    'setEx',
    'setIfNotExists',
    'expire',
    'acquireLock',
    'releaseLock',
    'renewLock',
    'sAdd',
    'sCard',
    'sMembers',
    'sRem',
    'sAddBounded',
    'zRem',
    'zCountFrom',
    'zAddBoundedExpiring',
    'hSet',
    'hSetNX',
    'hGet',
    'hSetMulti',
    'hIncrBy',
    'hDel',
    'hGetAll',
    'del',
    'getKeysByPattern',
    'scanKeysOrThrow',
    'deleteKeysByPattern',
    'incr',
    'lPush',
    'lRange',
    'lTrim',
    'lPopCount',
    'lLen',
]);

const SRC_ROOT = resolve(__dirname, '../../..');

function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            if (name === 'node_modules' || name === '__fixtures__' || name === '__testkit__') {
                continue;
            }
            listSourceFiles(full, out);
        } else if (
            name.endsWith('.ts') &&
            !name.endsWith('.test.ts') &&
            !name.endsWith('.bench.ts') &&
            !name.endsWith('.d.ts')
        ) {
            out.push(full);
        }
    }
    return out;
}

interface ImportedHelpers {
    /** local binding → helper name (handles `x as y`). */
    named: Map<string, string>;
    /** namespace bindings (`import * as v from …valkey`). */
    namespaces: Set<string>;
}

const MODULE_PATH = String.raw`['"][^'"]*(?:/|^)valkey(?:\.js)?['"]`;

function findValkeyImports(src: string): ImportedHelpers {
    const named = new Map<string, string>();
    const namespaces = new Set<string>();
    const addNames = (list: string): void => {
        for (const part of list.split(',')) {
            const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
                part,
            );
            if (!m) continue;
            const imported = m[1];
            if (KEYED_HELPERS.has(imported)) named.set(m[2] ?? imported, imported);
        }
    };
    const staticRe = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${MODULE_PATH}`, 'g');
    for (const m of src.matchAll(staticRe)) addNames(m[1]);
    const dynamicRe = new RegExp(
        String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${MODULE_PATH}\s*\)`,
        'g',
    );
    for (const m of src.matchAll(dynamicRe)) addNames(m[1]);
    const nsRe = new RegExp(
        String.raw`import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*${MODULE_PATH}`,
        'g',
    );
    for (const m of src.matchAll(nsRe)) namespaces.add(m[1]);
    return { named, namespaces };
}

/** Text of the first call argument starting right after the opening paren. */
function readFirstArgument(src: string, start: number): string | null {
    let depth = 0;
    let i = start;
    while (i < src.length) {
        const ch = src[i];
        if (ch === "'" || ch === '"') {
            const quote = ch;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\') i++;
                i++;
            }
        } else if (ch === '`') {
            i++;
            let tplDepth = 0;
            while (i < src.length) {
                if (src[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (tplDepth === 0 && src[i] === '`') break;
                if (src[i] === '$' && src[i + 1] === '{') {
                    tplDepth++;
                    i += 2;
                    continue;
                }
                if (tplDepth > 0 && src[i] === '}') tplDepth--;
                i++;
            }
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) return src.slice(start, i);
            depth--;
        } else if (ch === ',' && depth === 0) {
            return src.slice(start, i);
        }
        i++;
    }
    return null;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal head of a quoted/template literal that starts at `lit[0]`. */
function literalHead(lit: string, src: string, depth: number): string | null {
    const quote = lit[0];
    if (quote === "'" || quote === '"') {
        const end = lit.indexOf(quote, 1);
        return end === -1 ? null : lit.slice(1, end);
    }
    if (quote !== '`') return null;
    let head = '';
    let i = 1;
    while (i < lit.length && lit[i] !== '`') {
        if (lit[i] === '$' && lit[i + 1] === '{') {
            const close = lit.indexOf('}', i);
            const expr = close === -1 ? '' : lit.slice(i + 2, close).trim();
            // A leading `${CONST}` of a same-file string constant is part of the head.
            const resolved = /^[A-Za-z_$][\w$]*$/.test(expr)
                ? resolveConst(expr, src, depth + 1)
                : null;
            if (resolved === null) return head;
            head += resolved;
            i = close + 1;
            continue;
        }
        if (lit[i] === '\\') i++;
        head += lit[i];
        i++;
    }
    return head;
}

function resolveConst(name: string, src: string, depth: number): string | null {
    if (depth > 4) return null;
    const re = new RegExp(
        String.raw`(?:const|let)\s+${escapeRegExp(name)}\s*(?::\s*string\s*)?=\s*(['"\`])`,
    );
    const m = re.exec(src);
    if (!m) return null;
    const litStart = m.index + m[0].length - 1;
    // Only a plain literal counts: `const X = 'a' + y` has no static value.
    const head = literalHead(src.slice(litStart), src, depth);
    if (head === null) return null;
    const rest = src.slice(litStart);
    const quote = rest[0];
    const closeIdx = quote === '`' ? rest.indexOf('`', 1) : rest.indexOf(quote, 1);
    if (closeIdx === -1) return null;
    const after = rest.slice(closeIdx + 1).trimStart();
    return after.startsWith('+') || (quote === '`' && rest.slice(0, closeIdx).includes('${'))
        ? null
        : head;
}

/** Head of a key built by a same-file function / object member (`fooKey(x)`, `KEYS.FOO(x)`). */
function resolveBuilder(callee: string, src: string, depth: number): string | null {
    if (depth > 4) return null;
    const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(callee);
    const patterns: RegExp[] = [];
    if (member) {
        const prop = escapeRegExp(member[2]);
        patterns.push(
            new RegExp(
                String.raw`\b${prop}\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*`,
            ),
        );
        patterns.push(
            new RegExp(String.raw`\b${prop}\s*\([^)]*\)\s*(?::\s*string\s*)?\{\s*return\s+`),
        );
    } else {
        const name = escapeRegExp(callee);
        patterns.push(
            new RegExp(
                String.raw`(?:const|let)\s+${name}\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*string\s*)?=>\s*`,
            ),
        );
        patterns.push(
            new RegExp(
                String.raw`function\s+${name}\s*\([^)]*\)\s*(?::\s*string\s*)?\{\s*return\s+`,
            ),
        );
    }
    for (const re of patterns) {
        const m = re.exec(src);
        if (!m) continue;
        const litStart = m.index + m[0].length;
        const first = src[litStart];
        if (first === '`' || first === "'" || first === '"') {
            return literalHead(src.slice(litStart), src, depth + 1);
        }
    }
    return null;
}

function resolveHead(arg: string, src: string): string | null {
    const text = arg.trim();
    if (text === '') return null;
    const first = text[0];
    if (first === "'" || first === '"' || first === '`') return literalHead(text, src, 0);
    const ident = /^([A-Za-z_$][\w$]*)\s*(?:\+|$)/.exec(text);
    if (ident) return resolveConst(ident[1], src, 0);
    const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/.exec(text);
    if (call) return resolveBuilder(call[1], src, 0);
    return null;
}

interface CallSite {
    file: string;
    line: number;
    helper: string;
    head: string;
}

interface ScanResult {
    resolved: CallSite[];
    skipped: number;
}

function scanSources(): ScanResult {
    const resolved: CallSite[] = [];
    let skipped = 0;
    for (const file of listSourceFiles(SRC_ROOT)) {
        if (file.endsWith(`${join('lib', 'server', 'cache')}${'/'}valkey.ts`)) continue;
        const src = readFileSync(file, 'utf8');
        if (!/valkey/.test(src)) continue;
        const { named, namespaces } = findValkeyImports(src);
        if (named.size === 0 && namespaces.size === 0) continue;

        const names = [...named.keys()].map(escapeRegExp);
        const nsPart = [...namespaces].map(escapeRegExp);
        const alternatives: string[] = [];
        if (names.length > 0)
            alternatives.push(String.raw`(?<![.\w$])(${names.join('|')})\s*(?:<[^>()]*>)?\(`);
        if (nsPart.length > 0) {
            alternatives.push(
                String.raw`(?<![\w$])(?:${nsPart.join('|')})\.(${[...KEYED_HELPERS].join('|')})\s*\(`,
            );
        }
        for (const alt of alternatives) {
            for (const m of src.matchAll(new RegExp(alt, 'g'))) {
                const local = m[1];
                const helper = named.get(local) ?? local;
                const before = src.slice(Math.max(0, m.index - 12), m.index);
                if (/function\s+$/.test(before)) continue;
                const arg = readFirstArgument(src, m.index + m[0].length);
                const head = arg === null ? null : resolveHead(arg, src);
                if (head === null || head === '') {
                    skipped++;
                    continue;
                }
                const line = src.slice(0, m.index).split('\n').length;
                resolved.push({
                    file: relative(SRC_ROOT, file),
                    line,
                    helper,
                    head,
                });
            }
        }
    }
    return { resolved, skipped };
}

describe('Valkey key classification guard', () => {
    const prefixes = [...coordinationKeyPrefixes(), ...CACHE_ONLY_KEY_PREFIXES];
    const { resolved, skipped } = scanSources();

    it('resolves enough call sites for the guard to mean something', () => {
        // Coverage documentation: a refactor that breaks the scanner would drop
        // this to ~0 and silently disarm the guard.
        console.info(
            `valkey key classification: ${resolved.length} call sites resolved, ${skipped} unresolvable (skipped)`,
        );
        expect(resolved.length).toBeGreaterThanOrEqual(50);
    });

    it('every resolved key head is a coordination prefix or an explicit cache-only prefix', () => {
        const unclassified = resolved
            .filter((site) => !prefixes.some((p) => site.head.startsWith(p)))
            .map(
                (site) => `${site.file}:${site.line} ${site.helper}(${JSON.stringify(site.head)})`,
            );
        expect(
            unclassified,
            'Classify each key: add its prefix to COORDINATION_KEY_PREFIXES in cache/valkey.ts if losing it is ' +
                'dangerous (lock, rate limit, revocation, single-use transaction, live party), otherwise to ' +
                'CACHE_ONLY_KEY_PREFIXES in this test with a reason.',
        ).toEqual([]);
    });

    it('CACHE_ONLY_KEY_PREFIXES has no entry that is also a coordination prefix', () => {
        const coordination = coordinationKeyPrefixes();
        const overlap = [...CACHE_ONLY_KEY_PREFIXES].filter((p) =>
            coordination.some((c) => p.startsWith(c)),
        );
        expect(overlap).toEqual([]);
    });
});
