// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Table-driven tests for the CI job selection (scripts/ci/changed-jobs.mjs).
 *
 * Each row lists the files a pull request changes and the jobs that MUST run. Every job not
 * listed must be skipped, so a row documents the whole decision. Rows marked `all` are the
 * safety cases: anything unknown, global or ambiguous has to run everything.
 *
 * Run: npx vitest run scripts/ci/changed-jobs.test.js
 */

import { describe, it, expect } from 'vitest';

import { JOB_NAMES, decide, globToRegExp, parseNameStatus, selectJobs } from './changed-jobs.mjs';

const ALL = [...JOB_NAMES];
const CODE = ['eslint', 'typecheck', 'svelte_types', 'unit', 'other_suites', 'integration'];

/** `M:path` / `A:path` / `D:path`; a bare path means modified. */
function changes(...specs) {
    return specs.map((spec) => {
        const m = /^([AMD]):(.*)$/.exec(spec);
        return m ? { status: m[1], path: m[2] } : { status: 'M', path: spec };
    });
}

const rows = [
    // --- nothing executable changed -------------------------------------------------------
    ['docs prose only', ['docs/dev/testing-traps.md', 'docs/security/master-key-rotation.md'], []],
    ['docs screenshot', ['A:docs/assets/screenshots/new.png'], []],
    ['root markdown only', ['README.md', 'CHANGELOG.md', 'AGENTS.md'], []],
    ['nested README', ['scripts/typecheck/README.md', 'native/watcher/README.md'], []],
    [
        'issue templates + contributing',
        ['.github/ISSUE_TEMPLATE/bug.yml', '.github/CONTRIBUTING.md'],
        [],
    ],

    // --- docs that something reads --------------------------------------------------------
    [
        'user-events doc is read by a unit test',
        ['docs/architecture/user-events.md'],
        ['unit', 'other_suites'],
    ],
    [
        'docs/examples is read by a native test',
        ['docs/examples/oidc-sso-dex/docker-compose.yml'],
        ['unit', 'other_suites'],
    ],
    ['OpenAPI spec feeds generated types', ['docs/api/openapi.yaml'], ALL],
    ['API guide is read by tests', ['docs/api/API.md'], ALL],

    // --- front end ------------------------------------------------------------------------
    [
        'edit a component',
        ['src/lib/components/player/Controls.svelte'],
        ['eslint', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'edit a route page and a stylesheet',
        ['src/routes/admin/+page.svelte', 'src/app.css'],
        ['eslint', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'add a route page: the route list changes the generated types',
        ['A:src/routes/admin/new/+page.svelte'],
        ['eslint', 'typecheck', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'delete a component',
        ['D:src/lib/components/Old.svelte'],
        ['eslint', 'typecheck', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'a rune module is TypeScript, not a component',
        ['src/lib/stores/watchTogether.svelte.ts'],
        CODE,
    ],

    // --- server and shared code -----------------------------------------------------------
    ['server service', ['src/lib/server/services/foo.service.ts'], CODE],
    ['database query', ['src/lib/server/database/queries/media.queries.ts'], CODE],
    [
        'a migration also reaches the Jellyfin contract job',
        ['src/lib/server/database/migrations/16.500.0-x.ts'],
        ALL,
    ],
    ['api route handler', ['src/routes/api/v1/foo/+server.ts'], CODE],
    ['unknown top-level file runs everything it could affect', ['something-new.bin'], CODE],

    // --- tests only -----------------------------------------------------------------------
    [
        'unit test only: integration suite never imports it',
        ['src/lib/server/services/foo.service.test.ts'],
        ['eslint', 'typecheck', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'integration test only: still linted, typechecked and scanned by guards',
        ['src/lib/server/services/foo.integration.test.ts'],
        CODE,
    ],
    [
        'playwright spec only',
        ['tests/admin-users.api.spec.ts'],
        ['eslint', 'typecheck', 'svelte_types', 'unit', 'other_suites'],
    ],
    [
        'hyphenated integration test is an integration file',
        ['tests/integration/foo-integration.test.ts'],
        CODE,
    ],
    [
        'integration setup is not a test file',
        ['tests/integration/setup/vitest.setup.ts', 'tests/integration/setup/global-setup.ts'],
        ALL,
    ],

    // --- translations ---------------------------------------------------------------------
    [
        'messages: paraglide types, copy check, parity tests, server strings',
        ['messages/de.json'],
        CODE,
    ],

    // --- non-JS trees ---------------------------------------------------------------------
    ['python worker', ['workers/sonic-embedder/embed.py'], ['unit']],
    ['k8s manifests are read by unit tests', ['deploy/k8s/base/deployment.yaml'], ['unit']],
    ['Dockerfile', ['Dockerfile'], ['unit']],
    [
        'livetv proxy crate',
        ['native/livetv-proxy/src/main.rs'],
        ['unit', 'other_suites', 'integration'],
    ],
    ['watcher crate', ['native/watcher/src/main.rs'], ['unit']],
    ['static assets', ['static/favicon.png'], ['unit', 'other_suites', 'integration']],

    // --- jellyfin contract (positive list) ------------------------------------------------
    ['jellyfin handler', ['src/routes/(proprietary)/j/Items/+server.ts'], CODE.concat('jellyfin')],
    [
        'jellyfin contract tests',
        ['tests/jellyfin-contract/kotlin/build.gradle.kts'],
        ['jellyfin', 'unit', 'other_suites', 'integration', 'eslint', 'typecheck', 'svelte_types'],
    ],

    // --- global inputs --------------------------------------------------------------------
    ['lockfile', ['package-lock.json'], ALL],
    ['package.json', ['package.json'], ALL],
    ['workspace package manifest', ['packages/@sapd/lumastra-plugin-sdk/package.json'], ALL],
    ['tsconfig variant', ['tsconfig.typecheck.src.json'], ALL],
    ['vitest config', ['vitest.integration.config.ts'], ALL],
    ['vite config', ['vite.config.ts'], ALL],
    ['eslint config', ['eslint.config.cjs'], ALL],
    ['svelte config', ['svelte.config.js'], ALL],
    ['workflow', ['.github/workflows/test.yml'], ALL],
    ['this selector', ['scripts/ci/changed-jobs.mjs'], ALL],
    ['paraglide project', ['project.inlang/settings.json'], ALL],

    // --- mixed: one real change beats any amount of prose ---------------------------------
    [
        'docs plus a service',
        ['docs/dev/testing-traps.md', 'src/lib/server/services/foo.service.ts'],
        CODE,
    ],
    ['docs plus a lockfile', ['README.md', 'package-lock.json'], ALL],
    [
        'component plus deploy manifest',
        ['src/lib/components/A.svelte', 'deploy/k8s/x.yaml'],
        ['eslint', 'svelte_types', 'unit', 'other_suites'],
    ],
];

describe('selectJobs', () => {
    it.each(rows)('%s', (_name, files, mustRun) => {
        const { jobs } = selectJobs(changes(...files));
        const ran = JOB_NAMES.filter((job) => jobs[job]);
        expect(ran.sort()).toEqual([...new Set(mustRun)].sort());
    });

    it('lists why a job runs', () => {
        const { triggers } = selectJobs(changes('src/lib/server/a.ts', 'docs/x.md'));
        expect(triggers.integration).toEqual(['src/lib/server/a.ts']);
        expect(triggers.jellyfin).toEqual([]);
    });
});

describe('decide', () => {
    const docsOnly = changes('docs/dev/testing-traps.md');

    it('only pull requests select', () => {
        for (const eventName of ['push', 'workflow_dispatch', 'schedule', '']) {
            const { jobs } = decide({ eventName, changes: docsOnly });
            expect(JOB_NAMES.every((job) => jobs[job])).toBe(true);
        }
    });

    it('a pull request with an unreadable or empty change set runs everything', () => {
        for (const value of [null, undefined, []]) {
            const { jobs } = decide({ eventName: 'pull_request', changes: value });
            expect(JOB_NAMES.every((job) => jobs[job])).toBe(true);
        }
    });

    it('a docs-only pull request skips every selected job', () => {
        const { jobs } = decide({ eventName: 'pull_request', changes: docsOnly });
        expect(JOB_NAMES.some((job) => jobs[job])).toBe(false);
    });
});

describe('parseNameStatus', () => {
    it('reads git --name-status lines', () => {
        expect(parseNameStatus('M\ta/b.ts\nA\tc d.svelte\nD\te.md\n')).toEqual([
            { status: 'M', path: 'a/b.ts' },
            { status: 'A', path: 'c d.svelte' },
            { status: 'D', path: 'e.md' },
        ]);
    });

    it('refuses output that is not name-status, so the caller runs everything', () => {
        expect(parseNameStatus('just a path\n')).toBeNull();
    });
});

describe('globToRegExp', () => {
    it.each([
        ['docs/**', 'docs/a/b.md', true],
        ['docs/**', 'docs', false],
        ['**/*.svelte', 'a.svelte', true],
        ['**/*.svelte', 'src/a/b.svelte', true],
        ['**/*.svelte', 'src/a/b.svelte.ts', false],
        ['*.md', 'a/b.md', false],
        ['tsconfig*.json', 'tsconfig.typecheck.src.json', true],
        ['**/*.test.{ts,js}', 'src/x.test.js', true],
        ['**/*.test.{ts,js}', 'src/x.test.mjs', false],
        ['src/routes/(proprietary)/j/**', 'src/routes/(proprietary)/j/a/+server.ts', true],
        ['{scripts,src}/**/README.md', 'src/a/README.md', true],
        ['{scripts,src}/**/README.md', 'docs/README.md', false],
    ])('%s vs %s', (glob, path, expected) => {
        expect(globToRegExp(glob).test(path)).toBe(expected);
    });
});
