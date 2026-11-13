// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build, transform, type Plugin } from 'esbuild';
import { compile, compileModule } from 'svelte/compiler';
import type { Page } from '@playwright/test';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

const root = process.cwd();
const fixture = './tests/fixtures/SettingsHydrationFixture.svelte';
const preference = 'admin:showAdvancedSettings';
const settingsUrl = 'http://settings.test/admin/settings?category=features';

// Compile separate SSR/client graphs, as Kit does, then let Chromium parse the
// SSR HTML before hydrating it. Client-only rendering cannot detect this bug.
// Only Kit integration and network calls are stubbed; settings markup, schema,
// visibility logic, input registry and the preference store are production code.
async function bundle(browser: boolean): Promise<string> {
    const stubs: Record<string, string> = {
        '$app/environment': `export const browser = ${browser}; export const dev = false; export const version = 'e2e';`,
        '$app/state': `export const page = {url: new URL('${settingsUrl}'), state: {}};`,
        '$app/navigation': `export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const goto = async () => {}; export const replaceState = () => {}; export const pushState = () => {};`,
        '$app/forms': `export const enhance = () => ({destroy() {}});`,
        '$app/paths': `export const base = ''; export const resolve = p => p;`,
        '$lib/api/admin': `export const checkProviderHealth = async () => ({}); export const getAvailableGroups = async () => ({data: {groups: []}});`,
        '$lib/components/admin': [
            "export { default as SettingSection } from '$lib/components/admin/SettingSection.svelte';",
            "export { default as StickySaveBar } from '$lib/components/admin/settings/StickySaveBar.svelte';",
            "export { default as SearchInput } from '$lib/components/admin/settings/SearchInput.svelte';",
            "export { default as ActionModal } from '$lib/components/admin/ActionModal.svelte';",
        ].join('\n'),
    };
    const plugin: Plugin = {
        name: 'settings-hydration',
        setup(builder): void {
            builder.onResolve({ filter: /^\$(app|lib)\// }, (args) => {
                if (args.path in stubs) return { path: args.path, namespace: 'stub' };
                return undefined;
            });
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
                contents: stubs[args.path],
                resolveDir: root,
            }));
            builder.onLoad({ filter: /\.svelte$/ }, (args) => ({
                contents: compile(readFileSync(args.path, 'utf8'), {
                    filename: args.path,
                    generate: browser ? 'client' : 'server',
                    css: 'external',
                    dev: true,
                }).js.code,
                loader: 'js',
            }));
            builder.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => ({
                contents: compileModule(
                    (await transform(readFileSync(args.path, 'utf8'), { loader: 'ts' })).code,
                    {
                        filename: args.path,
                        generate: browser ? 'client' : 'server',
                    },
                ).js.code,
                loader: 'js',
            }));
        },
    };
    const entry = browser
        ? `import { hydrate, tick } from 'svelte';
           import Fixture from '${fixture}';
           import { showAdvancedSettings } from './src/lib/stores/admin-show-advanced.store';
           window.startHydration = async (sectionId, eager) => {
               if (eager) showAdvancedSettings.set(localStorage.getItem('${preference}') === 'true');
               hydrate(Fixture, {target: document.getElementById('app'), props: {sectionId}, recover: false});
               await tick();
           };`
        : `import { render } from 'svelte/server';
           import Fixture from '${fixture}';
           globalThis.renderSettings = sectionId => render(Fixture, {props: {sectionId}}).body;`;
    const result = await build({
        stdin: { contents: entry, resolveDir: root },
        bundle: true,
        write: false,
        format: 'iife',
        platform: browser ? 'browser' : 'node',
        conditions: browser
            ? ['svelte', 'browser', 'development']
            : ['svelte', 'node', 'development'],
        alias: { $lib: resolve(root, 'src/lib') },
        plugins: [plugin],
        logLevel: 'silent',
    });
    return result.outputFiles[0].text;
}

/**
 * Page errors plus console warnings/errors, except Chromium's own form-control
 * note for a colour input. The two branding colour settings render an
 * `<input type="color">`; the first page in a browser process to hydrate one
 * logs "The specified value "" does not conform to the required format. The
 * value must be a valid CSS color." (once per process, so it lands on whichever
 * test runs first). It is not a hydration failure: the input keeps its colour
 * and the DOM is preserved, which the assertions below verify. Everything else,
 * including every Svelte hydration warning, still fails the test.
 */
const CHROMIUM_EMPTY_COLOR_NOTE =
    'The specified value "" does not conform to the required format.  The value must be a valid CSS color.';

function collectPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() !== 'warning' && message.type() !== 'error') return;
        if (message.text() === CHROMIUM_EMPTY_COLOR_NOTE) return;
        errors.push(message.text());
    });
    return errors;
}

let client: string;
let renderSettings: (section: string) => string;

test.beforeAll(async () => {
    test.setTimeout(60000);
    const server = await bundle(false);
    const context = {
        URL,
        console,
        setTimeout,
        clearTimeout,
        renderSettings: undefined as ((section: string) => string) | undefined,
    };
    runInNewContext(server, context);
    if (typeof context.renderSettings !== 'function') throw new Error('Missing SSR renderer');
    renderSettings = context.renderSettings;
    client = await bundle(true);
});

test.describe('real settings SSR hydration', () => {
    test.describe.configure({ mode: 'default' });
    for (const section of [
        'branding',
        'features',
        'advanced',
        'conn-sonarr',
        'metadata',
        'advanced-tasks-tuning,branding',
        'branding,features,advanced,modules,licensing',
    ]) {
        test(`hydrates ${section} with a saved advanced preference and preserves server DOM`, async ({
            page,
        }) => {
            page.setDefaultTimeout(5000);
            page.setDefaultNavigationTimeout(5000);
            const errors = collectPageErrors(page);
            const html = renderSettings(section);
            await page.route('http://settings.test/**', (route) =>
                route.fulfill({ contentType: 'text/html', body: `<div id="app">${html}</div>` }),
            );
            await page.goto(settingsUrl);
            await page.evaluate((key) => localStorage.setItem(key, 'true'), preference);
            const search = await page.locator('input[aria-label="Search"]').elementHandle();
            await page.addScriptTag({ content: client });
            await page.evaluate(`window.startHydration(${JSON.stringify(section)}, false)`);
            expect(await search?.evaluate((element) => element.isConnected)).toBe(true);
            expect(
                await page.locator('button[role="switch"]').first().getAttribute('aria-checked'),
            ).toBe('true');
            await page.locator('input[aria-label="Search"]').fill('a');
            expect(await page.locator('input[aria-label="Search"]').inputValue()).toBe('a');
            expect(await page.evaluate((key) => localStorage.getItem(key), preference)).toBe(
                'true',
            );
            expect(errors).toEqual([]);
        });
    }

    // Negative control: deliberately bypass post-mount initialization. The first
    // client render now differs from SSR, so recover:false MUST reject. This
    // proves the harness can detect the original bug; production initializes
    // the preference from the admin layout's onMount (route test below).
    test('detects an advanced preference forced into the first client render', async ({ page }) => {
        page.setDefaultTimeout(5000);
        const section = 'advanced-tasks-tuning,branding';
        const errors = collectPageErrors(page);
        const html = renderSettings(section);
        await page.route('http://settings.test/**', (route) =>
            route.fulfill({ contentType: 'text/html', body: `<div id="app">${html}</div>` }),
        );
        await page.goto(settingsUrl);
        await page.evaluate((key) => localStorage.setItem(key, 'true'), preference);
        await page.addScriptTag({ content: client });
        await expect(
            page.evaluate(`window.startHydration(${JSON.stringify(section)}, true)`),
        ).rejects.toThrow('hydration_failed');
        expect(errors.some((error) => error.includes('hydration_mismatch'))).toBe(true);
    });
});

// Exercise the real layout, not only the fixture's copy of its onMount callback.
// Capture an SSR node as the HTML is parsed, before Kit's module scripts run, so
// automatic hydration recovery cannot hide a mismatched initial client render.
test('production settings route restores advanced preferences after hydration without replacing SSR DOM', async ({
    page,
}) => {
    const errors = collectPageErrors(page);
    await page.addInitScript((key) => {
        localStorage.setItem(key, 'true');
        const observer = new MutationObserver(() => {
            const search = document.querySelector('input[aria-label="Search"]');
            if (search) {
                Reflect.set(window, '__settingsSSRSearch', search);
                observer.disconnect();
            }
        });
        observer.observe(document, { childList: true, subtree: true });
    }, preference);
    const response = await page.goto('/admin/settings/tasks?category=advanced-tasks-tuning');
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain('aria-label="Search"');
    await expectHydrated(page);
    const advanced = page.locator('main button[role="switch"]').first();
    await expect(advanced).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#section-advanced-tasks-tuning')).toBeVisible();
    expect(
        await page.evaluate(() => {
            const search: unknown = Reflect.get(window, '__settingsSSRSearch');
            return search instanceof HTMLInputElement && search.isConnected;
        }),
    ).toBe(true);
    await page.locator('input[aria-label="Search"]').fill('queue');
    await expect(page.locator('input[aria-label="Search"]')).toHaveValue('queue');
    await advanced.click();
    await expect(advanced).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate((key) => localStorage.getItem(key), preference)).toBe('false');
    expect(errors).toEqual([]);
});
