// SPDX-License-Identifier: AGPL-3.0-only
// Capture only the fictional, local website demo. Never point this at production.
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const url = process.argv[2] || 'http://localhost:4321/';
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
    throw new Error('Capture requires a local fictional demo, not a live server.');
}
const out = resolve(process.argv[3] || '.tmp-readme-capture/js');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({
        viewport: { width: 1100, height: 838 },
        deviceScaleFactor: 1,
    });
    await page.goto(url);
    await page.locator('#preview').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Search (Ctrl+F)', exact: true }).waitFor();
    await page.addStyleTag({
        content: `
        .demo { position:fixed!important; inset:0!important; margin:0!important;
            width:1100px!important; max-width:none!important; height:838px!important;
            z-index:1000!important; border-radius:0!important; }
        .demo .viewport { overflow-y:auto!important; scroll-behavior:auto!important; }
        .demo :focus { outline:none!important; }
    `,
    });
    const demo = page.locator('.demo');
    await page.evaluate(() =>
        document.querySelectorAll('.demo img').forEach((img) => {
            img.loading = 'eager';
        }),
    );
    await page.getByRole('button', { name: 'Go to slide 1: The Last Signal', exact: true }).click();
    await page.evaluate(() => {
        document.querySelector('.viewport').scrollTop = 0;
    });
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.demo img')]
            .filter((i) => i.currentSrc)
            .every((i) => i.complete),
    );
    await page.waitForFunction(() => {
        const v = document.querySelector('.demo video');
        return v && !v.paused && v.readyState >= 2;
    });
    await page.evaluate(() => {
        document.querySelector('.demo video').currentTime = 0;
    });
    const capture = async (name) => {
        const png = await demo.screenshot();
        await sharp(png).resize({ width: 820 }).png().toFile(join(out, name));
    };
    const still = async (name) => {
        await page.waitForTimeout(350);
        await sharp(await demo.screenshot())
            .webp({ quality: 86 })
            .toFile(join(out, name + '.webp'));
    };
    if (!process.argv.includes('--stills-only')) {
        const fps = 20;
        let index = 0;
        const frames = [];
        const addFrame = async (phase, scroll) => {
            const file = String(index++).padStart(4, '0') + '.png';
            await capture(file);
            frames.push({ file, phase, scroll, duration: 50 });
        };
        // Real video playback held at the top for 5.5 seconds in the final animation.
        console.log('Recording hero playback');
        for (let frame = 0; frame < 110; frame++) {
            await page.evaluate(async (time) => {
                const video = document.querySelector('.demo video');
                video.pause();
                if (Math.abs(video.currentTime - time) < 0.001) return;
                await new Promise((resolve) => {
                    video.addEventListener('seeked', resolve, { once: true });
                    video.currentTime = time;
                });
            }, frame / fps);
            await addFrame('hero', 0);
        }
        await still('home');
        const max = await page.evaluate(() => {
            const viewport = document.querySelector('.viewport');
            const calendar = document.querySelector('[aria-label="Series Calendar"]');
            return Math.min(
                viewport.scrollHeight - viewport.clientHeight,
                calendar.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
            );
        });
        console.log('Recording eased scroll to calendar', max);
        // A cosine ramp starts and stops gently; tiny fixed increments eliminate wheel jumps.
        for (let frame = 1; frame <= 360; frame++) {
            const t = frame / 360;
            const scroll = max * (0.5 - 0.5 * Math.cos(Math.PI * t));
            await page.evaluate((y) => {
                document.querySelector('.viewport').scrollTop = y;
            }, scroll);
            await addFrame('scroll', scroll);
            if ([115, 215].includes(frame)) frames.at(-1).duration += 900;
            if (frame % 90 === 0) console.log('Scroll frames', frame, '/ 360');
        }
        frames.at(-1).duration += 2000;
        await writeFile(join(out, 'frames.json'), JSON.stringify({ fps, frames }, null, 2));
    }
    console.log('Capturing gallery');
    for (const [button, name] of [
        ['Browse', 'browse'],
        ['Music', 'music'],
        ['Live TV', 'livetv'],
    ]) {
        await page
            .getByRole('navigation', { name: 'Preview navigation' })
            .getByRole('button', { name: button, exact: true })
            .click();
        if (name === 'music')
            await page.evaluate(() => {
                document.querySelector('.viewport').scrollTop = 410;
            });
        await still(name);
    }
    await page.getByRole('button', { name: 'Lumastra Home', exact: true }).click();
    await page
        .getByRole('button', { name: 'Open details for The Last Signal', exact: true })
        .click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(350);
    await sharp(await page.screenshot())
        .webp({ quality: 86 })
        .toFile(join(out, 'detail.webp'));
    console.log('Capture complete:', out);
} finally {
    await browser.close();
}
