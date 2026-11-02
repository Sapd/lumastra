// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Recursively get all .ts files in a directory
 */
function getFilesRecursive(dir: string, pattern: RegExp): string[] {
    const results: string[] = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...getFilesRecursive(fullPath, pattern));
            } else if (pattern.test(entry.name)) {
                results.push(fullPath);
            }
        }
    } catch {
        // Directory doesn't exist
    }
    return results;
}

describe('Service Boundaries', () => {
    it('routes do not import write-path queries directly', () => {
        const routeFiles = getFilesRecursive('src/routes', /\+server\.ts$/).filter(
            (f) => !f.includes('/j/') && !f.includes('.test.'),
        );

        expect(routeFiles.length).toBeGreaterThan(0);

        const forbiddenImports =
            /import\s+{[^}]*(appendEventAndRebuild|insertEvent|upsertState|markMediaWatched|markMediaUnwatched)[^}]*}\s+from/;

        for (const file of routeFiles) {
            const content = readFileSync(file, 'utf-8');
            if (forbiddenImports.test(content)) {
                // Allow if importing from a service file
                const fromService = /from\s+['"][^'"]*\.service[^'"]*['"]/.test(content);
                if (!fromService) {
                    expect.fail(
                        `${file} imports write-path queries directly. Use service managers.`,
                    );
                }
            }
        }
    });
});
