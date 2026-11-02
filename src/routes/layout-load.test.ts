// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { isWatchRoute } from '$lib/utils/watch-route';

it('classifies watch routes without confusing watchlist or deployment prefixes', () => {
    for (const id of ['/watch', '/watch/[itemId]', '/watch/[itemId]/details'])
        expect(isWatchRoute(id)).toBe(true);
    for (const id of [null, '/', '/watchlist', '/browse', '/login', '/showcase'])
        expect(isWatchRoute(id)).toBe(false);
});

it('does not add a universal root load to catalog navigation', () => {
    expect(existsSync('src/routes/+layout.ts')).toBe(false);
});

it('eagerly imports app chrome for every page outside watch', () => {
    const routesRoot = resolve('src/routes');
    const uncoveredPages: string[] = [];
    let pageCount = 0;

    function importsAppShell(file: string): boolean {
        return (
            existsSync(file) &&
            /^\s*import\s+(?!type\b)(?:[^;'"()]*?\s+from\s+)?['"]\$lib\/components\/app-shell['"]/m.test(
                readFileSync(file, 'utf8'),
            )
        );
    }

    function walk(directory: string, ancestorImportsShell: boolean): void {
        const layoutImportsShell =
            ancestorImportsShell || importsAppShell(join(directory, '+layout.svelte'));
        const page = join(directory, '+page.svelte');
        const routeId =
            '/' +
            relative(routesRoot, directory)
                .split(sep)
                .filter((segment) => !/^\(.*\)$/.test(segment))
                .join('/');

        if (existsSync(page) && !isWatchRoute(routeId)) {
            pageCount++;
            if (!layoutImportsShell && !importsAppShell(page)) {
                uncoveredPages.push(relative(routesRoot, page));
            }
        }

        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                // A parent's +page.svelte is not inherited by its child routes.
                walk(join(directory, entry.name), layoutImportsShell);
            }
        }
    }

    walk(routesRoot, false);
    expect(pageCount).toBeGreaterThan(0);
    expect(
        uncoveredPages,
        'Pages missing a static app-shell import in their page/layout chain',
    ).toEqual([]);
});
