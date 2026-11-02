// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every `m.some_key(...)` call must resolve to a real message.
 *
 * A missing key is NOT caught by the normal gates: `tsgo` does not parse
 * `.svelte` files, and `svelte-check` did not flag it either. Paraglide simply
 * does not emit the export, so `m.some_key` is `undefined` and the call throws
 * `TypeError: (void 0) is not a function` at RUNTIME, inside a render.
 *
 * That shipped: the admin settings search jump list called two keys that were
 * lost when a concurrent commit rewrote `messages/*.json`. Every keystroke threw
 * and the settings search silently stopped filtering. Typecheck, svelte-check
 * and the unit suite were all green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = join(repoRoot, 'src');

/** Files that pull in the message namespace: `import * as m from '$lib/paraglide/messages'`. */
const IMPORTS_NAMESPACE = /import\s+\*\s+as\s+m\s+from\s+['"]\$lib\/paraglide\/messages/;

/**
 * `m.<key>(` call sites. Restricted to identifiers containing an underscore:
 * every Paraglide key is snake_case, while the false positives are local
 * variables that happen to be named `m` (a Map -> `m.set(`, a regex match ->
 * `m.index`). No real message key is a single bare word.
 */
const MESSAGE_CALL = /\bm\.([a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\s*\(/g;

/** This file quotes example call sites in its own docs; don't scan itself. */
const SELF = 'paraglide-message-keys.test.ts';

function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip the generated output itself.
            if (entry.name === 'paraglide' || entry.name === 'node_modules') continue;
            collectSourceFiles(full, out);
        } else if (/\.(svelte|ts)$/.test(entry.name) && entry.name !== SELF) {
            out.push(full);
        }
    }
    return out;
}

describe('paraglide message keys', () => {
    const en = JSON.parse(readFileSync(join(repoRoot, 'messages/en.json'), 'utf8')) as Record<
        string,
        unknown
    >;
    const de = JSON.parse(readFileSync(join(repoRoot, 'messages/de.json'), 'utf8')) as Record<
        string,
        unknown
    >;
    const files = collectSourceFiles(srcDir);

    it('scans a meaningful number of files (guards the collector itself)', () => {
        const withNamespace = files.filter((f) =>
            IMPORTS_NAMESPACE.test(readFileSync(f, 'utf8')),
        ).length;
        expect(withNamespace).toBeGreaterThan(100);
    });

    it('every referenced key exists in en.json', () => {
        const missing: string[] = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            if (!IMPORTS_NAMESPACE.test(source)) continue;
            for (const match of source.matchAll(MESSAGE_CALL)) {
                const key = match[1];
                if (!(key in en)) {
                    missing.push(`${key} <- ${file.slice(repoRoot.length)}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('every key used by the UI is translated in de.json', () => {
        const untranslated: string[] = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            if (!IMPORTS_NAMESPACE.test(source)) continue;
            for (const match of source.matchAll(MESSAGE_CALL)) {
                const key = match[1];
                // Only report keys that DO exist in en — a key missing from both
                // is already reported by the test above, and reporting it twice
                // just makes the failure harder to read.
                if (key in en && !(key in de)) {
                    untranslated.push(`${key} <- ${file.slice(repoRoot.length)}`);
                }
            }
        }
        expect(untranslated).toEqual([]);
    });
});
