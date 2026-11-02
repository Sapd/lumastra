// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `src/lib/components/admin/navigation/heroicon-catalog.ts` — the set
 * of Heroicons an admin may pick for a navigation item.
 *
 * The catalog is NOT "every Heroicon". `navigationIconMap` is imported by
 * Sidebar.svelte, which renders on every page, so every icon listed there is
 * shipped to every visitor on every page load. @steeze-ui/heroicons exports all
 * four variants per icon (default/micro/mini/solid) as one object, ~2KB raw
 * each, and tree-shaking is per-export — so naively listing all 324 would add
 * ~200KB raw to the always-loaded chunk for a picker only admins ever open.
 *
 * Instead the catalog is exactly the icons a real build ALREADY puts in the
 * always-loaded graph, because some other component in it imports them. Those
 * cost zero additional bytes: the path data is in the entry chunk either way.
 *
 * Usage (needs a built client — `npm run build`, or a copy of a deployed one):
 *   node scripts/gen-navigation-icon-catalog.mjs [path/to/_app/immutable]
 *
 * Re-run it after a dependency or layout change to pick up icons that became
 * free (or to drop ones that stopped being). Icons outside the catalog are
 * still reachable: the picker's "Custom path" option takes any image URL.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const immutableDir = resolve(
    process.argv[2] ?? join(repoRoot, 'build', 'client', '_app', 'immutable'),
);
const outFile = join(repoRoot, 'src/lib/components/admin/navigation/heroicon-catalog.ts');

if (!existsSync(immutableDir)) {
    console.error(`No build found at ${immutableDir}. Build first, or pass a path.`);
    process.exit(1);
}

/**
 * The always-loaded graph: `entry/app*.js` and `nodes/0.*.js` (the root layout,
 * which every route renders inside — it is what pulls in the Sidebar) plus
 * everything they statically import, transitively. A per-route node chunk is
 * NOT a root here: an icon only some route pulls in would have to be hoisted
 * into the shared graph to be pickable, which is the cost this script avoids.
 */
function alwaysLoadedFiles() {
    const entryDir = join(immutableDir, 'entry');
    const nodesDir = join(immutableDir, 'nodes');
    const seen = new Set();
    const queue = readdirSync(entryDir)
        .filter((f) => f.startsWith('app') && f.endsWith('.js'))
        .map((f) => join(entryDir, f));
    if (existsSync(nodesDir)) {
        queue.push(
            ...readdirSync(nodesDir)
                .filter((f) => /^0\.[^.]+\.js$/.test(f))
                .map((f) => join(nodesDir, f)),
        );
    }

    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file)) continue;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        // Static `import ... from "./x.js"` / `import"../chunks/x.js"` only.
        for (const match of source.matchAll(
            /from\s*["'](\.[^"']+\.js)["']|import\s*["'](\.[^"']+\.js)["']/g,
        )) {
            queue.push(resolve(dirname(file), match[1] ?? match[2]));
        }
    }
    return [...seen];
}

/**
 * RectangleGroup -> rectangle-group, Cog6Tooth -> cog-6-tooth,
 * Square3Stack3d -> square-3-stack-3d, Squares2x2 -> squares-2x2.
 *
 * Must reproduce Heroicons' own kebab names exactly — those are the keys
 * already stored in operators' navigation configs, and a key that drifts
 * renders as no icon at all. The `(?<!\d)` guard is what keeps `2x2` whole:
 * a letter starts a new word before a digit, unless a digit came first.
 */
function kebab(name) {
    return name
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/(?<!\d)([a-zA-Z])(\d)/g, '$1-$2')
        .replace(/(\d)([A-Z])/g, '$1-$2')
        .toLowerCase();
}

const heroicons = await import('@steeze-ui/heroicons');
const files = alwaysLoadedFiles();
const haystack = files.map((f) => readFileSync(f, 'utf8')).join('\n');

const free = [];
const paid = [];
for (const [name, source] of Object.entries(heroicons)) {
    const d = source?.default?.path?.[0]?.d;
    if (typeof d !== 'string' || d.length < 12) continue;
    // Path data survives minification untouched (it is string content, not an
    // identifier). 40 chars is unique per icon in practice; for the handful of
    // icons whose path is shorter than that, match it whole. A false positive
    // here costs ~2KB, a false negative costs the admin an icon.
    (haystack.includes(d.slice(0, 40)) ? free : paid).push(name);
}
free.sort();

const wasted = paid.reduce((sum, n) => sum + JSON.stringify(heroicons[n]).length, 0);
console.log(`always-loaded files scanned: ${files.length}`);
console.log(
    `free icons: ${free.length}   excluded: ${paid.length} (~${(wasted / 1024).toFixed(0)}KB raw if included)`,
);

const header = `// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GENERATED by scripts/gen-navigation-icon-catalog.mjs — do not edit by hand.
//
// Every Heroicon here is already present in the app's always-loaded chunk
// because some other component imports it, so listing it in the navigation icon
// picker costs zero additional bytes. ${paid.length} further Heroicons exist and are
// deliberately left out: each would add ~2KB raw to every page load.
//
// Regenerate against a real build: node scripts/gen-navigation-icon-catalog.mjs

import {
${free.map((n) => `    ${n},`).join('\n')}
    type IconSource,
} from 'svelte-hero-icons';

export const heroiconCatalog: Record<string, IconSource> = {
${free.map((n) => `    '${kebab(n)}': ${n},`).join('\n')}
};
`;

writeFileSync(outFile, header);
console.log(`wrote ${basename(outFile)} (${free.length} icons)`);
