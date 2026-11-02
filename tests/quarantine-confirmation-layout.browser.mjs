// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Standalone browser proof of the real confirmation component. No app, API,
 * authentication or modal component is mocked; only its close/i18n imports are
 * isolated from the application shell. Run with the normal remote test runner.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const filename = path.resolve('src/lib/components/ui/ConfirmModal.svelte');
const lines = Array.from(
    { length: 1000 },
    (_, i) =>
        `Episode ${String(i).padStart(8, '0')}-1234-4234-8234-123456789abc · Current title ${i} · TMDB ${870000 + i}\nAfter: ${'LongUnbrokenProposedTitle'.repeat(12)} ${i} · TMDB ${880000 + i}`,
);
const reviewLinks = Array.from({ length: 1000 }, (_, i) => ({
    href: `/admin/library/media/${String(i).padStart(8, '0')}-1234-4234-8234-123456789abc`,
    label: `Inspect episode ${i} <script>escaped</script>`,
}));
const result = await build({
    stdin: {
        contents: `import { mount } from 'svelte'; import ConfirmModal from ${JSON.stringify(filename)};
            window.reviewConfirmed = false;
            mount(ConfirmModal, { target: document.body, props: {
                reviewLinks: ${JSON.stringify(reviewLinks)}, title: 'Review 1000 decisions', body: ${JSON.stringify(lines.join('\n'))}, scrollBody: true,
                confirmText: 'Accept reviewed decisions', cancelText: 'Cancel',
                onConfirm: () => { window.reviewConfirmed = true; }
            }});`,
        resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    conditions: ['browser'],
    plugins: [
        {
            name: 'real-confirmation-component',
            setup(bundler) {
                bundler.onResolve({ filter: /^\$lib\// }, (args) => ({
                    path: args.path,
                    namespace: 'shell',
                }));
                bundler.onLoad({ filter: /.*/, namespace: 'shell' }, (args) => ({
                    contents: args.path.includes('modal.store')
                        ? 'export const modals = { close: async () => {} };'
                        : 'export const dialog_confirm_title = () => "Confirm"; export const dialog_confirm_button = () => "Confirm"; export const dialog_cancel_button = () => "Cancel"; export const dialog_jump_to_actions = () => "Jump to actions";',
                }));
                bundler.onLoad({ filter: /\.svelte$/ }, async (args) => ({
                    contents: compile(await readFile(args.path, 'utf8'), {
                        filename: args.path,
                        generate: 'client',
                        css: 'injected',
                    }).js.code,
                    resolveDir: path.dirname(args.path),
                }));
            },
        },
    ],
});
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    for (const viewport of [
        { width: 1280, height: 800 },
        { width: 360, height: 420 },
    ]) {
        await page.setViewportSize(viewport);
        await page.setContent(`<style>
            * { box-sizing: border-box; } body { margin:16px; font:16px sans-serif; }
            .card { padding:24px; } .w-modal { width:min(500px,calc(100vw - 32px)); }
            .mb-4 { margin-bottom:16px; } .mb-6 { margin-bottom:24px; }
            h3,p { margin:0; } .modal-footer { display:flex; justify-content:flex-end; gap:8px; }
            button { padding:10px; }
        </style>`);
        await page.addScriptTag({ content: result.outputFiles[0].text });
        const body = page.locator('article.scroll-body');
        await body.waitFor();
        assert.equal(await page.locator('#confirm-modal-desc').textContent(), lines.join('\n'));
        assert.equal(await page.getByRole('link').count(), 1000);
        assert.deepEqual(
            await page.getByRole('link').evaluateAll((links) =>
                links.map((link) => ({
                    href: link.getAttribute('href'),
                    label: link.textContent,
                })),
            ),
            reviewLinks,
        );
        assert.equal(await body.locator('script').count(), 0);
        await page.getByRole('link').first().focus();
        assert.equal(await page.locator(':focus').getAttribute('target'), '_blank');
        const geometry = await body.evaluate((el) => ({
            overflow: getComputedStyle(el).overflowY,
            wraps: getComputedStyle(el).overflowWrap,
            height: el.clientHeight,
            scrollHeight: el.scrollHeight,
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
        }));
        assert.equal(geometry.overflow, 'auto');
        assert.equal(geometry.wraps, 'anywhere');
        assert.ok(geometry.scrollHeight > geometry.height);
        assert.ok(geometry.scrollWidth <= geometry.width);
        await body.focus();
        await page.keyboard.press('PageDown');
        await page.waitForFunction(() => document.querySelector('article').scrollTop > 0);
        await page.keyboard.press('Shift+Tab');
        assert.equal((await page.locator(':focus').textContent()).trim(), 'Jump to actions');
        await page.keyboard.press('Enter');
        assert.equal((await page.locator(':focus').textContent()).trim(), 'Cancel');
        await page.keyboard.press('Tab');
        assert.equal(
            (await page.locator(':focus').textContent()).trim(),
            'Accept reviewed decisions',
        );
        const button = page.getByRole('button', { name: 'Accept reviewed decisions' });
        const bounds = await button.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
        if (viewport.width === 360) {
            await mkdir('.cache', { recursive: true });
            await page.screenshot({ path: '.cache/quarantine-i3-confirmation.png' });
        }
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.reviewConfirmed === true);
        console.log(
            `Confirmation browser passed: ${viewport.width}x${viewport.height}, 1000 complete decisions and escaped inspection links, keyboard jump and scrolling and visible controls`,
        );
    }
} finally {
    await browser.close();
}
