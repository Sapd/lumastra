// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writes the tsconfig that `scripts/check-svelte-types.mjs` hands to svelte-check.
 *
 * WHY NOT ./tsconfig.json
 * -----------------------
 * tsconfig.json includes every file under src/ and tests/: ~5,600 server files and
 * ~4,400 tests. svelte-check reports TypeScript errors for all of them, so the
 * program was 28,800 files and 15.7 M type instantiations, and the checker peaked at
 * 11.7 GB (2026-11-03). That does not fit a 16 GB GitHub-hosted runner.
 *
 * Almost all of that is already checked elsewhere: `npm run typecheck` (tsgo) runs the
 * same compilerOptions over every .ts file. The one thing tsgo cannot do is type a
 * `.svelte` import — it sees the `*.svelte` ambient shim. So svelte-check only needs
 * these ENTRY POINTS:
 *
 *   - every .svelte file, and
 *   - every .ts/.js file that reaches a .svelte module through imports, directly or
 *     through barrels (`export { default as X } from './X.svelte'` and its users).
 *
 * Everything those files import is still pulled into the program and checked; the
 * files left out are exactly the ones whose types do not depend on a component, which
 * the tsgo gate checks with identical options. Measured 2026-11-03: 18,600 files,
 * 3.3 M instantiations, 5.6 GB peak, and the same error list as the full program for
 * an error in a component, a prop type change that breaks 19 callers, and a wrong
 * prop in a test.
 *
 * The importer set is recomputed on every run (it is a cheap regex scan), so a new
 * test or barrel cannot fall out of the check. The output is gitignored.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENTRY_TSCONFIG = 'tsconfig.svelte-check.json';

const SOURCE_ROOTS = ['src', 'test', 'tests'];

// Import, re-export, dynamic import / `import('…')` types, require and vi.mock specifiers.
// Over-matching (e.g. inside a comment) only adds an entry point, never drops one.
const SPECIFIER =
    /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*|vi\.mock\(\s*)['"]([^'"]+)['"]/g;

function listFiles(dir, out) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        if (name === 'node_modules' || name === 'paraglide') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) listFiles(path, out);
        else out.push(path);
    }
    return out;
}

function resolveFile(base, root) {
    for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.js`,
        `${base}/index.ts`,
        `${base}/index.js`,
        base.replace(/\.js$/, '.ts'),
    ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
    }
    return null;
}

// Relative paths and `$lib` are the only module aliases in this app (svelte.config.js).
function resolveSpecifier(fromFile, specifier, root) {
    if (specifier.startsWith('.'))
        return resolveFile(resolve(root, dirname(fromFile), specifier), root);
    if (specifier === '$lib' || specifier.startsWith('$lib/')) {
        return resolveFile(resolve(root, 'src/lib', specifier.slice('$lib/'.length)), root);
    }
    return null;
}

/** Files (relative to `root`) that reach a .svelte module through imports, excluding .svelte. */
export function findSvelteImporters(root) {
    const files = SOURCE_ROOTS.flatMap((dir) => listFiles(join(root, dir), [])).map((f) =>
        relative(root, f),
    );
    const code = files.filter((f) => /\.(ts|js|svelte)$/.test(f) && !f.endsWith('.d.ts'));

    const importedBy = new Map();
    for (const file of code) {
        for (const match of readFileSync(join(root, file), 'utf8').matchAll(SPECIFIER)) {
            const target = resolveSpecifier(file, match[1], root);
            if (!target) continue;
            if (!importedBy.has(target)) importedBy.set(target, new Set());
            importedBy.get(target).add(file);
        }
    }

    // Walk the import graph backwards from every component.
    const reached = new Set(code.filter((f) => f.endsWith('.svelte')));
    const queue = [...reached];
    while (queue.length > 0) {
        for (const importer of importedBy.get(queue.pop()) ?? []) {
            if (reached.has(importer)) continue;
            reached.add(importer);
            queue.push(importer);
        }
    }
    return [...reached].filter((f) => !f.endsWith('.svelte')).sort();
}

/** Write ENTRY_TSCONFIG into `root` and return how many importer files it lists. */
export function writeEntryTsconfig(root) {
    const importers = findSvelteImporters(root);
    const config = {
        extends: './tsconfig.json',
        // Literal paths go in `include`, not `files`: svelte-check 4.7 rewrites every
        // `files` entry to a virtual .svelte path and then reports it as not found.
        include: [
            '.svelte-kit/ambient.d.ts',
            '.svelte-kit/non-ambient.d.ts',
            'src/app.d.ts',
            'src/**/*.d.ts',
            'src/**/*.svelte',
            'test/**/*.svelte',
            'tests/**/*.svelte',
            ...importers,
        ],
        // `exclude` does not merge across `extends`; restated from tsconfig.json and
        // .svelte-kit/tsconfig.json.
        exclude: [
            'node_modules/**',
            '**/node_modules/**',
            'src/paraglide/**',
            'src/lib/paraglide/**',
            'src/service-worker.d.ts',
            'src/service-worker/**/*.d.ts',
        ],
    };
    writeFileSync(
        join(root, ENTRY_TSCONFIG),
        `// Generated by scripts/typecheck/svelte-entry-config.mjs — do not edit.\n${JSON.stringify(config, null, 4)}\n`,
    );
    return importers.length;
}

// `node scripts/typecheck/svelte-entry-config.mjs` writes the config for the `check`,
// `check:critical` and `check:watch` scripts, which call svelte-check directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const importers = writeEntryTsconfig(process.cwd());
    console.log(`Wrote ${ENTRY_TSCONFIG}: all components + ${importers} importing file(s).`);
}
