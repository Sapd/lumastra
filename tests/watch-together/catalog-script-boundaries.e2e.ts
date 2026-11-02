// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import { expectHydrated } from '../helpers/hydration';
import { webUrl } from './wt-env';
import { scenario } from './wt-harness';

scenario(
    'catalog routes keep optional interface scripts off the initial load',
    { directions: ['A hosts'], tag: ['@chromium-only', '@pr'] },
    async (s) => {
        await s.movie();
        const manifest = JSON.parse(
            readFileSync('.svelte-kit/output/client/.vite/manifest.json', 'utf8'),
        ) as Record<
            string,
            { file: string; name?: string; imports?: string[]; css?: string[]; src?: string }
        >;
        // Check emitted production graphs, including routes this fixture does
        // not configure. A source import alone cannot prove preloading works.
        const serverManifestPath = resolve('.svelte-kit/output/server/manifest-full.js');
        const serverManifestUrl = pathToFileURL(serverManifestPath).href;
        const { manifest: serverManifest } = (await import(serverManifestUrl)) as {
            manifest: {
                _: {
                    nodes: unknown[];
                    routes: {
                        id: string;
                        page?: { layouts: (number | null | undefined)[]; leaf: number };
                    }[];
                };
            };
        };
        // Server route indices address a compacted array, not client node IDs.
        // Read its emitted loader targets without importing every server loader.
        const clientNodeIds = Array.from(
            readFileSync(serverManifestPath, 'utf8').matchAll(
                /import\(['"]\.\/nodes\/(\d+)\.js['"]\)/g,
            ),
            (match) => Number(match[1]),
        );
        expect(clientNodeIds).toHaveLength(serverManifest._.nodes.length);
        const chromeKey = Object.keys(manifest).find(
            (key) =>
                manifest[key].name === 'app-shell' ||
                manifest[key].src === 'src/lib/components/app-shell/index.ts',
        );
        if (!chromeKey) throw new Error('The deferred chrome needs its own emitted chunk');
        for (const route of serverManifest._.routes) {
            if (!route.page) continue;
            const graph = new Set<string>();
            function visit(key: string): void {
                if (graph.has(key)) return;
                graph.add(key);
                for (const dependency of manifest[key].imports ?? []) visit(dependency);
            }
            for (const node of [...route.page.layouts, route.page.leaf]) {
                if (node == null) continue;
                const key = Object.keys(manifest).find((entry) =>
                    entry.endsWith(`/nodes/${clientNodeIds[node]}.js`),
                );
                // A server-only layout has no client module to preload.
                if (key) visit(key);
            }
            expect(graph.has(chromeKey), route.id).toBe(!route.id.startsWith('/watch/'));
        }
        const participant = await s.participant(s.hostUser, 'catalog-scripts');
        const page = participant.page;
        const requested = new Set<string>();
        const errors: string[] = [];
        page.on('request', (request) => requested.add(new URL(request.url()).pathname));
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (/hydration/i.test(message.text()) && ['warning', 'error'].includes(message.type()))
                errors.push(message.text());
        });
        const cases: [string, string | null][] = [
            ['/', null],
            ['/browse', null],
            ['/livetv', 'src/lib/components/livetv/simple/SimpleLiveTvHome.svelte'],
            ['/music', 'src/lib/components/music/MixPreviewCard.svelte'],
            ['/audiobooks', 'src/lib/components/music/MixPreviewCard.svelte'],
        ];
        for (const [route, deferred] of cases) {
            requested.clear();
            const response = await page.goto(`${webUrl()}${route}`);
            expect(response?.status(), route).toBe(200);
            if (!response) throw new Error(`Missing response for ${route}`);
            const html = await response.text();
            // Client-only dialog bootstrapping must not make lazy modal CSS
            // block every cold catalog load during SSR.
            if (route === '/' || route === '/browse') {
                for (const stylesheet of manifest['src/lib/ModalMovie.svelte'].css ?? [])
                    expect(html, route).not.toContain(stylesheet);
            }
            await expectHydrated(page);
            await expect(page.locator('main')).toBeVisible();
            if (deferred) {
                expect(manifest[deferred], `${deferred} needs a dynamic boundary`).toBeDefined();
                expect(requested.has('/' + manifest[deferred].file), route).toBe(false);
            }
            if (route === '/livetv') {
                // No channels: neither regular grid nor card is needed.
                const grid = manifest['src/lib/components/livetv/ChannelGrid.svelte'];
                expect(requested.has('/' + grid.file)).toBe(false);
                const card = manifest['src/lib/components/livetv/ChannelCard.svelte'];
                // Card can be folded into Grid's chunk once both are deferred.
                if (card) expect(requested.has('/' + card.file)).toBe(false);
            }
        }
        // The server has now registered catalog constructors. A cold error
        // branch must still hydrate without borrowing that process-global cache.
        const missing = await page.goto(`${webUrl()}/missing-catalog-fixture`);
        expect(missing?.status()).toBe(404);
        await expectHydrated(page);
        expect(errors).toEqual([]);
    },
);
