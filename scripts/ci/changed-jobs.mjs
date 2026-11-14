#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decides which heavy CI jobs a pull request has to run, from the files it changes.
 * Used by .github/workflows/changes.yml; the rules and their reasons are in
 * docs/dev/ci-change-detection.md.
 *
 * The one principle: a job is skipped only when EVERY changed file is on that job's
 * ignore list. A file nobody listed runs every job, so a new kind of file is safe by
 * default and a mistake in this file can only cost minutes, never hide a failure.
 *
 *   - Pushes, tags and manual runs always run everything (only `pull_request` selects).
 *   - Any trouble working out the change set (no merge commit, git error, empty diff)
 *     runs everything.
 *   - GLOBAL paths (lockfile, configs, workflows, this script, the OpenAPI spec) run
 *     everything, and beat every ignore pattern below.
 *
 * Usage (CI):    node scripts/ci/changed-jobs.mjs        (reads EVENT_NAME, BASE_SHA)
 * Usage (local): git diff --name-status --no-renames origin/main... \
 *                  | node scripts/ci/changed-jobs.mjs --stdin --event pull_request
 * It writes `<job>=true|false` lines to $GITHUB_OUTPUT (stdout when unset) and a table
 * to $GITHUB_STEP_SUMMARY.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/** Every job the selection controls. The names are the `changes.yml` outputs. */
export const JOB_NAMES = [
    'eslint',
    'typecheck',
    'svelte_types',
    'unit',
    'other_suites',
    'integration',
    'jellyfin',
];

/** Turn a glob (`**` any depth, `*` within a segment, `?` one character, `{a,b}`) into a RegExp. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` also matches zero directories; a trailing `**` matches the rest.
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            const end = glob.indexOf('}', i);
            const options = glob
                .slice(i + 1, end)
                .split(',')
                .map((o) => o.replace(/[.+^$()|[\]\\]/g, '\\$&'));
            re += `(?:${options.join('|')})`;
            i = end;
        } else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

const regexCache = new Map();
/** True when `path` matches any glob in `globs`. */
export function matchesAny(path, globs) {
    for (const glob of globs) {
        let re = regexCache.get(glob);
        if (!re) {
            re = globToRegExp(glob);
            regexCache.set(glob, re);
        }
        if (re.test(path)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------------------
// Rules. Each rule is { glob: [...], except?: [...], status?: ['M'] }. `status` limits the
// rule to those git statuses (A added, M modified, D deleted; renames are reported as D + A).
// ---------------------------------------------------------------------------------------

/** Run everything. Inputs of every job: dependencies, toolchain, build/test config, CI itself. */
export const GLOBAL = [
    'package.json',
    'package-lock.json',
    'packages/**/package.json',
    '.npmrc',
    '.nvmrc',
    '.node-version',
    '.node-min-version',
    '.tool-versions',
    'tsconfig*.json',
    'tsconfig/*.json',
    'vite*.ts',
    'vitest*.ts',
    'tests/vitest/*.ts',
    'svelte.config.*',
    'eslint.config.*',
    'tailwind.config.*',
    'postcss.config.*',
    'project.inlang/**',
    '.github/workflows/**',
    '.github/actions/**',
    'scripts/ci/**',
    // The OpenAPI spec generates src/lib/api/schema.d.ts for typecheck, ESLint and the
    // components, and tests read the guide next to it.
    'docs/api/**',
];

/**
 * Documentation files some test or script reads. They are NOT inert for the unit suite
 * (which reads them) and stay inert for jobs that never open them.
 */
const DOC_INPUTS = [
    'docs/architecture/user-events.md', // src/lib/server/api/event-kinds.test.ts
    'docs/examples/**', // tests/native-conformance/task-runtime/deployment-topology.test.mjs
];

/** Inert for every job: prose nothing executes, reads or lints. */
const INERT = [
    { glob: ['docs/**'], except: [...DOC_INPUTS, 'docs/api/**'] },
    { glob: ['CHANGELOG.md', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'TRADEMARKS.md', 'LICENSE'] },
    // Not `*.md` in general: tests read some markdown (plugins/lumastra-skills/**, docs/api/**).
    { glob: ['{scripts,src,tests,native,deploy,workers}/**/{README,CLAUDE,AGENTS}.md'] },
    {
        glob: [
            '.github/*.md',
            '.github/ISSUE_TEMPLATE/**',
            '.github/DISCUSSION_TEMPLATE/**',
            '.github/FUNDING.yml',
            '.github/CODEOWNERS',
            '.github/dependabot.yml',
            '.github/labeler.yml',
            '.github/labels.yml',
            '.github/release.yml',
        ],
    },
    { glob: ['.vscode/**', '.editorconfig'] },
];

/** Not JavaScript/TypeScript: nothing ESLint, tsgo or svelte-check opens. */
const NON_JS_TREES = [
    'native/**',
    'workers/**',
    'deploy/**',
    'Dockerfile',
    '.dockerignore',
    'docker-compose*.yml',
    'static/**',
    '**/*.css',
];

/** Per-job extra ignore rules, on top of GLOBAL (never ignorable) and INERT. */
const EXTRA_IGNORES = {
    // ESLint, the tier/licence/copy checks and the callback-safety rule tests read src/,
    // scripts/, tests/ and messages/ (typed pass resolves paraglide; lint:copy reads the
    // message files). Docs inputs are read by unit tests only.
    eslint: [{ glob: [...NON_JS_TREES, ...DOC_INPUTS] }],

    // tsgo skips .svelte on purpose, so editing a component cannot change its result. Adding,
    // deleting or renaming one can: the route list feeds SvelteKit's generated `$app/types`.
    typecheck: [
        { glob: [...NON_JS_TREES, ...DOC_INPUTS] },
        { glob: ['**/*.svelte'], status: ['M'] },
    ],

    // svelte-check types components against the TS they import and the generated modules.
    svelte_types: [{ glob: [...NON_JS_TREES, ...DOC_INPUTS] }],

    // The unit suite also scans the tree (guard tests read .svelte, deploy/, docs, native
    // contracts, workers scripts), so only INERT paths skip it.
    unit: [],

    // Component, stream-proxy (livetv-proxy) and plugin-SDK suites. Python workers, deploy
    // manifests and the two Rust crates the proxy suite does not build are not inputs.
    other_suites: [
        {
            glob: [
                'workers/**',
                'deploy/**',
                'Dockerfile',
                '.dockerignore',
                'docker-compose*.yml',
                'native/watcher/**',
                'native/task-queue/**',
            ],
        },
    ],

    // PostgreSQL/Valkey suite. Nothing it imports is a .svelte file or a CSS file (checked:
    // no integration test and no server module imports one), it opens no docs, and test
    // files are never imported by other files.
    integration: [
        {
            glob: [
                'docs/**',
                'workers/**',
                'deploy/**',
                'Dockerfile',
                '.dockerignore',
                'docker-compose*.yml',
                'native/watcher/**',
                'native/task-queue/**',
                '**/*.svelte',
                '**/*.css',
                // Unit tests and Playwright specs; the integration suite is the
                // *.integration.test.* / *-integration.test.* files only.
                '**/*.test.{ts,js,mjs}',
                '**/*.spec.ts',
            ],
            except: ['docs/api/**', '**/*.integration.test.*', '**/*-integration.test.*'],
        },
    ],
};

/**
 * The Jellyfin client contract job is the exception: it is a positive list. It runs only
 * when /j-shaping code (the paths the workflow always listed) or a GLOBAL input changes,
 * because it takes ~30 minutes and nothing else can change what the /j handlers return.
 */
export const JELLYFIN_PATHS = [
    'src/routes/(modules)/j/**',
    'src/lib/server/jellyfin-compat/**',
    'src/lib/server/utils/external-subtitle-index.ts',
    'src/lib/server/utils/media-stream-mapper.ts',
    'src/lib/server/database/queries/media-streams.queries.ts',
    'src/lib/server/database/queries/external-subtitles.queries.ts',
    'src/lib/server/compat/jellyfin-response-observer.ts',
    'tests/jellyfin-contract/**',
    // The job migrates a real database before decoding; a schema change reaches the DTOs.
    'src/lib/server/database/migrations/**',
    'tests/integration/setup/**',
];

function ruleMatches(rule, change) {
    if (rule.status && !rule.status.includes(change.status)) return false;
    if (!matchesAny(change.path, rule.glob)) return false;
    return !(rule.except && matchesAny(change.path, rule.except));
}

/** Why a single changed file does NOT force `job` to run, or null when it does. */
function ignoredBy(job, change) {
    if (matchesAny(change.path, GLOBAL)) return null;
    if (INERT.some((rule) => ruleMatches(rule, change))) return 'inert';
    if ((EXTRA_IGNORES[job] ?? []).some((rule) => ruleMatches(rule, change))) return 'ignored';
    return null;
}

/**
 * @param {{status: string, path: string}[]} changes
 * @returns {{ jobs: Record<string, boolean>, triggers: Record<string, string[]> }}
 *   `triggers[job]` lists up to 5 files that made the job run.
 */
export function selectJobs(changes) {
    const jobs = {};
    const triggers = {};
    for (const job of JOB_NAMES) {
        const trigger = [];
        for (const change of changes) {
            const forced =
                job === 'jellyfin'
                    ? matchesAny(change.path, [...GLOBAL, ...JELLYFIN_PATHS])
                    : ignoredBy(job, change) === null;
            if (forced) trigger.push(change.path);
        }
        jobs[job] = trigger.length > 0;
        triggers[job] = trigger.slice(0, 5);
    }
    return { jobs, triggers };
}

/** Everything on, with the reason. */
export function runEverything(reason) {
    return {
        jobs: Object.fromEntries(JOB_NAMES.map((job) => [job, true])),
        triggers: Object.fromEntries(JOB_NAMES.map((job) => [job, [reason]])),
    };
}

/** Parse `git diff --name-status --no-renames` output (`M\tpath`). */
export function parseNameStatus(text) {
    const changes = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const tab = line.indexOf('\t');
        if (tab === -1) return null; // not the format we expect: let the caller run everything
        changes.push({ status: line.slice(0, tab).trim()[0], path: line.slice(tab + 1).trim() });
    }
    return changes;
}

/** The decision for one event: only pull requests with a readable change set select. */
export function decide({ eventName, changes }) {
    if (eventName !== 'pull_request') return runEverything(`${eventName || 'unknown'} event`);
    if (!changes || changes.length === 0) return runEverything('change set unavailable or empty');
    return selectJobs(changes);
}

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The pull request's own changes: CI checks out the merge commit of base and head, so the
 * diff against its first parent is exactly what the pull request adds.
 */
function changesFromGit(baseSha) {
    let base = null;
    try {
        git(['rev-parse', '--verify', '--quiet', 'HEAD^2']);
        base = 'HEAD^1';
    } catch {
        if (baseSha) {
            try {
                git(['cat-file', '-e', `${baseSha}^{commit}`]);
                base = baseSha;
            } catch {
                // fall through
            }
        }
    }
    if (!base) return null;
    return parseNameStatus(git(['diff', '--name-status', '--no-renames', base, 'HEAD']));
}

function emit(result, eventName) {
    const lines = JOB_NAMES.map((job) => `${job}=${result.jobs[job]}`);
    const target = process.env.GITHUB_OUTPUT;
    if (target) appendFileSync(target, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));

    const summary = [
        `### Which jobs this ${eventName || 'run'} runs`,
        '',
        '| Job | Runs | Because of |',
        '| --- | --- | --- |',
        ...JOB_NAMES.map((job) => {
            const because =
                result.triggers[job].map((p) => `\`${p}\``).join(', ') ||
                'no changed file needs it';
            return `| ${job} | ${result.jobs[job] ? 'yes' : 'skipped'} | ${because} |`;
        }),
        '',
    ].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    else console.error(summary);
}

function main(argv) {
    const arg = (name) => {
        const i = argv.indexOf(name);
        return i === -1 ? undefined : argv[i + 1];
    };
    const eventName = arg('--event') ?? process.env.EVENT_NAME ?? '';
    let changes = null;
    try {
        if (eventName === 'pull_request') {
            if (argv.includes('--stdin')) {
                changes = parseNameStatus(readFileSync(0, 'utf8'));
                const strip = arg('--strip-prefix');
                if (changes && strip) {
                    changes = changes
                        .filter((c) => c.path.startsWith(strip))
                        .map((c) => ({ ...c, path: c.path.slice(strip.length) }));
                }
            } else {
                changes = changesFromGit(process.env.BASE_SHA);
            }
        }
    } catch (error) {
        console.error(
            `::warning::Could not read the change set (${error.message}); running every job.`,
        );
        changes = null;
    }
    emit(decide({ eventName, changes }), eventName);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
