// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { build } from 'esbuild';

// Like build-sandbox: emitted after Vite empties build/, copied with adapter-node.
// The worker graph contains only the bitmap parsers, renderer, logger and sharp.
await build({
    entryPoints: ['src/lib/server/services/subtitle-render-entry.ts'],
    outfile: 'build/subtitle-render-entry.js',
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
});
