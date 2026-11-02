// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Standalone task host. Runs after Vite (which empties build/).
 * Production dependencies stay external; first-party and workspace code bundle.
 * Optional licensing registration and URL base must match the web build.
 */
import * as esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile, glob } from 'node:fs/promises';
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
 * synchronous startup logger makes config sync-init with no async propagation.
 * Config-only validation warnings are retained; real logging uses Logger after
 * module initialization. All config getters and validation remain unchanged.
 */
const stripConfigStartupTla: esbuild.Plugin = {
    name: 'strip-config-startup-tla',
    setup(build) {
        build.onLoad({ filter: /[/\\]server[/\\]config\.ts$/ }, async (args) => {
            let src = await readFile(args.path, 'utf8');
            const needle = "const { Logger } = await import('./utils/logger.js');";
            if (!src.includes(needle)) {
                throw new Error(
                    `build-task-runtime: expected top-level-await statement not found in ${args.path}. ` +
                        'config.ts changed — re-verify the worker bundle has no TLA root before updating this needle.',
                );
            }
            src = src.replace(
                needle,
                '// [build-task-runtime] TLA stripped for worker bundle (see scripts/build-task-runtime.ts)\n' +
                    '    const Logger = { for: () => ({ warn: (message) => console.warn("[Config]", message) }) };',
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

// Expand literal lazy globs from their original modules, preserving registry
// registration and optional-tree behavior without adding protected imports to
// this core build script. Unsupported signatures fail instead of being erased.
const runtimeGlobs: esbuild.Plugin = {
    name: 'task-runtime-globs',
    setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            let source = await readFile(args.path, 'utf8');
            if (!/import\.meta\.glob\s*\(/.test(source)) return undefined;
            const matches = [...source.matchAll(/import\.meta\.glob\(\s*(['"])([^'"]+)\1\s*\)/g)];
            for (const match of matches) {
                const pattern = match[2];
                const absolutePattern = pattern.startsWith('/')
                    ? path.join(projectRoot, pattern.slice(1))
                    : path.resolve(path.dirname(args.path), pattern);
                const files: string[] = [];
                for await (const file of glob(absolutePattern)) files.push(file);
                const entries = files.sort().map((file) => {
                    const relative = path.relative(projectRoot, file);
                    if (relative.startsWith('..') || path.isAbsolute(relative))
                        throw new Error('Task runtime glob escapes project');
                    const key = pattern.startsWith('/')
                        ? '/' + relative.split(path.sep).join('/')
                        : './' +
                          path.relative(path.dirname(args.path), file).split(path.sep).join('/');
                    return `${JSON.stringify(key)}: () => import(${JSON.stringify(file)})`;
                });
                source = source.replace(match[0], `({${entries.join(',')}})`);
            }
            if (/import\.meta\.glob\s*\(/.test(source))
                throw new Error(`Unsupported task runtime glob in ${args.path}`);
            return { contents: source, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
        });
    },
};

const outdir = path.join(projectRoot, 'build');

const result = await esbuild.build({
    entryPoints: {
        'task-runtime': path.join(projectRoot, 'src/task-runtime/index.ts'),
        'task-executor': path.join(projectRoot, 'src/task-runtime/executor-child.ts'),
        'task-executor-guardian': path.join(projectRoot, 'src/task-runtime/executor-guardian.ts'),
    },
    outdir,
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
        '$app/paths': path.join(projectRoot, 'scripts/task-runtime-stubs/app-paths.js'),
        '$app/environment': path.join(projectRoot, 'scripts/task-runtime-stubs/app-environment.js'),
        '$env/dynamic/private': path.join(projectRoot, 'scripts/task-runtime-stubs/env-private.js'),
        '$env/dynamic/public': path.join(projectRoot, 'scripts/task-runtime-stubs/env-public.js'),
    },
    plugins: [runtimeGlobs, stripConfigStartupTla, rawTextLoader, externalizeNpm],
    // `$app/paths` is aliased to a stub above. Every OTHER SvelteKit virtual
    // module stays externalized on purpose, so a future leak fails the
    // prod-import guard below (loud) instead of silently bundling something
    // that cannot work in a standalone task process.
    external: ['$app/stores', '$app/navigation', '$app/forms', '$env/*'],
    // Calls the SAME helper as svelte.config.js:37 (`base: resolveUrlBasePath()`)
    // so the worker bundle and the server bundle can't disagree about `base`.
    // Evaluated at BUILD time — see scripts/resolve-url-base-path.js for why this
    // is no longer a bare `process.env.BASE_PATH` read (that var is overloaded as
    // a filesystem path at runtime; see the warning in
    // scripts/sandbox-stubs/app-paths.js).
    define: {
        __SANDBOX_APP_BASE__: JSON.stringify(resolveUrlBasePath()),
        'import.meta.env.LUMASTRA_IMAGE_BUILD_TIME': JSON.stringify(
            process.env.APP_BUILD_TIME ?? new Date().toISOString(),
        ),
        __API_CONTRACT_STRICT__: 'false',
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
    const externals = new Set<string>();
    for (const output of Object.values(result.metafile.outputs)) {
        for (const imp of output.imports) {
            if (imp.external) externals.add(imp.path);
        }
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
            'build-task-runtime: the worker bundle externalizes imports that are NOT production ' +
                'dependencies and would be missing after `npm prune --production`:\n  ' +
                [...missing].join('\n  ') +
                '\nFix: add a stub under scripts/task-runtime-stubs/ and alias it (like @sveltejs/kit), ' +
                'or move the package to "dependencies".',
        );
    }
}

// Preserve an inspectable graph: no server hook or request handler may enter.
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((name) =>
    /(?:^|\/)src\/(?:hooks\.server|routes\/|app\.html)/.test(name),
);
if (forbidden.length > 0)
    throw new Error(`Task runtime includes web handlers: ${forbidden.join(', ')}`);
await (
    await import('node:fs/promises')
).writeFile(
    path.join(projectRoot, 'build/task-runtime.meta.json'),
    JSON.stringify(result.metafile, null, 2),
);
console.log(
    `Task hosts built → build/task-runtime.js + build/task-executor.js + build/task-executor-guardian.js (${inputs.length} inputs; production imports verified; no web handler)`,
);
