// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * package.json's `paraglide:compile` script and vite.config.ts's
 * `paraglideVitePlugin({ strategy: [...] })` must declare the exact same
 * Paraglide strategy list — nothing enforces this beyond a comment in each
 * file. This test reads both files from disk and asserts they agree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(__here, '../../package.json');
const VITE_CONFIG_PATH = resolve(__here, '../../vite.config.ts');

function extractPackageJsonStrategy(): string[] {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
        scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['paraglide:compile'] ?? '';
    const match = /--strategy\s+((?:\S+\s*)+?)(?:&&|$)/.exec(script);
    if (!match) {
        throw new Error(
            `Could not find --strategy list in package.json's "paraglide:compile" script (${PACKAGE_JSON_PATH})`,
        );
    }
    return match[1].trim().split(/\s+/);
}

function extractViteConfigStrategy(): string[] {
    const source = readFileSync(VITE_CONFIG_PATH, 'utf8');
    const match = /strategy:\s*\[([^\]]*)\]/.exec(source);
    if (!match) {
        throw new Error(
            `Could not find strategy: [...] array in vite.config.ts (${VITE_CONFIG_PATH})`,
        );
    }
    return match[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.length > 0);
}

describe('paraglide strategy sync', () => {
    it('keeps package.json and vite.config.ts strategy lists identical', () => {
        const packageJsonStrategy = extractPackageJsonStrategy();
        const viteConfigStrategy = extractViteConfigStrategy();

        expect(
            packageJsonStrategy,
            `Paraglide strategy drift detected between "paraglide:compile" in ${PACKAGE_JSON_PATH} (${JSON.stringify(packageJsonStrategy)}) and the paraglideVitePlugin strategy in ${VITE_CONFIG_PATH} (${JSON.stringify(viteConfigStrategy)}) — these two must be kept in sync.`,
        ).toEqual(viteConfigStrategy);
    });
});
