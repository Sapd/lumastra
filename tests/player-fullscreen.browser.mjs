// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Browser regression for the production fullscreen action across player remounts.
 * Run: lumastra-remote node tests/player-fullscreen.browser.mjs
 * Uses the production method with inert collaborators, not the full watch route.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import ts from 'typescript';
import { transform } from 'esbuild';
import { chromium } from '@playwright/test';

const file = 'src/lib/components/player/player-controller.svelte.ts';
const source = await readFile(file, 'utf8');
const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const controller = parsed.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'PlayerController',
);
const method = controller?.members.find(
    (node) => node.name?.getText(parsed) === 'toggleFullscreen',
);
assert.ok(method, 'Production toggleFullscreen method');
const { code } = await transform(
    `const browser = true;
     const playerStore = { setFullscreen() {} };
     const asSafariVideo = video => video;
     class Controller { ${method.getText(parsed)} }
     const c = new Controller();
     c.isIOS = false;
     c.playerContainer = document.querySelector('.player-container');
     c.videoElement = document.querySelector('video');
     document.querySelector('button').onclick = () => c.toggleFullscreen();`,
    { loader: 'ts' },
);
const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<div class="watch-page"><div class="player-container"><video></video></div>
              <button>Toggle fullscreen</button></div><script>${code}</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
let browser;
try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button').click();
    await page.waitForFunction(() => document.fullscreenElement !== null);
    assert.equal(
        await page.evaluate(() => document.fullscreenElement?.className),
        'watch-page',
        'The persistent wrapper owns fullscreen from the initial user gesture',
    );
    // Remove the old player as Svelte's keyed episode block does. Reject any
    // later requests: unattended autoplay cannot rely on a fresh user gesture.
    await page.evaluate(() => {
        Element.prototype.requestFullscreen = () => Promise.reject(new Error('No user activation'));
        document
            .querySelector('.player-container')
            .replaceWith(
                Object.assign(document.createElement('div'), { className: 'player-container' }),
            );
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.fullscreenElement?.className), 'watch-page');
    // Exit still uses the standard API and does not need a new request.
    await page.getByRole('button').click();
    await page.waitForFunction(() => document.fullscreenElement === null);

    // Embedded players without a watch-page retain their existing behavior.
    await page.reload();
    await page.evaluate(() => {
        document.querySelector('.watch-page').classList.remove('watch-page');
    });
    await page.getByRole('button').click();
    await page.waitForFunction(() => document.fullscreenElement !== null);
    assert.equal(
        await page.evaluate(() => document.fullscreenElement?.className),
        'player-container',
    );
    console.log(
        'PASS: persistent fullscreen survives player replacement, exits, and supports embeds',
    );
} finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}
