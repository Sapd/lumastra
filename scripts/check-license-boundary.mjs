// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * License-boundary guard (three tiers).
 *
 * Enforces the open-core invariant across the AGPL core and the two PROTECTED
 * (non-AGPL) tiers — see LICENSING.md §3:
 *   • PROPRIETARY (LicenseRef-Lumastra-Proprietary) — /j (Jellyfin-compat) + the AI assistant.
 *   • ENTERPRISE  (LicenseRef-Lumastra-Enterprise)  — the LMS (assessment/training),
 *                                                     compliance reporting, product showcase.
 *
 * Layering — AGPL ◁ proprietary ◁ enterprise — and the import directions it permits:
 *   • AGPL core may import only AGPL. It may NOT statically import either protected tier.
 *   • proprietary may import AGPL, but NOT enterprise.
 *   • enterprise may import AGPL + proprietary (it gates itself via the proprietary
 *     `licensing/module-gate`), and of course enterprise.
 * Cross-boundary calls from a lower tier go via the entitlements registry or HTTP.
 *
 * Why this matters: anyone may delete the protected dirs and build an AGPL-only tree —
 * LICENSING.md permits exactly that. A single core→protected import would dangle in such a
 * stripped tree (and taint the AGPL surface). The subtle trap is a shared module that "feels"
 * like protected code — e.g. `database/queries/assistant-rag.queries.ts` — being moved into a
 * protected dir: the core query barrel re-exports it, so the move would break the stripped
 * build. This guard catches that, and the analogous proprietary→enterprise leak.
 *
 * Edge forms detected: `import … from` / `export … from`, bare side-effect `import '…'`,
 * dynamic `import('…')`, `require('…')`, `import.meta.glob` patterns into a forbidden tree
 * (exactly ONE sanctioned (file, pattern) pair is allowed — the entitlements optional-load
 * shim), and — heuristically — computed `import(...)`/`require(...)` specifiers that mention a
 * forbidden tree. Known limits: a specifier assembled from fragments that never spell out the
 * tree dir, or a tsconfig/vite alias pointing into it, is not caught (no such alias exists
 * today; introducing one IS a boundary violation).
 *
 * Run: `node scripts/check-license-boundary.mjs` (exit 1 on any violation).
 * Runs in CI on every push (docker-publish.yml + license-boundary.yml).
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

// Where first-party code lives. `tests/` is excluded on purpose: test files are
// never shipped, and the import-direction check skips *.test/*.spec anyway.
const SCAN_DIRS = ['src', 'scripts', 'packages', 'plugins'];

// The two protected tiers (must match scripts/license-headers.mjs + LICENSING.md §3).
// Each tier is identified by a single MARKER: a `(proprietary)` / `(enterprise)` SvelteKit
// route GROUP (URL-transparent) for the URL-bound route entrypoints, plus its lib tree.
const PROPRIETARY_PREFIXES = [
    'src/lib/server/proprietary/',
    'src/lib/proprietary/',
    // New: individual proprietary-tier def files co-located in the shared defs tree.
    // Only the specific files (not the whole directory) are proprietary.
    'src/lib/server/api/defs/integrations/jellyfin-quick-connect',
];
const ENTERPRISE_PREFIXES = [
    'src/lib/server/enterprise/',
    'src/lib/enterprise/',
    // New: enterprise-tier defs subtree and the client-side enterprise API module.
    'src/lib/server/api/defs/enterprise/',
    'src/lib/api/enterprise',
];

const isProprietary = (rel) =>
    rel.includes('/(proprietary)/') || PROPRIETARY_PREFIXES.some((p) => rel.startsWith(p));
const isEnterprise = (rel) =>
    rel.includes('/(enterprise)/') || ENTERPRISE_PREFIXES.some((p) => rel.startsWith(p));
// enterprise wins if both ever matched (they never should); else proprietary; else agpl.
const tierOf = (rel) =>
    isEnterprise(rel) ? 'enterprise' : isProprietary(rel) ? 'proprietary' : 'agpl';

// The fourth license category: all-rights-reserved brand assets (LICENSING.md §6).
// These are images today (not scanned below), but listing the in-`src` path keeps
// the header rule from mis-classifying any code file that ever lands here as AGPL.
// (`static/branding/` is outside the scanned trees.)
const BRANDING_PREFIXES = ['src/lib/assets/branding/'];
const isBranding = (rel) => BRANDING_PREFIXES.some((p) => rel.startsWith(p));

// The single sanctioned cross-boundary glob: the entitlements optional-load shim
// (AGPL → proprietary). Any OTHER `import.meta.glob` whose pattern reaches a forbidden
// tree is a violation — globs are otherwise an unbounded side door around the import rules.
const SANCTIONED_GLOB_FILE = 'src/lib/server/licensing/entitlements.ts';
const SANCTIONED_GLOB_PATTERN = '/src/lib/server/proprietary/licensing/init.{ts,js}';

// Match BOTH the lib-tree form (`…/proprietary/…`) and the SvelteKit route-GROUP form
// (`…/(proprietary)/…`): a bare `proprietary/` misses the route-group case because the `)`
// sits between the word and the slash. So an AGPL/proprietary file importing a protected
// route-group module by relative or $lib path is caught here too.
// The `[/.)]|$` tail also catches BARE-FILE specifiers (`$lib/api/enterprise`,
// `…/enterprise.ts`) — a trailing-slash-only match would miss them. And the co-located
// proprietary def file has no "proprietary" in its specifier at all, so it gets its own
// alternation (must stay in sync with PROPRIETARY_PREFIXES above).
const PROP_SPECIFIER =
    /(?:^|[/(])proprietary(?:[/.)]|$)|defs\/integrations\/jellyfin-quick-connect(?:[./'"]|$)/;
const ENT_SPECIFIER = /(?:^|[/(])enterprise(?:[/.)]|$)/;

// Literal-specifier edge forms.
const IMPORT_FROM = /(?:^|\s)(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// `import.meta.glob('…')` with a literal pattern (group 2).
const GLOB_CALL = /import\s*\.\s*meta\s*\.\s*glob\s*\(\s*(['"`])([^'"`]+)\1/g;
// Heuristic: a computed (non-literal) import()/require() argument that mentions a
// forbidden tree — template literals, concatenation, variables + comments.
const COMPUTED_CALL = /(?:^|[^.\w])(?:import|require)\s*\(([^)\n]*)\)/g;
const PLAIN_LITERAL_ARG = /^\s*['"][^'"]*['"]\s*$/;

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.svelte-kit' || name === 'dist') continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, out);
        else if (/\.(ts|js|mjs|cjs|mts|cts|svelte|css)$/.test(name) && !/\.d\.ts$/.test(name))
            out.push(abs); // .css included so a protected-tree stylesheet gets tier-checked too
    }
    return out;
}

// The protected SPDX tags. The split is PATH-BASED (see LICENSING.md §1): a code file's
// header must carry EXACTLY the tag for its tier — so a forgotten header on a new protected
// file can't silently default it to AGPL, and a stray header can't appear in the wrong tier.
const PROP_TAG = /SPDX-License-Identifier:\s*LicenseRef-Lumastra-Proprietary/;
const ENT_TAG = /SPDX-License-Identifier:\s*LicenseRef-Lumastra-Enterprise/;

const importViolations = [];
const headerViolations = [];

const files = [];
for (const d of SCAN_DIRS) {
    const p = join(ROOT, d);
    if (existsSync(p)) walk(p, files);
}

for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    const isTest = /\.(test|spec)\./.test(rel);
    const tier = tierOf(rel);
    const code = readFileSync(abs, 'utf8');

    // (a) Header classification — each non-test, non-brand code file must carry exactly the
    // SPDX tag for its tier (check just the header region so a mid-file literal can't trip it).
    if (!isTest && !isBranding(rel)) {
        const head = code.slice(0, 800);
        const hasProp = PROP_TAG.test(head);
        const hasEnt = ENT_TAG.test(head);
        if (tier === 'enterprise') {
            if (!hasEnt)
                headerViolations.push(
                    `${rel}  — under an Enterprise (§3) path but missing the LicenseRef-Lumastra-Enterprise header`,
                );
            if (hasProp)
                headerViolations.push(
                    `${rel}  — under an Enterprise path but carries the Proprietary header`,
                );
        } else if (tier === 'proprietary') {
            if (!hasProp)
                headerViolations.push(
                    `${rel}  — under a Proprietary (§3) path but missing the LicenseRef-Lumastra-Proprietary header`,
                );
            if (hasEnt)
                headerViolations.push(
                    `${rel}  — under a Proprietary path but carries the Enterprise header`,
                );
        } else if (hasProp || hasEnt) {
            headerViolations.push(
                `${rel}  — carries a proprietary/enterprise SPDX header but is not under a §3 protected path`,
            );
        }
    }

    // (b) Import direction — enforce AGPL ◁ proprietary ◁ enterprise.
    // enterprise may import anything. AGPL must not reach either protected tier; proprietary
    // must not reach enterprise. Tests under src/ DO ship in the public tree (only the
    // enterprise tier is stripped), so a test may import proprietary code but never
    // enterprise code — `src/lib/schemas/training.test.ts` did, passed here, and broke the
    // public typecheck on 2026-09-12. Such a test belongs next to the code it tests.
    if (tier === 'enterprise') continue;
    const forbidden =
        tier === 'agpl' && !isTest ? [PROP_SPECIFIER, ENT_SPECIFIER] : [ENT_SPECIFIER];
    const reaches = (s) => forbidden.some((re) => re.test(s));
    const why = isTest
        ? 'shipped test → enterprise (stripped from the public tree)'
        : tier === 'agpl'
          ? 'AGPL core → protected tree'
          : 'proprietary → enterprise';

    for (const re of [IMPORT_FROM, BARE_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code))) {
            if (reaches(m[1])) importViolations.push(`${rel}  (${why})  →  ${m[1]}`);
        }
    }

    // (c) import.meta.glob into a forbidden tree — only the one sanctioned (file, pattern)
    // pair (the AGPL entitlements optional-load shim) may glob into proprietary.
    GLOB_CALL.lastIndex = 0;
    let g;
    while ((g = GLOB_CALL.exec(code))) {
        const pattern = g[2];
        if (!reaches(pattern)) continue;
        if (rel === SANCTIONED_GLOB_FILE && pattern === SANCTIONED_GLOB_PATTERN) continue;
        importViolations.push(
            `${rel}  →  import.meta.glob('${pattern}')  (unsanctioned glob into a protected tree)`,
        );
    }

    // (d) Computed specifiers that mention a forbidden tree (heuristic).
    COMPUTED_CALL.lastIndex = 0;
    let c;
    while ((c = COMPUTED_CALL.exec(code))) {
        const arg = c[1];
        if (!reaches(arg)) continue;
        if (PLAIN_LITERAL_ARG.test(arg)) continue; // already covered by the literal rules
        importViolations.push(
            `${rel}  →  ${arg.trim().slice(0, 80)}  (computed specifier mentioning a protected tree)`,
        );
    }
}

let failed = false;
if (importViolations.length > 0) {
    failed = true;
    console.error(
        'License-boundary violation (AGPL ◁ proprietary ◁ enterprise): a lower tier must',
    );
    console.error(
        'not import a higher one. Move the shared module down a tier, or route the call via',
    );
    console.error('the entitlements registry / module-gate / HTTP. Offending edges:\n');
    for (const v of importViolations) console.error('  ' + v);
    console.error('');
}
if (headerViolations.length > 0) {
    failed = true;
    console.error(
        "License-header violation: each protected file must carry exactly its tier's SPDX",
    );
    console.error('header (path-based, per LICENSING.md §1 — Proprietary vs Enterprise):\n');
    for (const v of headerViolations) console.error('  ' + v);
    console.error('');
}
if (failed) process.exit(1);

console.log(
    'License boundary OK — AGPL ◁ proprietary ◁ enterprise holds (no forbidden import edges in any form), and every protected file carries the correct Proprietary/Enterprise SPDX header.',
);
