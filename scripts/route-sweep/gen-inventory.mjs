// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * gen-inventory — build the route-sweep inventory from the source tree.
 *
 * WHY THIS IS GENERATED, NOT HAND-WRITTEN
 * A hand-maintained list of "every route" is wrong the day after it is written.
 * This walks src/routes for the page surface and docs/api/*.yaml for the API
 * surface, so a route added next month shows up as an UNTESTED row rather than
 * silently escaping the sweep. Run with --check in CI to fail on drift.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not claim to know who may reach a route. There is no central public-
 * path allowlist in this app: page auth is forward-auth at the proxy plus the
 * root +layout.server.ts ("closed by default: an anonymous visitor (only /login
 * and /setup)"), and /admin/** adds its own `locals.user?.isAdmin` redirect.
 * So `gate` here is the DECLARED model plus the evidence it was read from.
 * Establishing the ACTUAL gate is Tier C's job, and a mismatch between the two
 * is a finding, not a bug in this file.
 *
 * Usage:
 *   node scripts/route-sweep/gen-inventory.mjs
 *   node scripts/route-sweep/gen-inventory.mjs --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '../..');
const routesRoot = path.join(appRoot, 'src', 'routes');
const docsApi = path.join(appRoot, 'docs', 'api');

const JSON_OUT = path.join(appRoot, 'tests', 'route-sweep', 'inventory.generated.json');
const MD_OUT = path.join(appRoot, 'tests', 'route-sweep', 'matrix.generated.md');

const checkMode = process.argv.includes('--check');

/* ------------------------------------------------------------------ walk -- */

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

/* ------------------------------------------------------------- page routes - */

/**
 * SvelteKit route id -> the URL a browser actually requests.
 * `(group)` segments are layout groups and contribute nothing to the URL.
 */
function routeIdToUrl(routeId) {
    const segs = routeId
        .split('/')
        .filter((s) => s.length > 0)
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    return '/' + segs.join('/');
}

/** `[id]`, `[[page]]`, `[...rest]` -> structured param descriptors. */
function extractParams(routeId) {
    const params = [];
    for (const raw of routeId.match(/\[+[^\]]+\]+/g) ?? []) {
        const inner = raw.replace(/^\[+/, '').replace(/\]+$/, '');
        const optional = raw.startsWith('[[');
        const rest = inner.startsWith('...');
        params.push({
            raw,
            name: rest ? inner.slice(3) : inner,
            kind: rest ? 'rest' : optional ? 'optional' : 'required',
        });
    }
    return params;
}

function classifyTree(routeId) {
    if (routeId.includes('(private)')) return 'private';
    if (routeId.includes('(modules)')) return 'modules';
    return 'public';
}

/**
 * The DECLARED gate. See the file header for why this is not a claim about
 * reachability. `evidence` names the file each rule was read from, so a reader
 * can check the rule rather than trust it.
 */
function classifyGate(routeId, ancestorLayoutServers) {
    const url = routeIdToUrl(routeId);
    const evidence = ancestorLayoutServers.slice();
    if (url === '/login' || url === '/setup') {
        return {
            gate: 'public',
            evidence: [
                ...evidence,
                'src/routes/+layout.server.ts: "anonymous visitor (only /login and /setup)"',
            ],
        };
    }
    if (url === '/admin' || url.startsWith('/admin/')) {
        return {
            gate: 'admin',
            evidence: [
                ...evidence,
                'src/routes/admin/+layout.server.ts: !locals.user?.isAdmin -> redirect(303)',
            ],
        };
    }
    return {
        gate: 'user',
        evidence: [...evidence, 'src/routes/+layout.server.ts: closed by default'],
    };
}

/** Named form actions in a +page.server.ts, e.g. `default:` / `save:`. */
function extractActionNames(src) {
    const block = src.match(
        /export const actions[^=]*=\s*\{([\s\S]*?)\n\}\s*satisfies|export const actions[^=]*=\s*\{([\s\S]*?)\n\};/,
    );
    const body = block ? (block[1] ?? block[2] ?? '') : '';
    const names = new Set();
    for (const m of body.matchAll(/^\s{4}(\w+)\s*:/gm)) names.add(m[1]);
    return [...names].sort();
}

function collectPages() {
    const files = walk(routesRoot).filter((f) => path.basename(f) === '+page.svelte');
    const pages = [];

    for (const file of files.sort()) {
        const dir = path.dirname(file);
        const routeId = path.relative(routesRoot, dir).split(path.sep).join('/');
        const id = routeId === '' ? '' : routeId;

        // Ancestor +layout.server.ts files, nearest last — these are the gates.
        const ancestors = [];
        let cursor = dir;
        while (cursor.startsWith(routesRoot)) {
            const ls = path.join(cursor, '+layout.server.ts');
            if (fs.existsSync(ls)) ancestors.unshift(path.relative(appRoot, ls));
            if (cursor === routesRoot) break;
            cursor = path.dirname(cursor);
        }

        const pageServer = path.join(dir, '+page.server.ts');
        const hasPageServer = fs.existsSync(pageServer);
        const serverSrc = hasPageServer ? fs.readFileSync(pageServer, 'utf8') : '';
        const hasFormActions = /export const actions\b/.test(serverSrc);

        const { gate, evidence } = classifyGate(id, ancestors);
        const tree = classifyTree(id);

        pages.push({
            routeId: '/' + id,
            url: routeIdToUrl(id),
            params: extractParams(id),
            tree,
            // Source-available routes ship in the public build; commercial-only
            // routes are omitted from the published inventory.
            inPublicBuild: tree !== 'private',
            gate,
            gateEvidence: evidence,
            hasPageServer,
            hasFormActions,
            actions: hasFormActions ? extractActionNames(serverSrc) : [],
            tiers: {
                A: true,
                B: hasFormActions,
                C: gate === 'admin',
            },
        });
    }

    return pages;
}

/* --------------------------------------------------------------- api defs - */

/**
 * Collect every `&anchor` definition in a YAML document as its raw block.
 *
 * The generated specs express repeated values as YAML anchors — `security: &a1`
 * once, then `security: *a1` on the 500-odd operations that share it. A scanner
 * that does not resolve those reports "no security declared" for EVERY
 * operation, which is exactly the kind of uniform, too-clean result that means
 * the tool is broken rather than the data being empty.
 *
 * A full `parse()` would resolve them for free but overflows the stack on these
 * documents (deeply recursive component schemas, 1.6-5.2 MB), so anchors are
 * resolved directly. Only anchors are handled, not merge keys (`<<:`), because
 * the generator does not emit them — see scripts/openapi/generate.ts.
 */
function collectAnchors(lines) {
    const anchors = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)\S+: &(\w+)\s*$/);
        if (!m) continue;
        const [, indent, name] = m;
        const block = [];
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === '') {
                block.push(line);
                continue;
            }
            const lead = line.match(/^\s*/)[0].length;
            if (lead <= indent.length) break;
            block.push(line);
        }
        anchors.set(name, block);
    }
    return anchors;
}

/** `- bearerAuth: []` / `- scope-name` block -> flat token list. */
function securityTokens(block) {
    const tokens = [];
    for (const line of block) {
        const scheme = line.match(/^\s*-\s*([\w-]+):/);
        if (scheme) {
            tokens.push(scheme[1]);
            continue;
        }
        const scope = line.match(/^\s*-\s*([\w:.*-]+)\s*$/);
        if (scope) tokens.push(`scope:${scope[1]}`);
    }
    return tokens;
}

/**
 * Scan a generated OpenAPI document for its operations.
 *
 * Line-based on purpose: these documents are 1.6-5.2 MB and we need five fields
 * per operation, not a full object graph. The shape is stable because the files
 * are machine-written by scripts/openapi/generate.ts (yaml stringify, two-space
 * indent) and drift-checked by `npm run openapi:check`.
 *
 * NOTE: `declaredSecurity` is what the document CLAIMS. It is an input to Tier
 * C, never a substitute for it — a def header in this repo has lied about being
 * internal-only before, and `auth: 'none'` has meant "unreachable", not "open".
 */
function scanOpenApi(file, surface) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const anchors = collectAnchors(lines);
    const ops = [];

    let inPaths = false;
    let curPath = null;
    let curOp = null;
    let securityBlock = null;

    const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

    const flushSecurity = () => {
        if (curOp && securityBlock) curOp.declaredSecurity = securityTokens(securityBlock);
        securityBlock = null;
    };

    for (const line of lines) {
        if (/^paths:\s*$/.test(line)) {
            inPaths = true;
            continue;
        }
        if (inPaths && /^\S/.test(line)) {
            flushSecurity();
            inPaths = false;
        }
        if (!inPaths) continue;

        const pathKey = line.match(/^ {2}(\/\S*):\s*$/);
        if (pathKey) {
            flushSecurity();
            curPath = pathKey[1];
            curOp = null;
            continue;
        }

        const methodKey = line.match(/^ {4}([a-z]+):\s*$/);
        if (methodKey && METHODS.has(methodKey[1])) {
            flushSecurity();
            curOp = {
                path: curPath,
                method: methodKey[1].toUpperCase(),
                surface,
                mutating: !['get', 'head', 'options'].includes(methodKey[1]),
                operationId: null,
                summary: null,
                declaredSecurity: [],
            };
            ops.push(curOp);
            continue;
        }

        if (!curOp) continue;

        // security, in its three emitted forms: alias, anchor+block, inline block.
        const alias = line.match(/^ {6}security:\s*\*(\w+)\s*$/);
        if (alias) {
            flushSecurity();
            curOp.declaredSecurity = securityTokens(anchors.get(alias[1]) ?? []);
            continue;
        }
        if (/^ {6}security:(\s*&\w+)?\s*$/.test(line)) {
            flushSecurity();
            securityBlock = [];
            continue;
        }
        if (securityBlock) {
            if (/^ {6}\S/.test(line) || /^ {0,5}\S/.test(line)) flushSecurity();
            else {
                securityBlock.push(line);
                continue;
            }
        }

        const opId = line.match(/^ {6}operationId:\s*(.+)$/);
        if (opId) {
            curOp.operationId = opId[1].trim();
            continue;
        }
        const summary = line.match(/^ {6}summary:\s*(.+)$/);
        if (summary) {
            curOp.summary = summary[1].trim().replace(/^['"]|['"]$/g, '');
            continue;
        }
    }
    flushSecurity();

    return ops;
}

/* ------------------------------------------------------------------ build - */

const pages = collectPages().filter((page) => page.inPublicBuild);
const api = [
    ...scanOpenApi(path.join(docsApi, 'api-v1.yaml'), 'v1'),
    ...scanOpenApi(path.join(docsApi, 'internal-api.yaml'), 'internal'),
];

/*
 * Fixture slots, keyed by ROUTE then param — never by param name alone.
 *
 * `id` alone appears on nine unrelated routes (/playlists/[id],
 * /music/albums/[id], /music/artists/[id], /music/radio/[id],
 * /admin/library/media/[id]). A playlist id is not
 * an album id, so a single `id` slot would send one of them a value that is
 * valid-looking but belongs to a different entity — and the route would 404 for
 * a reason that has nothing to do with the defect being hunted.
 *
 * Each slot needs a valid value AND a well-formed-but-nonexistent one. The
 * nonexistent case must 404; this app has previously answered it with a 500
 * (an FK violation, via checkMediaAccess accepting unknown ids), which is the
 * single most likely thing Tier A finds.
 *
 * Values are null here on purpose. They are resolved over HTTP against the
 * target at run start, never from a database and never hardcoded, so the same
 * inventory drives a populated preprod and an empty fresh install.
 */
const paramNames = [...new Set(pages.flatMap((p) => p.params.map((x) => x.name)))].sort();

const paramFixtures = Object.fromEntries(
    pages
        .filter((p) => p.params.length > 0)
        .map((p) => [
            p.routeId,
            Object.fromEntries(
                p.params.map((x) => [x.name, { kind: x.kind, valid: null, nonexistent: null }]),
            ),
        ]),
);

const inventory = {
    $generated: 'AUTO-GENERATED by scripts/route-sweep/gen-inventory.mjs — do not edit by hand',
    generator: 'scripts/route-sweep/gen-inventory.mjs',
    counts: {
        pages: pages.length,
        pagesInPublicBuild: pages.filter((p) => p.inPublicBuild).length,
        pagesStrippedFromPublicBuild: pages.filter((p) => !p.inPublicBuild).length,
        pagesByGate: pages.reduce((a, p) => ({ ...a, [p.gate]: (a[p.gate] ?? 0) + 1 }), {}),
        pagesWithParams: pages.filter((p) => p.params.length > 0).length,
        paramFixtureSlots: pages.reduce((a, p) => a + p.params.length, 0),
        pagesWithFormActions: pages.filter((p) => p.hasFormActions).length,
        formActions: pages.reduce((a, p) => a + p.actions.length, 0),
        apiOperations: api.length,
        apiMutating: api.filter((o) => o.mutating).length,
        apiBySurface: api.reduce((a, o) => ({ ...a, [o.surface]: (a[o.surface] ?? 0) + 1 }), {}),
    },
    paramFixtures,
    pages,
    api,
};

/* ----------------------------------------------------------------- matrix - */

function area(url) {
    if (url === '/') return 'root';
    const seg = url.split('/')[1];
    if (seg === 'admin') {
        const sub = url.split('/')[2];
        return sub ? `admin/${sub}` : 'admin';
    }
    return seg;
}

function renderMatrix() {
    const byArea = new Map();
    for (const p of pages) {
        const a = area(p.url);
        if (!byArea.has(a)) byArea.set(a, []);
        byArea.get(a).push(p);
    }

    const out = [];
    out.push(
        '<!-- AUTO-GENERATED by scripts/route-sweep/gen-inventory.mjs — do not edit by hand. -->',
    );
    out.push('<!-- Status columns are filled in by the sweep, not by this generator. -->');
    out.push('');
    out.push('# Route sweep matrix');
    out.push('');
    out.push(
        `Generated from the source tree. ${inventory.counts.pages} page routes, ` +
            `${inventory.counts.pagesInPublicBuild} of them present in the stripped public build.`,
    );
    out.push('');
    out.push(
        '**Status values.** `—` not run · `PASS` · `FAIL` · `BLOCKED` (could not be tested — ' +
            'a red row, never a skip). A route that cannot be tested is reported, not hidden: ' +
            'nine specs in this repo were once false-green behind a `test.skip()`.',
    );
    out.push('');
    out.push(
        '**Columns.** `Build`: `public` ships in the OSS build, `ent` is stripped by ' +
            '`.publicignore`. `Gate`: the *declared* model (see the generator header) — Tier C ' +
            'establishes the real one, and a mismatch is a finding.',
    );
    out.push('');

    for (const a of [...byArea.keys()].sort()) {
        const rows = byArea.get(a).sort((x, y) => x.url.localeCompare(y.url));
        out.push(`## ${a}`);
        out.push('');
        out.push('| Route | Gate | Build | Params | Form actions | A preprod | A fresh | B | C |');
        out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const p of rows) {
            const params = p.params.length ? p.params.map((x) => x.name).join(', ') : '—';
            const actions = p.actions.length
                ? p.actions.join(', ')
                : p.hasFormActions
                  ? 'yes'
                  : '—';
            const build = p.inPublicBuild
                ? p.tree === 'modules'
                    ? 'public*'
                    : 'public'
                : 'ent';
            out.push(
                `| \`${p.url}\` | ${p.gate} | ${build} | ${params} | ${actions} | — | — | ${p.tiers.B ? '—' : 'n/a'} | ${p.tiers.C ? '—' : 'n/a'} |`,
            );
        }
        out.push('');
    }

    out.push('---');
    out.push('');
    out.push(
        '`public*` = `(modules)` tree (the `/j` and assistant routes). ' +
            '`ent` = not in the public repo.',
    );
    out.push('');
    return out.join('\n');
}

/* ------------------------------------------------------------------ write - */

/*
 * Emit exactly what Prettier would emit.
 *
 * Without this the generator loses a fight it cannot win: lint-staged runs
 * `prettier --write` over staged .json and .md, so every commit rewrote these
 * two files and `--check` then reported STALE forever — the drift gate would
 * have been permanently red and quickly ignored. Formatting here makes the
 * generator and the commit hook agree by construction.
 */
async function formatted(text, filepath) {
    const config = await prettier.resolveConfig(filepath);
    return prettier.format(text, { ...config, filepath });
}

const jsonText = await formatted(JSON.stringify(inventory, null, 2) + '\n', JSON_OUT);
const mdText = await formatted(renderMatrix(), MD_OUT);

function compare(file, next) {
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    // The timestamp-free payload is what matters; there is no timestamp in the
    // output precisely so --check can be a plain byte comparison.
    return prev === next;
}

if (checkMode) {
    const stale = [];
    if (!compare(JSON_OUT, jsonText)) stale.push(path.relative(appRoot, JSON_OUT));
    if (!compare(MD_OUT, mdText)) stale.push(path.relative(appRoot, MD_OUT));
    if (stale.length) {
        console.error('route-sweep inventory is STALE:\n  ' + stale.join('\n  '));
        console.error('\nRun: node scripts/route-sweep/gen-inventory.mjs');
        process.exit(1);
    }
    console.log('route-sweep inventory up to date');
    process.exit(0);
}

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
fs.writeFileSync(JSON_OUT, jsonText, 'utf8');
fs.writeFileSync(MD_OUT, mdText, 'utf8');

console.log(`pages:              ${inventory.counts.pages}`);
console.log(`  in public build:  ${inventory.counts.pagesInPublicBuild}`);
console.log(`  stripped (ent):   ${inventory.counts.pagesStrippedFromPublicBuild}`);
console.log(`  by gate:          ${JSON.stringify(inventory.counts.pagesByGate)}`);
console.log(
    `  with params:      ${inventory.counts.pagesWithParams} routes, ${inventory.counts.paramFixtureSlots} fixture slots ` +
        `(${paramNames.length} distinct names — slots are keyed by route+param, not by name)`,
);
console.log(
    `  with form actions:${inventory.counts.pagesWithFormActions} (${inventory.counts.formActions} actions)`,
);
console.log(
    `api operations:     ${inventory.counts.apiOperations} (${inventory.counts.apiMutating} mutating)`,
);
console.log(`  by surface:       ${JSON.stringify(inventory.counts.apiBySurface)}`);
console.log(`\nwrote ${path.relative(appRoot, JSON_OUT)}`);
console.log(`wrote ${path.relative(appRoot, MD_OUT)}`);
