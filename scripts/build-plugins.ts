// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build external plugins into standalone ESM bundles.
 * Each plugin in plugins/<name>/src/index.ts → plugins/<name>/dist/index.js
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(repoRoot, 'plugins');

if (!fs.existsSync(pluginsDir)) {
    console.log('No plugins/ directory found, skipping plugin build');
    process.exit(0);
}

const pluginDirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(pluginsDir, e.name));

let built = 0;
let failed = 0;

for (const pluginDir of pluginDirs) {
    const entryPoint = path.join(pluginDir, 'src', 'index.ts');
    if (!fs.existsSync(entryPoint)) continue;

    const outDir = path.join(pluginDir, 'dist');
    const outFile = path.join(outDir, 'index.js');
    const pluginName = path.basename(pluginDir);

    try {
        await esbuild.build({
            entryPoints: [entryPoint],
            outfile: outFile,
            bundle: true,
            format: 'esm',
            platform: 'node',
            target: 'node20',
            // postgres is provided at runtime by the host app via context.sql
            // All other deps are pure TypeScript inlined by esbuild
            external: ['postgres'],
            minify: false,
            sourcemap: false,
        });

        console.log(`Built ${pluginName} -> ${outFile}`);
        built++;
    } catch (err) {
        console.error(`Failed to build ${pluginName}:`, err);
        failed++;
    }
}

console.log(`\nPlugins: ${built} built, ${failed} failed`);
if (failed > 0) process.exit(1);
