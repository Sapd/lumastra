// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { test, expect } from '@playwright/test';

let bundle: string;
test.beforeAll(async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = await build({
        stdin: {
            contents: `import { mount } from 'svelte'; import Harness from 'language-harness'; mount(Harness, { target: document.body });`,
            resolveDir: root,
        },
        bundle: true,
        write: false,
        format: 'iife',
        conditions: ['browser', 'svelte'],
        alias: { $lib: `${root}src/lib` },
        plugins: [
            {
                name: 'language-test',
                setup(builder) {
                    builder.onResolve({ filter: /^language-harness$/ }, () => ({
                        path: 'Harness.svelte',
                        namespace: 'harness',
                    }));
                    builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
                        contents: compile(
                            `<script>import Badges from './src/lib/components/media/LanguageBadges.svelte';</script>
                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%">
                <span style="white-space:nowrap">25 Min.</span><span style="white-space:nowrap">10.7.2026</span>
                <Badges originalLanguage="ja" audioLanguages={['ara','fra','eng','deu','ger']} subtitleLanguages={['jpn','fra','de','eng','ita','spa','kor','zho','por','hin','rus','vie','pol','nld','swe','dan']} />
                </div><button id="outside" style="position:fixed;bottom:16px;right:16px">Outside</button>`,
                            { filename: 'Harness.svelte', css: 'injected' },
                        ).js.code,
                        resolveDir: root,
                    }));
                    builder.onResolve({ filter: /^\$app\/environment$/ }, () => ({
                        path: 'environment',
                        namespace: 'stub',
                    }));
                    builder.onResolve({ filter: /^\$app\/stores$/ }, () => ({
                        path: 'stores',
                        namespace: 'stub',
                    }));
                    builder.onResolve(
                        { filter: /^\$lib\/paraglide\/(messages|runtime)(\.js)?$/ },
                        (args) => ({
                            path: args.path.includes('messages') ? 'messages' : 'runtime',
                            namespace: 'stub',
                        }),
                    );
                    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
                        contents:
                            path === 'environment'
                                ? `export const browser=true;`
                                : path === 'stores'
                                  ? `import { readable } from 'svelte/store'; export const page=readable({data:{mediaLanguagePriority:['de-DE','en','fr']}});`
                                  : path === 'runtime'
                                    ? `export const getLocale=()=> 'en';`
                                    : `export const tech_audio_track=()=> 'Audio'; export const tech_subtitles=()=> 'Subtitles'; export const media_languages_unknown_language=()=> 'Unknown language'; export const media_languages_more=({count})=> '+'+count+' more';`,
                        resolveDir: root,
                    }));
                    builder.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
                        contents: compile(readFileSync(path, 'utf8'), {
                            filename: path,
                            css: 'injected',
                        }).js.code,
                        resolveDir: dirname(path),
                    }));
                },
            },
        ],
    });
    bundle = result.outputFiles[0].text;
});

test('desktop ordering, hover preview, click pinning, Escape and outside dismissal', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setContent('<style>body{margin:16px;font-family:sans-serif}</style>');
    await page.addScriptTag({ content: bundle });
    const audio = page.locator('[data-language-kind="audio"]');
    await expect(audio).toContainText(/DE.*EN.*\+2/s);
    const more = audio.getByRole('button');
    await more.hover();
    await expect(page.getByRole('region', { name: 'Audio' })).toContainText(
        'German · English · French · Arabic',
    );
    await more.click();
    await page.mouse.move(900, 500);
    await page.waitForTimeout(150);
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Outside' }).focus();
    await more.focus();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('region', { name: 'Audio' })).toBeFocused();
    await page.getByRole('button', { name: 'Outside' }).click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test.describe('touch', () => {
    test.use({ hasTouch: true });
    test('touch layout reduces badges and long lists stay inside the viewport', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await page.setContent('<style>body{margin:16px;font-family:sans-serif}</style>');
        await page.addScriptTag({ content: bundle });
        const subtitles = page.locator('[data-language-kind="subtitles"]');
        await expect(subtitles).toContainText(/DE.*\+15/s);
        await expect(subtitles).not.toContainText('EN');
        const more = subtitles.getByRole('button');
        await more.tap();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        const popup = page.getByRole('region', { name: 'Subtitles' });
        await expect(popup).toContainText('Vietnamese');
        const bounds = await popup.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
        await page.getByRole('button', { name: 'Outside' }).tap();
        await expect(popup).toHaveCount(0);
    });
});

test('constrained desktop columns reduce badge count and respond when widened', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setContent('<style>body{width:280px;margin:16px}</style>');
    await page.addScriptTag({ content: bundle });
    const audio = page.locator('[data-language-kind="audio"]');
    await expect(audio).toContainText(/DE.*\+3/s);
    await page.evaluate(() => {
        document.body.style.width = '800px';
    });
    await expect(audio).toContainText(/DE.*EN.*\+2/s);
});

test('fullscreen popover belongs to the fullscreen subtree and stays open for inside focus', async ({
    page,
}) => {
    await page.setContent('<style>body{margin:16px}</style>');
    await page.addScriptTag({ content: bundle });
    const container = page.locator('body > div').first();
    await container.evaluate((node) => node.requestFullscreen());
    const more = page.locator('[data-language-kind="audio"]').getByRole('button');
    await more.click();
    const popup = page.getByRole('region', { name: 'Audio' });
    await expect(popup).toBeVisible();
    expect(await popup.evaluate((node) => document.fullscreenElement?.contains(node))).toBe(true);
    await popup.click();
    await expect(popup).toBeVisible();
    await page.evaluate(() => document.exitFullscreen());
    await expect(popup).toHaveCount(0);
});
