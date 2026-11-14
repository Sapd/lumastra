// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build the worker-thread plugin-isolation entry into a standalone Node
 * bundle: src/lib/server/tasks/isolation/sandbox-entry.ts → build/sandbox-entry.js
 *
 * Why a separate bundle (not the SvelteKit/adapter-node output): the runner
 * spawns `new Worker(<path>)` and the worker must load identically in BOTH the
 * web and worker containers, which each run `node build` from /app. A
 * pre-built, self-contained `build/sandbox-entry.js` (copied via `build/`)
 * satisfies that without tsx at runtime.
 *
 * Bundling strategy (design §10):
 *   - BUNDLE + transpile first-party TS: `src/**` (incl. `$lib` alias) and the
 *     workspace SDK `@sapd/*` (its package `main` points at `src/index.ts`, so
 *     `node` could not load it un-transpiled — it must be inlined).
 *   - EXTERNALIZE npm dependencies (postgres, valkey-glide, sharp, openai,
 *     bullmq, …) and node builtins — resolved from the image's node_modules at
 *     runtime, exactly like the adapter-node server bundle. This keeps native
 *     addons out of the bundle and the bundle to first-party code.
 */
import * as esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUrlBasePath } from './resolve-url-base-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Handle Vite's `?raw` import suffix (used by `tasks/lua/loader.ts` to inline
 * the Lua state-machine scripts as text). esbuild has no built-in `?raw`
 * loader, so resolve the suffixed path to the real file and load it as text.
 */
const rawTextLoader: esbuild.Plugin = {
    name: 'raw-text',
    setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
            namespace: 'raw-text',
        }));
        build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
            contents: await readFile(args.path, 'utf8'),
            loader: 'text',
        }));
    },
};

/**
 * Externalize bare npm specifiers (and node builtins) while letting esbuild
 * bundle first-party + workspace-TS code. A bare specifier is anything not
 * starting with `.`, `/`, or `$` (the `$lib` alias is rewritten to an absolute
 * path by the `alias` option before this fires). `@sapd/*` workspace packages
 * are TS-source and MUST be bundled, so they are excluded from externalization.
 */
/**
 * Neutralize `config.ts`'s single top-level `await import('./utils/logger.js')`
 * (a startup LiveTV-validation block). It is the ONLY top-level-await root in
 * the bundled graph; esbuild propagates its async module-init to ~200 modules
 * and then DEADLOCKS resolving the config↔logger init ordering in a single
 * bundle (the file's own header warns this circular-TLA shape is tuned for
 * Vite/Rolldown, not a flat bundler). Rewriting just that statement to a
 * synchronous Logger stub makes config sync-init → no async propagation → no
 * deadlock. The stub only drops a startup *warning* the worker doesn't need;
 * all real config reads are plain getters and are untouched.
 */
const stripConfigStartupTla: esbuild.Plugin = {
    name: 'strip-config-startup-tla',
    setup(build) {
        build.onLoad({ filter: /[/\\]server[/\\]config\.ts$/ }, async (args) => {
            let src = await readFile(args.path, 'utf8');
            const needle = "const { Logger } = await import('./utils/logger.js');";
            if (!src.includes(needle)) {
                throw new Error(
                    `build-sandbox: expected top-level-await statement not found in ${args.path}. ` +
                        'config.ts changed — re-verify the worker bundle has no TLA root before updating this needle.',
                );
            }
            src = src.replace(
                needle,
                '// [build-sandbox] TLA stripped for worker bundle (see scripts/build-sandbox.ts)\n' +
                    '    const Logger = { for: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }) };',
            );
            return { contents: src, loader: 'ts' };
        });
    },
};

const externalizeNpm: esbuild.Plugin = {
    name: 'externalize-npm',
    setup(build) {
        build.onResolve({ filter: /^[^./$]/ }, (args) => {
            if (args.path.startsWith('@sapd/')) return null; // bundle workspace TS
            if (args.path === '@sveltejs/kit') return null; // aliased to a stub below
            return { path: args.path, external: true };
        });
    },
};

const outfile = path.join(projectRoot, 'build/sandbox-entry.js');

const result = await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src/lib/server/tasks/isolation/sandbox-entry.ts')],
    outfile,
    bundle: true,
    metafile: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    alias: {
        $lib: path.join(projectRoot, 'src/lib'),
        // @sveltejs/kit is a devDependency (pruned from the production image), so
        // it CANNOT be externalized — a server module in the worker graph imports
        // `json`/`fail` from it. Bundle a functional stub instead. (Caught on the
        // 2026-05-31 preprod soak; now enforced by the prod-import guard below.)
        '@sveltejs/kit': path.join(projectRoot, 'scripts/sandbox-stubs/sveltejs-kit.js'),
        // `$app/paths` is a SvelteKit VIRTUAL module — no package exists to
        // resolve at runtime, so it can be neither externalized nor moved to
        // `dependencies`. It is genuinely in the worker graph: the sandbox runs
        // `loadBuiltins()`, and builtins that emit client-facing payloads build
        // image hrefs via `shared/api-urls.ts`. Stub it with a build-time `base`.
        '$app/paths': path.join(projectRoot, 'scripts/sandbox-stubs/app-paths.js'),
        // `$env/dynamic/private` is reached through config.service's env read;
        // outside SvelteKit that read is process.env anyway.
        '$env/dynamic/private': path.join(
            projectRoot,
            'scripts/sandbox-stubs/env-dynamic-private.js',
        ),
        // $app/environment and $env/dynamic/public reach the graph through credential
        // revocation -> boot/compat-init -> the assistant (dynamic imports, still bundled).
        '$app/environment': path.join(projectRoot, 'scripts/sandbox-stubs/app-environment.js'),
        '$env/dynamic/public': path.join(
            projectRoot,
            'scripts/sandbox-stubs/env-dynamic-public.js',
        ),
    },
    plugins: [stripConfigStartupTla, rawTextLoader, externalizeNpm],
    // `$app/paths`, `$app/environment` and `$env/dynamic/*` (private, public) are
    // aliased to stubs above. Every OTHER SvelteKit virtual module stays externalized
    // on purpose, so a future leak fails the prod-import guard below (loud) instead
    // of silently bundling something that cannot work in a worker thread.
    external: ['$app/stores', '$app/navigation', '$app/forms', '$env/*'],
    // Calls the SAME helper as svelte.config.js:37 (`base: resolveUrlBasePath()`)
    // so the worker bundle and the server bundle can't disagree about `base`.
    // Evaluated at BUILD time — see scripts/resolve-url-base-path.js for why this
    // is no longer a bare `process.env.BASE_PATH` read (that var is overloaded as
    // a filesystem path at runtime; see the warning in
    // scripts/sandbox-stubs/app-paths.js).
    define: {
        __SANDBOX_APP_BASE__: JSON.stringify(resolveUrlBasePath()),
    },
    logLevel: 'warning',
    minify: false,
    sourcemap: true,
});

// ── Production-import guard ──────────────────────────────────────────────────
//
// The bundle externalizes npm packages, resolved from the image's node_modules
// at runtime. But the production image runs `npm prune --production`, so any
// externalized DEV dependency (or SvelteKit virtual) would be MISSING at
// runtime — the worker then dies with "Cannot find package '…'". That failure
// otherwise only surfaces in a clean production environment (it bit the
// 2026-05-31 preprod soak: @sveltejs/kit). This guard reproduces the check at
// build time: every externalized bare import must be a Node builtin or a
// production `dependencies` entry, else the build fails here, locally.
{
    const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
    };
    const prod = new Set(Object.keys(pkg.dependencies ?? {}));
    const builtins = new Set(builtinModules);
    const pkgNameOf = (s: string): string =>
        s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];

    // Authoritative list of externalized imports straight from esbuild's
    // metafile (no comment/string false positives). The output key is the
    // sandbox .js (not the .map).
    const outKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith('sandbox-entry.js'));
    const externals = new Set<string>();
    for (const imp of outKey ? result.metafile.outputs[outKey].imports : []) {
        if (imp.external) externals.add(imp.path);
    }

    const missing = new Set<string>();
    for (const s of externals) {
        if (s.startsWith('.') || s.startsWith('/')) continue; // bundled (shouldn't be external)
        if (s.startsWith('$')) {
            missing.add(s);
            continue;
        } // unstubbed virtual → would fail
        const base = s.replace(/^node:/, '');
        if (s.startsWith('node:') || builtins.has(base)) continue; // Node builtin — always present
        if (!prod.has(pkgNameOf(s))) missing.add(s);
    }
    if (missing.size > 0) {
        throw new Error(
            'build-sandbox: the worker bundle externalizes imports that are NOT production ' +
                'dependencies and would be missing after `npm prune --production`:\n  ' +
                [...missing].join('\n  ') +
                '\nFix: add a stub under scripts/sandbox-stubs/ and alias it (like @sveltejs/kit), ' +
                'or move the package to "dependencies".',
        );
    }
}

console.log('Plugin-isolation sandbox built → build/sandbox-entry.js (prod-import guard passed)');
