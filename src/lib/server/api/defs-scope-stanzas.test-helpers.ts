// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source-text scanner for every `{ kind: 'scope', anyOf: [...] }` auth stanza
 * under `defs/**`. Shared by the two scope sweeps:
 *
 *   - `defs-scope-non-admin-sweep.test.ts` — no def is reachable by a plain
 *     non-admin session through an un-allowlisted scope.
 *   - `defs-scope-demoted-owner-sweep.test.ts` — no def is reachable by an
 *     admin-scoped token whose owner is no longer admin.
 *
 * Reads SOURCE TEXT rather than importing the defs: importing ~600 def
 * modules pulls in DB/cache/task-registry side effects at module scope. See
 * the non-admin sweep's doc comment for why comments are blanked
 * length-preserving while strings stay verbatim (the scope names live in the
 * strings; a strip-everything pass once produced a real false positive).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const DEFS_ROOT = resolve(__dirname, 'defs');

/**
 * Blank out `//` and `/* *\/` comments — each stripped character becomes a
 * SPACE (newlines kept), so offsets and line numbers survive. String and
 * template literals are left untouched.
 */
export function blankComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
            continue;
        }
        if (c === '/' && n === '/') {
            const end = src.indexOf('\n', i);
            const stop = end < 0 ? src.length : end;
            for (; i < stop; i++) out += ' ';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') {
                    out += src[i] + (src[i + 1] ?? '');
                    i += 2;
                    continue;
                }
                out += src[i];
                if (src[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

export function collectDefFiles(dir: string = DEFS_ROOT, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectDefFiles(full, acc);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
}

/**
 * Matches `kind: 'scope', anyOf: [...]` OR the reverse property order
 * `anyOf: [...], kind: 'scope'` — the guard must not depend on which
 * property an author writes first (final fix wave, item 4, 2026-09-22).
 */
const AUTH_SCOPE_STANZA =
    /kind:\s*['"]scope['"]\s*,\s*anyOf:\s*\[([^\]]*)\]|anyOf:\s*\[([^\]]*)\]\s*,\s*kind:\s*['"]scope['"]/gs;
/** Every `kind: 'scope'` must be accounted for by exactly one stanza match. */
const KIND_SCOPE = /kind:\s*['"]scope['"]/g;

export interface ScopeStanza {
    /** Def path relative to `defs/`. */
    file: string;
    anyOf: string[];
}

export interface ScopeStanzaScan {
    /** Def files that contain `defineEndpoint(` at all. */
    files: string[];
    stanzas: ScopeStanza[];
    /**
     * Files whose `kind: 'scope'` count differs from the parsed stanza count —
     * a shape AUTH_SCOPE_STANZA doesn't recognise. Callers must fail on these
     * rather than let a scope-gated def go unchecked.
     */
    unparsed: { file: string; kindScopeCount: number; stanzaCount: number }[];
}

export function scanDefScopeStanzas(): ScopeStanzaScan {
    const files = collectDefFiles().filter((f) =>
        readFileSync(f, 'utf8').includes('defineEndpoint('),
    );
    const stanzas: ScopeStanza[] = [];
    const unparsed: ScopeStanzaScan['unparsed'] = [];

    for (const file of files) {
        const raw = readFileSync(file, 'utf8');
        // Cheap pre-filter before the comment-blanking pass.
        if (!raw.includes("kind: 'scope'") && !raw.includes('kind:"scope"')) continue;

        const commentsBlanked = blankComments(raw);
        const rel = relative(DEFS_ROOT, file);
        const kindScopeCount = [...commentsBlanked.matchAll(KIND_SCOPE)].length;
        const matches = [...commentsBlanked.matchAll(AUTH_SCOPE_STANZA)];
        if (matches.length !== kindScopeCount) {
            unparsed.push({ file: rel, kindScopeCount, stanzaCount: matches.length });
            continue;
        }
        for (const m of matches) {
            const scopeListRaw = m[1] ?? m[2] ?? '';
            const anyOf = [...scopeListRaw.matchAll(/'([^']+)'|"([^"]+)"/g)].map(
                (mm) => mm[1] ?? mm[2],
            );
            stanzas.push({ file: rel, anyOf });
        }
    }

    return { files, stanzas, unparsed };
}
