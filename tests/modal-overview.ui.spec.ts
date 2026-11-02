// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { test, expect, type Page } from '@playwright/test';

// Run the real component and ResizeObserver in a browser; DOM shims cannot
// reproduce text wrapping. No database or media provider fixtures are needed.
let bundle: string;
test.beforeAll(async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = await build({
        stdin: {
            contents: `import { mount } from 'svelte';
                import Harness from 'overview-harness';
                mount(Harness, { target: document.body });`,
            resolveDir: root,
        },
        bundle: true,
        write: false,
        format: 'iife',
        conditions: ['browser'],
        plugins: [
            {
                name: 'overview-test',
                setup(builder) {
                    builder.onResolve({ filter: /^overview-harness$/ }, () => ({
                        path: 'harness.svelte',
                        namespace: 'harness',
                    }));
                    builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
                        contents: compile(
                            `<script>
                        import Overview from './src/lib/components/modal/ModalOverview.svelte';
                        let props = $state({ overview: '', parts: null, id: 'synopsis' });
                        window.updateOverview = (next) => Object.assign(props, next);
                    </script><div style="width:100%; max-width:800px"><Overview {...props} /></div>`,
                            {
                                filename: 'Harness.svelte',
                                css: 'injected',
                            },
                        ).js.code,
                        resolveDir: root,
                    }));
                    builder.onLoad({ filter: /ModalOverview\.svelte$/ }, ({ path }) => ({
                        contents: compile(readFileSync(path, 'utf8'), {
                            filename: path,
                            css: 'injected',
                        }).js.code,
                        resolveDir: root,
                    }));
                    builder.onResolve({ filter: /^\$lib\/paraglide\/messages$/ }, () => ({
                        path: 'messages',
                        namespace: 'messages',
                    }));
                    builder.onLoad({ filter: /.*/, namespace: 'messages' }, () => ({
                        contents: `export const section_show_more = () => 'Show more';
                        export const section_show_less = () => 'Show less';`,
                    }));
                },
            },
        ],
    });
    bundle = result.outputFiles[0].text;
});

async function update(
    page: Page,
    overview: string,
    parts?: { label: string; text: string }[],
): Promise<void> {
    await page.evaluate(
        ({ overview, parts }) => {
            Reflect.get(window, 'updateOverview')({ overview, parts: parts ?? null });
        },
        { overview, parts },
    );
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent('<style>body { margin: 16px; font-family: sans-serif; }</style>');
    await page.addScriptTag({ content: bundle });
});

test('short text needs no toggle; even fewer than 240 characters can overflow', async ({
    page,
}) => {
    await update(page, 'A short overview.');
    await expect(page.locator('.description')).toHaveText('A short overview.');
    await expect(page.getByRole('button')).toHaveCount(0);
    await update(page, 'Wide WWW words. '.repeat(15));
    const more = page.getByRole('button', { name: 'Show more' });
    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
    );
    await expect(page.locator('.description')).not.toHaveClass(/collapsed/);
    await page.getByRole('button', { name: 'Show less' }).click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
});

test('uses desktop space and rechecks when the viewport narrows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 960 });
    await update(page, 'A film about friendship and distant worlds. '.repeat(14));
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect
        .poll(() =>
            page.locator('.description').evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
        )
        .toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 960 });
    await expect(page.getByRole('button')).toHaveCount(0);
});

test('detects a narrow split pane without a viewport resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 960 });
    await update(page, 'A film about friendship and distant worlds. '.repeat(14));
    await expect(page.getByRole('button')).toHaveCount(0);
    await page.locator('.overview').evaluate((element) => {
        element.style.width = '180px';
    });
    await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
    await page.locator('.overview').evaluate((element) => {
        element.style.width = '100%';
    });
    await expect(page.getByRole('button')).toHaveCount(0);
});

test('remeasures height-only resizes, late content and resets expansion for another overview', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 960 });
    await update(page, 'A film about friendship and distant worlds. '.repeat(14));
    await expect(page.getByRole('button')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 600 });
    await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
    await page.getByRole('button', { name: 'Show more' }).click();
    await update(page, 'Another film with a longer story. '.repeat(40));
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveAttribute(
        'aria-expanded',
        'false',
    );
    await update(page, 'Short replacement.');
    await expect(page.getByRole('button')).toHaveCount(0);
});

test('combined episode labels count toward overflow and the toggle stays below the text', async ({
    page,
}) => {
    await update(page, 'First / Second', [
        { label: 'First episode', text: 'The first story. '.repeat(12) },
        { label: 'Second episode', text: 'The second story. '.repeat(12) },
    ]);
    const more = page.getByRole('button', { name: 'Show more' });
    await expect(more).toBeVisible();
    const text = await page.locator('.description').boundingBox();
    const toggle = await more.boundingBox();
    expect(toggle!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
    await more.click();
    await expect(page.getByText('Second episode', { exact: true })).toBeVisible();
    await expect
        .poll(() =>
            page.locator('.description').evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
        )
        .toBe(true);
});
