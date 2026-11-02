import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { importAssets } from 'svelte-preprocess-import-assets';
import { resolveUrlBasePath } from './scripts/resolve-url-base-path.js';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    // Consult https://kit.svelte.dev/docs/integrations#preprocessors
    // for more information about preprocessors
    preprocess: [importAssets(), vitePreprocess()],

    kit: {
        // adapter-auto only supports some environments, see https://kit.svelte.dev/docs/adapter-auto for a list.
        // If your environment is not supported or you settled on a specific environment, switch out the adapter.
        // See https://kit.svelte.dev/docs/adapters for more information about adapters.
        adapter: adapter(),
        csrf: {
            // SvelteKit's option compiler disables the built-in origin check
            // entirely when trustedOrigins includes '*'
            // (csrf_check_origin = checkOrigin && !trustedOrigins.includes('*')).
            // We keep it disabled here ON PURPOSE and re-implement a *scoped*
            // equivalent in src/lib/server/middleware/csrf.ts (wired first in the
            // hooks.server.ts sequence).
            //
            // Why not the built-in: native login adds a session COOKIE, so every
            // mutating route is now CSRF-able and the origin check must apply
            // broadly — but a few self-authenticating surfaces legitimately
            // receive cross-origin form POSTs (Jellyfin `/j/*` QuickConnect,
            // OpenSubsonic `/subsonic/*`, OAuth `/oauth/*` device flow). The
            // built-in is all-or-nothing and can't exempt those paths; the hook
            // can. See csrf.ts for the full rationale and the exact algorithm
            // (which mirrors SvelteKit's respond.js, minus the exempt prefixes).
            trustedOrigins: ['*'],
        },
        // Subfolder support - set URL_BASE_PATH env var in production (e.g., "/lumastra")
        // Leave empty for root deployment. The reverse proxy should strip the prefix.
        //
        // NOT `BASE_PATH`: that env var is `config.BASE_PATH` (src/lib/server/config.ts)
        // — the filesystem config/data directory (docker-compose.example.yml sets it to
        // '/config') — a different meaning entirely. resolveUrlBasePath() falls back to
        // it only for pre-existing subpath installs whose value isn't one of the
        // filesystem defaults; see scripts/resolve-url-base-path.js for the full
        // reasoning.
        paths: {
            base: resolveUrlBasePath(),
        },
        version: {
            // Unique per build: ties client bundles to the deployed server build so
            // SvelteKit can detect a new deployment (`updated` store + version.json
            // polling). Must come from an env var set ONCE before `vite build` starts
            // (see the "build" npm script), not a bare Date.now() call here — this
            // config file can be evaluated more than once per build (observed on the
            // CI/Docker pipeline, not reproducible in a plain local build), and two
            // Date.now() calls a few ms apart embed two different values into
            // different compiled chunks. Since __sveltekit_<hash> is derived from
            // this string, that split made every $env/dynamic/public reference throw
            // `undefined.env` on load (preprod 500, 2026-07-07) — a single fixed env
            // var is inherited identically by every process/worker in the build, so
            // it can't drift no matter how many times this file gets re-evaluated.
            name: `${process.env.APP_VERSION || process.env.GITHUB_TAG || 'dev'}-${process.env.BUILD_VERSION_TS || Date.now()}`,
            // 5 minutes, not 60s: this poller runs in every tab for its whole
            // lifetime, hidden or not (SvelteKit has no visibility gating) —
            // 2,736 requests in ~34h on prod, mostly idle tabs. The root layout
            // also checks at once when a tab becomes visible again.
            pollInterval: 300_000,
        },
    },
};

export default config;
