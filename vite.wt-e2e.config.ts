// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dev-server config for the Watch Together e2e runs — browser <-> Apple TV
 * (the Apple apps' Watch Together e2e script) and browser <-> browser
 * (tests/playwright/playwright.watch-together.config.ts): the normal config with file
 * watching and HMR OFF. Other sessions edit this checkout while a run is in
 * progress; every server-side edit re-initialises the dev server, and during that
 * window /api/v1 answers 401 — which signs the Apple TV app out (a PAT has no
 * refresh token), ending the run for a reason unrelated to Watch Together.
 */
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from './vite.config';

// vite.config.ts exports a callback (it reads `mode`); mergeConfig refuses a
// callback, so resolve it for this run first.
export default defineConfig((env: ConfigEnv) => {
    const resolved = (typeof base === 'function' ? base(env) : base) as UserConfig;
    return mergeConfig(resolved, {
        server: { watch: { ignored: ['**/*'] }, hmr: false },
    });
});
