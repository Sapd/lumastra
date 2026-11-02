#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Guards against a broken deploy where the compiled client bundle references more
// than one SvelteKit build-version hash (globalThis.__sveltekit_<hash>). That split
// crashes every page load with "Cannot read properties of undefined (reading 'env')"
// before hydration even starts (window.__sveltekit_<hash> from one chunk doesn't
// match the id another chunk expects) — hit on preprod 2026-07-07, root cause never
// pinned down (local single-process builds reproduce a single consistent hash, so
// it's suspected BuildKit-cache-related). Fails the build instead of shipping it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(__dirname, '..', 'build', 'client', '_app', 'immutable');

function collectJsFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...collectJsFiles(full));
        } else if (entry.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

const hashPattern = /__sveltekit_[a-zA-Z0-9]+/g;
const foundHashes = new Map<string, string[]>();

for (const file of collectJsFiles(clientDir)) {
    const content = readFileSync(file, 'utf8');
    const matches = content.match(hashPattern);
    if (!matches) continue;
    for (const hash of new Set(matches)) {
        const files = foundHashes.get(hash) ?? [];
        files.push(file);
        foundHashes.set(hash, files);
    }
}

if (foundHashes.size > 1) {
    console.error(
        `❌ Build is internally inconsistent: found ${foundHashes.size} distinct SvelteKit build hashes in build/client/_app/immutable (expected exactly 1).`,
    );
    for (const [hash, files] of foundHashes) {
        console.error(`  ${hash}: ${files.length} file(s), e.g. ${files[0]}`);
    }
    console.error(
        'This will crash every page load client-side. Rebuild from a clean cache (no reused Docker/BuildKit layers) before deploying.',
    );
    process.exit(1);
}

if (foundHashes.size === 0) {
    console.log('ℹ️  No __sveltekit_ build hash found in client output (skipped check)');
} else {
    console.log(`✅ Build consistency check passed (hash: ${[...foundHashes.keys()][0]})`);
}
