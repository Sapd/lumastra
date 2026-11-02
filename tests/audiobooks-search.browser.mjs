// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Production-compiled route regression: real Chromium input/debounce/fetch.
 * Build remotely with --pull search.js: node tests/audiobooks-search.browser.mjs --build search.js
 * Then run the pulled bundle: node tests/audiobooks-search.browser.mjs search.js
 * Unrelated cards/navigation/playback and the API transport wrapper are inert;
 * the actual route, its binding/effect, LatestRequest and requestLibrary run.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const book = (title) => ({
    id: '00000000-0000-4000-8000-000000000001',
    catalogId: '00000000-0000-4000-8000-000000000001',
    title,
    type: 'audiobook',
    ids: {},
    images: {},
    audiobook: { authors: [], narrators: [], series: null },
});
if (process.argv[2] === '--build') {
    const { build } = await import('vite');
    const { svelte } = await import('@sveltejs/vite-plugin-svelte');
    const route = resolve('src/routes/audiobooks/+page.svelte');
    const card = resolve('src/routes/audiobooks/test-fixtures/AudiobookCard.svelte');
    const data = {
        items: [book('Initial Aurora')],
        totalCount: 1,
        hasMore: false,
        pageSize: 60,
        loadError: false,
        shelves: [],
        languages: [],
        letterCounts: [],
        resume: [],
        audiobookActivity: null,
        filterNames: {},
        filter: {
            group: 'shelf',
            language: 'de',
            author: 'writer',
            narrator: 'reader',
            series: null,
            letter: null,
            sort: 'title_asc',
        },
    };
    const modules = {
        entry: `import {mount} from 'svelte';import Page from ${JSON.stringify(route)};
            mount(Page,{target:document.body,props:{data:${JSON.stringify(data)}}});`,
        navigation:
            'export const goto=()=>{};export const invalidateAll=()=>{};export const beforeNavigate=()=>{};',
        stores: `import {readable} from 'svelte/store';export const page=readable({url:new URL('http://localhost/audiobooks')});`,
        paths: 'export const base="";export const resolve=p=>p;',
        environment:
            'export const browser=true;export const building=false;export const dev=false;',
        playback:
            'export const playAudiobook=async()=>false;export const audiobookStartFailureMessage=()=>"unused";',
        modal: 'export const openMediaModal=()=>{};',
        toast: 'export const toasts={error:()=>{}};',
        sort: 'export const audiobookSortParams=s=>({sort:s.split("_")[0],order:s.endsWith("desc")?"desc":"asc"});',
        client: `export async function apiGet(endpoint,schema,options){
            const response=await fetch(endpoint+'?'+new URLSearchParams(Object.entries(options.params).filter(([,v])=>v!==undefined)),{signal:options.signal});
            return {data:await response.json(),error:null,status:response.status};}`,
    };
    const aliases = {
        '$app/navigation': 'navigation',
        '$app/stores': 'stores',
        '$app/paths': 'paths',
        '$app/environment': 'environment',
        '$lib/paths': 'paths',
        '$lib/services/audiobook-playback': 'playback',
        '$lib/utils/modal-utils': 'modal',
        '$lib/stores/toast.store': 'toast',
        '$lib/api/client': 'client',
        '$lib/api/audiobooks': 'sort',
    };
    const entryPath = resolve(`perf-audiobooks-search-entry-${process.pid}.js`);
    await writeFile(entryPath, modules.entry, { flag: 'wx' });
    let result;
    try {
        result = await build({
            configFile: false,
            logLevel: 'warn',
            plugins: [
                {
                    name: 'search-regression',
                    enforce: 'pre',
                    resolveId(id) {
                        if (id.startsWith(resolve('src/lib') + '/'))
                            id = '$lib/' + id.slice(resolve('src/lib').length + 1);
                        if (aliases[id]) return '\0' + aliases[id];
                        if (
                            id === '$lib/components/ui/UniversalMediaCard.svelte' ||
                            id === '$lib/components/audiobook/AudiobookActivityRail.svelte'
                        )
                            return card;
                    },
                    async load(id) {
                        if (id.startsWith('\0') && modules[id.slice(1)])
                            return modules[id.slice(1)];
                        if (id === route && process.env.AUDIOBOOK_PAGE_SOURCE)
                            return readFile(process.env.AUDIOBOOK_PAGE_SOURCE, 'utf8');
                    },
                },
                svelte({ configFile: false }),
            ],
            resolve: { alias: { $lib: resolve('src/lib') } },
            build: {
                write: false,
                lib: { entry: entryPath, formats: ['es'] },
                rollupOptions: { output: { inlineDynamicImports: true } },
            },
        });
    } finally {
        await unlink(entryPath);
    }
    const outputs = Array.isArray(result) ? result : [result];
    await writeFile(
        process.argv[3],
        outputs.flatMap((x) => x.output).find((x) => x.type === 'chunk' && x.isEntry).code,
    );
} else {
    const { chromium } = createRequire(import.meta.url)('@playwright/test');
    const bundle = await readFile(process.argv[2]);
    const calls = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/bundle.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(bundle);
        } else if (url.pathname === '/api/audiobooks') {
            calls.push(Object.fromEntries(url.searchParams));
            res.setHeader('Content-Type', 'application/json');
            res.end(
                JSON.stringify({
                    items: [book('Aurora result')],
                    page: { limit: 60, offset: 0, total: 1, hasMore: false },
                }),
            );
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.end('<div></div><script type="module" src="/bundle.js"></script>');
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    try {
        for (let run = 0; run < 3; run++) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            const input = page.getByRole('searchbox');
            await input.waitFor();
            const start = Date.now();
            const before = calls.length;
            const requested = page.waitForRequest(
                (r) => new URL(r.url()).searchParams.get('q') === 'aurora',
                { timeout: 1500 },
            );
            await input.fill('aurora');
            await requested;
            await page
                .locator('.audiobook-search-result-cards')
                .getByRole('button', { name: 'Aurora result' })
                .waitFor();
            const elapsed = Date.now() - start;
            assert.equal(calls.length, before + 1);
            assert.equal(calls.at(-1).libraryGroupId, 'shelf');
            assert.equal(calls.at(-1).authorId, 'writer');
            assert.equal(calls.at(-1).narratorId, 'reader');
            assert.equal(calls.at(-1).lang, 'de');
            assert.equal(calls.at(-1).collapse, 'series');
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ run: run + 1, inputToResultsMs: elapsed, requests: 1 }));
            await input.fill('');
            const count = calls.length;
            await page.waitForTimeout(350);
            assert.equal(calls.length, count);
            await page.close();
        }
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
}
