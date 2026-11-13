#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Adds SPDX license headers to source files.
//   node scripts/license-headers.mjs --dry-run   # report only, write nothing
//   node scripts/license-headers.mjs --check     # CI gate: exit 1 if any file lacks a header
//                                                 # (or, under a permissive path, still says AGPL)
//   node scripts/license-headers.mjs             # apply
// Every file is AGPL-3.0-only except the plugin SDK and sample plugins (Apache-2.0).
// Idempotent: skips files that already have an SPDX header. The one exception
// is the AGPL→Apache-2.0 transition for PERMISSIVE paths (packages/@sapd/, examples/plugins/) —
// a file there still carrying the old AGPL-3.0-only tag gets that one line rewritten. Fully
// git-revertible.
import fs from 'node:fs';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run') || CHECK;
const ROOT = process.cwd();
const HOLDER = '2026 Denis Arnst (Sapd)';
const OPEN_SPDX = 'AGPL-3.0-only';
const PERMISSIVE_SPDX = 'Apache-2.0';

// Permissive (Apache-2.0) — the plugin SDK packages and the sample
// plugins third-party authors copy. Kept permissive (not AGPL) so a plugin author who only
// touches these trees never inherits AGPL obligations. See LICENSING.md §4.
const PERMISSIVE = ['packages/@sapd/', 'examples/plugins/'];

const SCAN_DIRS = ['src', 'scripts', 'tests', 'packages', 'plugins', 'examples', 'native'];
const EXCLUDE_DIR = new Set([
    'node_modules',
    'target',
    '.svelte-kit',
    'build',
    'dist',
    '.vercel',
    '.git',
    'coverage',
    'test-results',
    'playwright-report',
    '.turbo',
]);
const EXCLUDE_CONTAINS = ['/paraglide/']; // generated i18n
const EXCLUDE_FILE = new Set(['src/lib/api/schema.d.ts', 'tests/api-recipes/generated/api-v1.d.ts']); // generated openapi types
const STYLE = {
    '.rs': 'c',
    '.ts': 'c',
    '.tsx': 'c',
    '.js': 'c',
    '.mjs': 'c',
    '.cjs': 'c',
    '.svelte': 'html',
    '.css': 'css',
};

const isPermissive = (rel) => PERMISSIVE.some((p) => rel.startsWith(p));

function headerFor(rel, style) {
    const spdx = isPermissive(rel) ? PERMISSIVE_SPDX : OPEN_SPDX;
    const body = [`SPDX-FileCopyrightText: ${HOLDER}`, `SPDX-License-Identifier: ${spdx}`];
    if (style === 'c') return body.map((l) => `// ${l}`).join('\n') + '\n\n';
    if (style === 'css') return '/*\n' + body.map((l) => ` * ${l}`).join('\n') + '\n */\n\n';
    if (style === 'html') return '<!--\n' + body.map((l) => `  ${l}`).join('\n') + '\n-->\n\n';
}

function collect(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!EXCLUDE_DIR.has(e.name)) collect(path.join(dir, e.name), out);
        } else if (e.isFile()) {
            out.push(path.join(dir, e.name));
        }
    }
}

const files = [];
for (const d of SCAN_DIRS) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) collect(p, files);
}

const stats = { agpl: 0, permissive: 0, already: 0, rewritten: 0, byExt: {} };
const changed = [];
const rewritten = [];
// Existing-file transition: a PERMISSIVE-path file already stamped AGPL-3.0-only (from before
// this classification existed) must move to Apache-2.0. Only that exact transition, and only
// under PERMISSIVE paths — every other tier's existing header is left untouched.
const HEAD_LEN = 600;
const AGPL_TAG_RE = /SPDX-License-Identifier:\s*AGPL-3\.0-only/;
for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const ext = path.extname(rel);
    const style = STYLE[ext];
    if (!style) continue;
    if (EXCLUDE_FILE.has(rel)) continue;
    if (EXCLUDE_CONTAINS.some((s) => ('/' + rel).includes(s))) continue;
    let content;
    try {
        content = fs.readFileSync(abs, 'utf8');
    } catch {
        continue;
    }
    const head = content.slice(0, HEAD_LEN);
    if (head.includes('SPDX-License-Identifier')) {
        if (isPermissive(rel) && AGPL_TAG_RE.test(head)) {
            const newHead = head.replace(AGPL_TAG_RE, 'SPDX-License-Identifier: Apache-2.0');
            const next = newHead + content.slice(HEAD_LEN);
            if (!DRY) fs.writeFileSync(abs, next);
            rewritten.push(rel);
            stats.rewritten++;
        } else {
            stats.already++;
        }
        continue;
    }
    const hdr = headerFor(rel, style);
    let next;
    if (style === 'c' && content.startsWith('#!')) {
        const nl = content.indexOf('\n');
        next = content.slice(0, nl + 1) + hdr + content.slice(nl + 1);
    } else {
        next = hdr + content;
    }
    if (!DRY) fs.writeFileSync(abs, next);
    changed.push(rel);
    stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
    if (isPermissive(rel)) stats.permissive++;
    else stats.agpl++;
}

if (CHECK) {
    const missing = changed.length;
    const stale = rewritten.length;
    if (missing > 0 || stale > 0) {
        console.error(
            `SPDX header check FAILED — ${missing} file(s) without an SPDX header, ${stale} file(s) under a permissive path still tagged AGPL-3.0-only:\n`,
        );
        changed.forEach((f) => console.error('  [missing]         ' + f));
        rewritten.forEach((f) => console.error('  [stale AGPL→Apache] ' + f));
        console.error(
            '\nFix: node scripts/license-headers.mjs   (stamps/rewrites them per the path rules)',
        );
        process.exit(1);
    }
    console.log(
        `SPDX header check OK — all ${stats.already} scanned files carry an SPDX header.`,
    );
    process.exit(0);
}

console.log(
    `${DRY ? '[DRY RUN] ' : ''}stamped ${changed.length} files  (AGPL ${stats.agpl} | permissive ${stats.permissive})`,
);
console.log(`rewritten AGPL→Apache-2.0 under permissive paths: ${rewritten.length}`);
console.log(`already had a correct header (skipped): ${stats.already}`);
console.log('by extension:', JSON.stringify(stats.byExt));
const permissiveSample = changed.filter(isPermissive);
console.log(`permissive (Apache-2.0) files newly stamped (${permissiveSample.length}), sample:`);
permissiveSample.slice(0, 6).forEach((f) => console.log('   ', f));
if (rewritten.length) {
    console.log(`rewritten (AGPL→Apache-2.0), sample:`);
    rewritten.slice(0, 6).forEach((f) => console.log('   ', f));
}
if (DRY) console.log('\n(dry run — nothing written. Re-run without --dry-run to apply.)');
