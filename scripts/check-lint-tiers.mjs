#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lint-tier drift guard.
 *
 * `eslint.config.cjs` enables `projectService: true` (a full TypeScript program,
 * `parserOptions.projectService`) on a small set of `files` globs, spread across
 * more than one config block. Building that program is expensive: with ESLint's
 * default `--concurrency=auto` (no `resourceLimits` passed to `new Worker`, see
 * node_modules/eslint/lib/eslint/eslint.js), every worker thread inherits the
 * SAME `--max-old-space-size` from `NODE_OPTIONS` and independently builds its
 * own full TypeScript program. If even one type-aware glob leaks into the
 * multi-worker `lint:fast` tier, each of its ~N workers builds a program in
 * parallel and the box OOMs — this happened for real (2026-08-11): five of
 * eight type-aware globs had leaked into `lint:fast`, which then thrashed a
 * 24GB machine into `ERR_WORKER_OUT_OF_MEMORY`.
 *
 * The fix is a two-tier split:
 *   - `lint:fast`  — many workers, must be strictly type-free. Every
 *     `projectService` glob must be excluded via `--ignore-pattern`.
 *   - `lint:typed` — a single isolate (or a small fixed `--concurrency`), and
 *     must explicitly lint every glob excluded from `lint:fast` so that no
 *     rule coverage is lost by moving files between tiers.
 *
 * `eslint.config.cjs` and `package.json` are two independent files that each
 * look reasonable in isolation — nothing enforces that they still agree after
 * an edit to either one. This script is that enforcement: it parses the
 * `projectService: true` globs out of the config and asserts every one of them
 * is EITHER ignored by `lint:fast` OR covered by `lint:typed`. A glob that is
 * neither (dropped from both) fails loudly; a glob added to `lint:fast`
 * without being ignored (the original 2026-08-11 bug) also fails loudly.
 *
 * This is a scoped, regex-based heuristic over the two source files, not a
 * real JS/JSON evaluator — see the extraction helpers below for its known
 * assumptions. It is intentionally strict: any drift in shape it doesn't
 * recognize should fail rather than silently pass.
 *
 * Run: `node scripts/check-lint-tiers.mjs` (wired as `npm run lint:tiers`,
 * first stage of `npm run lint` — cheap, so it should run before the
 * expensive eslint invocations).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const ESLINT_CONFIG_PATH = join(ROOT, 'eslint.config.cjs');
const PACKAGE_JSON_PATH = join(ROOT, 'package.json');

// --- 1. Extract every `files: [...]` glob array that has `projectService: true`
//        somewhere in the same config-object block. ------------------------------
//
// Assumption (matches eslint.config.cjs's actual shape): each type-aware block is
// `{ files: [...], ..., languageOptions: { parser, parserOptions: { projectService:
// true, ... } }, ... }` — i.e. the `files` array appears BEFORE `projectService: true`
// within the same object, with no other block's `files` array in between. We find
// the nearest preceding `files: [...]` block for each `projectService: true` hit.

function extractProjectServiceGlobs(configSrc) {
    const filesBlockRe = /files:\s*\[([^\]]*)\]/g;
    const filesBlocks = [];
    let m;
    while ((m = filesBlockRe.exec(configSrc))) {
        filesBlocks.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
    }

    const globs = new Set();
    const projectServiceRe = /projectService:\s*true/g;
    let p;
    while ((p = projectServiceRe.exec(configSrc))) {
        // Nearest files-block that starts before this projectService hit.
        let nearest = null;
        for (const block of filesBlocks) {
            if (block.start < p.index && (nearest === null || block.start > nearest.start)) {
                nearest = block;
            }
        }
        if (!nearest) {
            console.error(
                `check-lint-tiers: found "projectService: true" at offset ${p.index} in ` +
                    `eslint.config.cjs with no preceding "files: [...]" array — cannot determine ` +
                    `which globs it applies to. The heuristic in scripts/check-lint-tiers.mjs needs ` +
                    `updating to match the new config shape.`,
            );
            process.exit(1);
        }
        for (const g of extractQuotedStrings(nearest.body)) globs.add(g);
    }
    return [...globs];
}

function extractQuotedStrings(text) {
    const re = /['"]([^'"]+)['"]/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
}

// --- 2. Extract the `--ignore-pattern '<glob>'` values from lint:fast, and the ------
//        positional target globs passed straight to `eslint` in lint:typed. --------

function extractIgnorePatterns(scriptStr) {
    const re = /--ignore-pattern\s+['"]([^'"]+)['"]/g;
    const out = [];
    let m;
    while ((m = re.exec(scriptStr))) out.push(m[1]);
    return out;
}

function extractTypedTargetGlobs(scriptStr) {
    // Locate the actual `eslint <globs...> --flags` invocation. Everything before
    // " eslint " may itself contain quoted strings (NODE_OPTIONS='...'), so we must
    // not scan the whole script string.
    const eslintIdx = scriptStr.indexOf(' eslint ');
    if (eslintIdx === -1) {
        console.error(
            'check-lint-tiers: could not find an " eslint " invocation inside the lint:typed ' +
                'script in package.json — the heuristic in scripts/check-lint-tiers.mjs needs updating.',
        );
        process.exit(1);
    }
    const afterEslint = scriptStr.slice(eslintIdx + ' eslint '.length);
    const flagsIdx = afterEslint.indexOf(' --');
    const targetsSection = flagsIdx === -1 ? afterEslint : afterEslint.slice(0, flagsIdx);
    return extractQuotedStrings(targetsSection);
}

// --- 3. Matching: compare globs by their fixed (non-wildcard) directory prefix. ----

function globPrefix(glob) {
    const idx = glob.indexOf('*');
    return idx === -1 ? glob : glob.slice(0, idx);
}

function isIgnoredByFast(glob, ignorePatterns) {
    const gp = globPrefix(glob);
    return ignorePatterns.some((ip) => {
        const ipp = globPrefix(ip);
        return gp === ipp || gp.startsWith(ipp);
    });
}

function isCoveredByTyped(glob, typedGlobs) {
    if (typedGlobs.includes(glob)) return true;
    const gp = globPrefix(glob);
    return typedGlobs.some((tg) => globPrefix(tg) === gp);
}

// --- run ---

const configSrc = readFileSync(ESLINT_CONFIG_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));

const lintFastScript = pkg.scripts?.['lint:fast'];
const lintTypedScript = pkg.scripts?.['lint:typed'];

if (!lintFastScript || !lintTypedScript) {
    console.error(
        'check-lint-tiers: package.json is missing a "lint:fast" or "lint:typed" script — ' +
            'nothing to check against.',
    );
    process.exit(1);
}

const projectServiceGlobs = extractProjectServiceGlobs(configSrc);
const ignorePatterns = extractIgnorePatterns(lintFastScript);
const typedGlobs = extractTypedTargetGlobs(lintTypedScript);

if (projectServiceGlobs.length === 0) {
    console.error(
        'check-lint-tiers: found ZERO "projectService: true" globs in eslint.config.cjs — that ' +
            'is almost certainly a parse failure in scripts/check-lint-tiers.mjs, not reality ' +
            '(the config is known to have type-aware blocks). Failing closed.',
    );
    process.exit(1);
}

// A type-aware glob is only SAFE when BOTH hold: excluded from the multi-worker
// lint:fast tier (or it re-triggers the OOM — being "also" linted by lint:typed
// does not neutralize that risk, since lint:fast still processes it in parallel
// worker isolates) AND explicitly linted by lint:typed (or --ignore-pattern drops
// it from lint:fast's run entirely — including its ordinary, non-type-aware rules
// — with nothing else picking it up, i.e. total coverage loss). Either condition
// failing alone is a distinct, nameable problem, so both are diagnosed separately
// below rather than collapsed into one generic "uncovered" bucket.
const leakedIntoFast = []; // not ignored by lint:fast -> OOM risk (the 2026-08-11 bug)
const droppedEntirely = []; // ignored by lint:fast but not linted by lint:typed -> zero coverage

for (const glob of projectServiceGlobs) {
    const ignored = isIgnoredByFast(glob, ignorePatterns);
    const covered = isCoveredByTyped(glob, typedGlobs);
    if (!ignored) leakedIntoFast.push(glob);
    else if (!covered) droppedEntirely.push(glob);
}

if (leakedIntoFast.length > 0 || droppedEntirely.length > 0) {
    if (leakedIntoFast.length > 0) {
        console.error(
            'check-lint-tiers: the following type-aware ("projectService: true") glob(s) are NOT ' +
                "excluded from lint:fast's --ignore-pattern list. lint:fast runs with multiple " +
                'worker isolates (--concurrency), each of which would independently build a full ' +
                'TypeScript program for these files — this is the exact 2026-08-11 OOM bug:\n',
        );
        for (const g of leakedIntoFast) console.error(`  ${g}`);
        console.error(
            '\nFix: add --ignore-pattern for each glob above to lint:fast in package.json.\n',
        );
    }
    if (droppedEntirely.length > 0) {
        console.error(
            'check-lint-tiers: the following type-aware ("projectService: true") glob(s) are ' +
                'excluded from lint:fast but NOT linted by lint:typed — they receive ZERO lint ' +
                'coverage (--ignore-pattern drops a file from the entire lint:fast run, not just ' +
                'its type-aware rules):\n',
        );
        for (const g of droppedEntirely) console.error(`  ${g}`);
        console.error("\nFix: add each glob above to lint:typed's target globs in package.json.\n");
    }
    process.exit(1);
}

console.log(
    `check-lint-tiers: OK — all ${projectServiceGlobs.length} type-aware glob(s) in ` +
        `eslint.config.cjs are excluded from lint:fast and covered by lint:typed.`,
);
