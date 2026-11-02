// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const appPath = (...parts: string[]): string => resolve(appRoot, ...parts);
export default defineConfig({
    root: appPath('tests/fixtures/remediation-ui'),
    plugins: [svelte({ configFile: false, compilerOptions: { dev: true } }), tailwindcss()],
    define: { __API_CONTRACT_STRICT__: 'true', __DIAGNOSTIC_ROUTE_WORDS__: '[]' },
    resolve: {
        alias: {
            $lib: appPath('src/lib'),
            '$app/environment': appPath('tests/fixtures/remediation-ui/app.ts'),
            '$app/paths': appPath('tests/fixtures/remediation-ui/app.ts'),
            '$app/navigation': appPath('tests/fixtures/remediation-ui/app.ts'),
            '$app/stores': appPath('tests/fixtures/remediation-ui/app.ts'),
        },
    },
    server: { fs: { allow: [appRoot, realpathSync(appPath('node_modules'))] } },
});
