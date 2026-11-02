// Load .env into process.env — MUST be the first import so it lands before
// anything reads the environment.
//
// config.ts reads `{...process.env}` directly (not $env/dynamic/private, which
// deadlocks under Rolldown — see the comment there). Vite does NOT put .env
// keys into process.env: it exposes them via import.meta.env and SvelteKit's
// $env/* modules only. So without this, every .env value is invisible to the
// server at dev time and hooks.server.ts aborts the boot with
// "FATAL: Required configuration missing [DATABASE_URL, CACHE_URL]" on the
// first request — despite a perfectly good .env sitting right there.
//
// Same process-sharing rationale as the build-info injection below. Harmless
// in Docker/CI: there is no .env there, dotenv silently no-ops, and it never
// overwrites a variable that is already set, so real env always wins.
import 'dotenv/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { Logger, Plugin, ResolvedConfig } from 'vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Build identity (version + commit + build time) for the running app.
//
// Resolution order is env → git → package.json (see deriveBuildInfo):
//   - Prod/container: CI passes APP_VERSION/APP_COMMIT/... as Docker build-args
//     → ENV, read at RUNTIME by config.ts (`{...process.env}`).
//   - Dev/local: no such env, so we run `git describe` here at config-load and
//     inject the result into process.env (below). vite.config runs in the same
//     Node process as the dev SSR, so config.ts picks it up. This is why
//     `npm run dev` shows the real git version, not package.json's 0.0.0.
//
// NOTE: this is NOT a build-time `define` bake. config.ts reads process.env at
// runtime; nothing references the literal `process.env.APP_VERSION`, so the old
// `define` for it was dead and has been removed.
import { execSync } from 'node:child_process';
import { deriveBuildInfo } from './src/lib/server/build-info';
import { diagnosticRouteWords } from './vite.diagnostic-route-words';

const __here = dirname(fileURLToPath(import.meta.url));

const __pkgVersion: string = (() => {
    try {
        const pkg = JSON.parse(readFileSync(resolve(__here, 'package.json'), 'utf8')) as {
            version?: string;
        };
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
})();

const __runGit = (args: string): string => {
    try {
        return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return '';
    }
};

// Populate process.env for dev/local runs (?? so a real env/build-arg always wins).
const __buildInfo = deriveBuildInfo({
    env: process.env,
    runGit: __runGit,
    pkgVersion: __pkgVersion,
    now: new Date().toISOString(),
});
process.env.APP_VERSION ??= __buildInfo.version;
process.env.APP_COMMIT ??= __buildInfo.commit;
process.env.APP_COMMIT_SHORT ??= __buildInfo.commitShort;
process.env.APP_BUILD_TIME ??= __buildInfo.buildTime;
process.env.APP_BRANCH ??= __buildInfo.branch;

const suppressBuildWarnings = (): Plugin => ({
    name: 'suppress-build-warnings',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
        const originalWarn = config.logger.warn.bind(config.logger);
        config.logger.warn = (
            message: Parameters<Logger['warn']>[0],
            options?: Parameters<Logger['warn']>[1],
        ) => {
            const text =
                typeof message === 'string'
                    ? message
                    : typeof message === 'object' &&
                        message !== null &&
                        'message' in message &&
                        typeof (message as { message?: unknown }).message === 'string'
                      ? ((message as { message?: string }).message ?? '')
                      : '';

            if (text.includes("new URL('.', import.meta.url)")) {
                return;
            }

            originalWarn(message, options);
        };
    },
});

const patchLibbitsubWasmUrl = (): Plugin => ({
    name: 'patch-libbitsub-wasm-url',
    apply: 'build',
    enforce: 'pre',
    transform(code: string, id: string) {
        if (!id.includes('libbitsub') || !id.endsWith('dist/ts/wasm.js')) {
            return null;
        }

        const updated = code.replace(
            "new URL('.', import.meta.url)",
            "new URL(/* @vite-ignore */ '.', import.meta.url)",
        );

        if (updated === code) {
            return null;
        }

        return { code: updated, map: null };
    },
});

export default defineConfig(({ mode }) => ({
    define: {
        // Literal route segments: the only path words web diagnostics may send.
        __DIAGNOSTIC_ROUTE_WORDS__: JSON.stringify(diagnosticRouteWords(__here)),
        __API_CONTRACT_STRICT__:
            mode === 'development' ||
            !!process.env.VITEST ||
            process.env.API_CONTRACT_STRICT === '1',
        // The image build time, baked into the bundle as a literal. The license
        // service anchors its no-key grace window to it
        // (proprietary/licensing/license.service.ts IMAGE_BUILD_TIME_MS), so it
        // must NOT be a runtime env read — `docker run -e APP_BUILD_TIME=…` would
        // reopen the window. `__buildInfo.buildTime` is the CI build-arg, or the
        // build's own clock for a hand-run build (never empty).
        'import.meta.env.LUMASTRA_IMAGE_BUILD_TIME': JSON.stringify(__buildInfo.buildTime),
    },
    plugins: [
        suppressBuildWarnings(),
        patchLibbitsubWasmUrl(),
        tailwindcss(),
        sveltekit(),
        paraglideVitePlugin({
            project: './project.inlang',
            outdir: './src/lib/paraglide',
            // 'preferredLanguage' (Accept-Language) sits BETWEEN cookie and
            // baseLocale so an explicit in-app language switch still wins, while
            // a cookie-less visitor gets their browser's language instead of
            // always-English. Required so UI chrome cannot render English over
            // header-negotiated German metadata.
            // SYNC REQUIRED: package.json's "paraglide:compile" script must
            // declare the same --strategy. If you change this, update the script.
            strategy: ['cookie', 'preferredLanguage', 'baseLocale'],
        }),
    ],
    assetsInclude: ['**/*.wasm'],
    optimizeDeps: {
        exclude: ['libbitsub', 'akarisub'],
    },
    ssr: {
        noExternal: ['chart.js', 'chartjs-adapter-date-fns', 'date-fns'],
        // Externalize server-only dependencies (prevents bundling into SSR build)
        external: [
            // Queue system
            'bullmq',
            'ioredis',
            '@valkey/valkey-glide',
            'msgpackr',
            // Database
            'postgres',
            // Image processing (native bindings)
            'sharp',
            // AI/ML clients
            'openai',
            'voyageai',
            // Monitoring
            'prom-client',
            // HTTP clients (server-side only)
            'undici',
            // Config
            'dotenv',
            'yaml',
        ],
    },
    worker: {
        format: 'es',
    },
    build: {
        sourcemap: process.env.SOURCEMAP === 'true',
        // Reduce chunk analysis overhead
        reportCompressedSize: false,
        // Target modern browsers for faster builds
        target: 'es2022',
        rolldownOptions: {
            checks: {
                pluginTimings: false,
            },
            onwarn(warning, warn) {
                if (
                    typeof warning.message === 'string' &&
                    warning.message.includes("new URL('.', import.meta.url)")
                ) {
                    return;
                }
                warn(warning);
            },
            output: {
                // Chunk control for long-term caching.
                //
                // Rolldown deprecated `manualChunks` in favour of
                // `codeSplitting.groups`; if both are set, `manualChunks` is
                // ignored outright. This is the supported form.
                //
                // Only group libraries that are genuinely OFF the first-paint
                // path. A group is all-or-nothing: if ANY module in it is
                // statically reachable from the root layout, the WHOLE group
                // becomes a critical-path download. The previous config learned
                // this the hard way — a blanket `vendor` bucket plus an `icons`
                // bucket put 100 svelte-hero-icons modules and every other
                // node_modules package on the layout's critical path, when only
                // 2 icon modules were actually used. Letting Rolldown split
                // those automatically cut the layout entry from 464 KB to
                // 393 KB brotli. Do not re-add a catch-all `vendor` group, and
                // do not group `akarisub`/`libbitsub` (measured: +51 KB brotli
                // on the critical path, because one module of it is statically
                // reachable and the group drags in the other 30).
                //
                // chart.js + its date adapter + date-fns must stay in ONE group
                // to avoid a cross-chunk circular import.
                codeSplitting: {
                    groups: [
                        // The static catalog and deferred watch chrome share these
                        // modules with the root. Keep those already-mandatory
                        // dependencies together: splitting the shell otherwise
                        // adds many small requests to cold catalog hydration.
                        // Do not include the app-shell entry or optional chrome here.
                        {
                            name: 'shell-shared',
                            priority: 20,
                            test: (id: string): boolean => {
                                const normalized = id.replaceAll('\\', '/');
                                return [
                                    'stores/manual-runs.svelte.ts',
                                    'stores/modal-loading.store.ts',
                                    'schemas/api-image-descriptor.ts',
                                    'utils/external-ids.ts',
                                    'utils/music-bottom-nav.ts',
                                    'components/players/bounded-retry-loader.svelte.ts',
                                    'components/app-shell/available.ts',
                                    'components/ui/ToastContainer.svelte',
                                    'paraglide/messages/error_default.js',
                                    'paraglide/messages/retry.js',
                                ].some((path) => normalized.endsWith(`/src/lib/${path}`));
                            },
                        },
                        { name: 'hls', test: /node_modules[\\/]hls\.js[\\/]/, priority: 30 },
                        {
                            name: 'charts',
                            test: /node_modules[\\/](chart\.js|chartjs-adapter-date-fns|date-fns)[\\/]/,
                            priority: 30,
                        },
                    ],
                },
            },
        },
        chunkSizeWarningLimit: 1500,
    },
    server: {
        fs: {
            // Allow serving files from static directory
            allow: ['..'],
        },
        watch: {
            // Exclude scripts, tests, and docs from triggering live reload
            ignored: ['**/scripts/**', '**/tests/**', '**/docs/**', '**/config/settings.json'],
        },
    },
}));
