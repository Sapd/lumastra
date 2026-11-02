// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dev-server config for the Watch Together e2e runs — browser <-> Apple TV
 * (the Apple apps' Watch Together e2e script) and browser <-> browser
 * (playwright.watch-together.config.ts): the normal config with file
 * watching and HMR OFF. Other sessions edit this checkout while a run is in
 * progress; every server-side edit re-initialises the dev server, and during that
 * window /api/v1 answers 401 — which signs the Apple TV app out (a PAT has no
 * refresh token), ending the run for a reason unrelated to Watch Together.
 */
import { mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base, {
    server: { watch: { ignored: ['**/*'] }, hmr: false },
});
