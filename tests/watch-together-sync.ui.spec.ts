// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together — two-tab sync E2E
 *
 * Drives a REAL two-tab watch-together session (same user, two tabs — the
 * multi-device scenario) against the dev server and asserts the core sync
 * contract that regressed in production:
 *
 *   1. Host play propagates to the guest.
 *   2. Guest pause propagates to the host (anyone can pause).
 *   3. Guest unpause propagates to the host (the reported bug).
 *   4. Host seek re-syncs both tabs and playback does NOT collapse into the
 *      pause/black-screen loop afterwards (stability window).
 *
 * Prerequisite: a >60s seeded item. The 5s `test-video.mp4` fixture is too
 * short to survive the sync cadence (drift reports every 10s), so this spec
 * generates/uses `fixtures/test-video-long.mp4` and seeds its media_items row
 * itself (idempotent) using DATABASE_URL.
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { Page } from '@playwright/test';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const ITEM_ID = 'e2e00000-0000-4000-8000-0000000000aa';
const HOST_CLIENT_ID = 'client_e2e_wt_host_0000001';
const GUEST_CLIENT_ID = 'client_e2e_wt_guest_000001';
const STORAGE_KEY = 'dashboard_watch_party';
const CLIENT_ID_KEY = 'dashboard_watch_party_client_id';

const LONG_FIXTURE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/test-video-long.mp4',
);

test.use({
    launchOptions: {
        args: ['--autoplay-policy=no-user-gesture-required'],
    },
});

/** Seed the long test video as a playable movie (idempotent). */
async function seedLongVideo(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return;
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
    try {
        await sql`
            INSERT INTO media_items (id, title, media_type, file_path, has_files, runtime_seconds, created_at, updated_at)
            VALUES (${ITEM_ID}, 'WT Sync Long Video', 'movie', ${LONG_FIXTURE}, true, 300, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET file_path = ${LONG_FIXTURE}, has_files = true, updated_at = NOW()
        `;
        const fileRows = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path) VALUES (${LONG_FIXTURE})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        if (fileRows[0]?.id) {
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRows[0].id}, ${ITEM_ID})
                ON CONFLICT DO NOTHING
            `;
        }
    } finally {
        await sql.end();
    }
}

function isPaused(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.paused : true;
    });
}

function videoTime(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
}

async function waitForVideoReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const v = document.querySelector('video');
            return !!v && v.readyState >= 2;
        },
        undefined,
        { timeout: 90_000 },
    );
}

async function waitForPlaying(page: Page, timeout: number, label: string): Promise<void> {
    await page
        .waitForFunction(
            () => {
                const v = document.querySelector('video');
                return !!v && !v.paused;
            },
            undefined,
            { timeout },
        )
        .catch(() => {
            throw new Error(`${label}: video did not start playing within ${timeout}ms`);
        });
}

async function waitForPaused(page: Page, timeout: number, label: string): Promise<void> {
    await page
        .waitForFunction(
            () => {
                const v = document.querySelector('video');
                return !!v && v.paused;
            },
            undefined,
            { timeout },
        )
        .catch(() => {
            throw new Error(`${label}: video did not pause within ${timeout}ms`);
        });
}

test.describe('Watch Together — two-tab sync', () => {
    test.skip(!existsSync(LONG_FIXTURE), 'long video fixture missing (generate with ffmpeg)');

    test('guest pause/unpause reaches host; host seek re-syncs without pause loop', async ({
        page: host,
        context,
        request,
    }) => {
        test.setTimeout(300_000);
        await seedLongVideo();

        // --- 1. Create the session via API under the HOST tab's clientId ----
        const createRes = await request.post('/api/watch-together/parties', {
            data: {
                itemId: ITEM_ID,
                mediaType: 'movie',
                title: 'WT Sync Long Video',
                clientId: HOST_CLIENT_ID,
                currentTime: 0,
            },
        });
        expect(createRes.ok(), `create session failed: ${createRes.status()}`).toBe(true);
        const {
            code,
            host: { userId: hostUserId },
        } = ((await createRes.json()) as { party: { code: string; host: { userId: string } } })
            .party;

        // --- 2. Host tab adopts the session (same clientId + stored session) --
        await host.addInitScript(
            ({ cidKey, cid, sKey, sVal }) => {
                sessionStorage.setItem(cidKey, cid);
                localStorage.setItem(sKey, sVal);
            },
            {
                cidKey: CLIENT_ID_KEY,
                cid: HOST_CLIENT_ID,
                sKey: STORAGE_KEY,
                sVal: JSON.stringify({ code, userId: hostUserId }),
            },
        );
        const hostErrors: string[] = [];
        host.on('pageerror', (e) => hostErrors.push(String(e)));
        await host.goto(`/watch/${ITEM_ID}`);
        await waitForVideoReady(host);

        // --- 3. Guest tab joins via the party link with its own clientId ----
        const guest = await context.newPage();
        const guestErrors: string[] = [];
        guest.on('pageerror', (e) => guestErrors.push(String(e)));
        await guest.addInitScript(
            ({ cidKey, cid }) => {
                sessionStorage.setItem(cidKey, cid);
            },
            { cidKey: CLIENT_ID_KEY, cid: GUEST_CLIENT_ID },
        );
        await guest.goto(`/party/${code}`);
        // Wait out Svelte hydration — the SSR'd join button is visible before
        // its click handler attaches, so an immediate click silently no-ops.
        await guest.waitForTimeout(2_500);
        const joinButton = guest.locator('.join-here-btn, .device-option.this-device').first();
        let joined = false;
        for (let attempt = 0; attempt < 3 && !joined; attempt++) {
            await joinButton.click();
            joined = await guest
                .waitForURL(`**/watch/${ITEM_ID}**`, { timeout: 10_000 })
                .then(() => true)
                .catch(() => false);
        }
        expect(joined, 'guest did not reach the watch page after clicking join').toBe(true);
        await waitForVideoReady(guest);

        // Let the join buffer-check settle (server initiates it ~1s after join)
        await host.waitForTimeout(3_000);

        // --- 4. Host starts playback → guest must follow ---------------------
        await host.locator('body').click({ position: { x: 5, y: 5 } });
        await host.keyboard.press('k');
        await waitForPlaying(host, 10_000, 'host (after host play)');
        await waitForPlaying(guest, 15_000, 'guest (after host play)');

        // Give playback a moment so both are genuinely rolling
        await host.waitForTimeout(3_000);

        // --- 5. GUEST pauses → HOST must pause (anyone can pause) -----------
        await guest.locator('body').click({ position: { x: 5, y: 5 } });
        await guest.keyboard.press('k');
        await waitForPaused(guest, 5_000, 'guest (own pause)');
        await waitForPaused(host, 10_000, 'host (guest pause propagation)');

        await host.waitForTimeout(1_500);

        // --- 6. GUEST unpauses → HOST must resume (the reported bug) --------
        await guest.keyboard.press('k');
        await waitForPlaying(guest, 10_000, 'guest (own unpause)');
        await waitForPlaying(host, 10_000, 'host (guest unpause propagation)');

        await host.waitForTimeout(2_000);

        // --- 7. HOST seeks forward → both re-sync and keep playing ----------
        await host.locator('body').click({ position: { x: 5, y: 5 } });
        await host.keyboard.press('ArrowRight');

        // The seek triggers a buffer check (pause → ready → synchronized
        // resume). Poll until the guest converges on the host's new position —
        // the buffer_check/all_ready round-trip takes a couple of seconds.
        await expect
            .poll(
                async () => {
                    const [hostT, guestT] = await Promise.all([videoTime(host), videoTime(guest)]);
                    return Math.abs(hostT - guestT);
                },
                {
                    message: 'guest did not converge on host position after host seek',
                    timeout: 25_000,
                },
            )
            .toBeLessThan(3.5);

        await waitForPlaying(host, 25_000, 'host (after own seek)');
        await waitForPlaying(guest, 25_000, 'guest (after host seek)');

        // --- 8. Stability window: no pause/black-screen loop -----------------
        // The production bug: after a seek, the party collapsed into a
        // stall → group-pause → resume loop every few seconds. Sample both
        // players over 15s; transient buffer pauses are tolerated but the
        // party must not be paused most of the time and must end playing.
        let pausedSamples = 0;
        const SAMPLES = 15;
        for (let i = 0; i < SAMPLES; i++) {
            await host.waitForTimeout(1_000);
            const [hp, gp] = await Promise.all([isPaused(host), isPaused(guest)]);
            if (hp || gp) pausedSamples++;
        }
        expect(
            pausedSamples,
            `party spent ${pausedSamples}/${SAMPLES}s paused after seek — pause loop`,
        ).toBeLessThanOrEqual(4);

        await waitForPlaying(host, 10_000, 'host (end of stability window)');
        await waitForPlaying(guest, 10_000, 'guest (end of stability window)');

        const [hostT2, guestT2] = await Promise.all([videoTime(host), videoTime(guest)]);
        expect(
            Math.abs(hostT2 - guestT2),
            `positions diverged at end: host=${hostT2.toFixed(2)} guest=${guestT2.toFixed(2)}`,
        ).toBeLessThan(3.5);

        expect(hostErrors, `host page errors: ${hostErrors.join('; ')}`).toEqual([]);
        expect(guestErrors, `guest page errors: ${guestErrors.join('; ')}`).toEqual([]);

        // Cleanup: end the session (host)
        await request.delete(`/api/watch-together/${code}`).catch(() => {});
    });
});
