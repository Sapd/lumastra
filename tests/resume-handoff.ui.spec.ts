// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Implicit resume handoff — browser tab follows a second device (E2E)
 *
 * Design: docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md (repo root).
 *
 * A tab is left PAUSED on episode A of a series, opened as a linear entry
 * (`?entry=next_up`). A second device of the same user (an Apple TV, simulated
 * through the API with its own device id) finishes A and autoplays into episode
 * B, pausing there at 0:03 with enough engagement (>= 60 s) for the position to
 * be written durably. When the viewer comes back to the tab (window blur, a
 * wait of >= 3 s, focus) the tab asks the server, jumps to B paused at that
 * position and shows "Continued at S01E02 · 0:03 from Living room" with a
 * "Back to S01E01" action.
 *
 * Second test: an EXPLICIT tab (`/watch/<A>` without `entry`) is not linear, so
 * it never asks and never moves under the very same remote activity.
 *
 * The fixture video is ~5 s. Positions are chosen inside it. Each episode gets
 * its own `media_files` row (a combined file would be a seek, not a jump);
 * `media_files.file_path` is unique, so the same physical fixture is reached
 * through two spellings of its path (`./` segments), which the library-root
 * containment check normalises. Every row is seeded here with fresh ids and
 * removed again, using DATABASE_URL like watch-together-sync.ui.spec.ts.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import postgres from 'postgres';
import { adminTest as test, expect } from './fixtures/auth';
import { TEST_FIXTURE_DIR, TEST_FIXTURE_PATH } from './global-setup';
import { expectHydrated } from './helpers/hydration';

const TEST_USER = (process.env.TEST_USER || 'TestUser').toLowerCase();
const TV_NAME = 'Living room';
const SERIES_TITLE = 'Handoff Harbour';

const CAPABILITIES = {
    containers: ['mp4', 'mkv'],
    videoCodecs: ['h264', 'hevc'],
    audioCodecs: ['aac', 'ac3', 'eac3'],
    subtitleFormats: ['vtt'],
    hdr: [] as string[],
};

interface Seed {
    seriesId: string;
    seasonId: string;
    a: string;
    b: string;
    fileIds: string[];
    tvDeviceId: string;
}

let sql: postgres.Sql;

test.beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required to seed the handoff series');
    sql = postgres(databaseUrl, { max: 2, connect_timeout: 10 });
});

test.afterAll(async () => {
    await sql.end({ timeout: 5 });
});

/** Same physical fixture, a distinct (unique) path string per call. */
function fixturePathVariant(): string {
    const dots = './'.repeat(1 + Math.floor(Math.random() * 400) + 1);
    return `${TEST_FIXTURE_DIR}/${dots}${TEST_FIXTURE_PATH.slice(TEST_FIXTURE_DIR.length + 1)}`;
}

async function seedSeries(): Promise<Seed> {
    const seed: Seed = {
        seriesId: randomUUID(),
        seasonId: randomUUID(),
        a: randomUUID(),
        b: randomUUID(),
        fileIds: [],
        tvDeviceId: `appletv-e2e-${randomUUID()}`,
    };
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${seed.seriesId}::uuid, ${SERIES_TITLE}, 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, has_files)
        VALUES (${seed.seasonId}::uuid, 'Season 1', 'season', 'active', ${seed.seriesId}::uuid, 1, true)
    `;
    for (const [id, n] of [
        [seed.a, 1],
        [seed.b, 2],
    ] as const) {
        const filePath = fixturePathVariant();
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, parent_id, season_number, episode_number,
                 file_path, runtime_seconds, has_files)
            VALUES (${id}::uuid, ${`Tide ${n}`}, 'episode', 'active', ${seed.seasonId}::uuid, 1, ${n},
                    ${filePath}, 5, true)
        `;
        const rows = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${filePath})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        const fileId = rows[0]!.id;
        seed.fileIds.push(fileId);
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}::uuid, ${id}::uuid, true)
        `;
    }
    return seed;
}

async function cleanup(seed: Seed): Promise<void> {
    const episodes = [seed.a, seed.b];
    const steps: Array<() => Promise<unknown>> = [
        () => sql`DELETE FROM play_sessions WHERE media_id = ANY(${episodes}::uuid[])`,
        () => sql`DELETE FROM user_media_events WHERE media_id = ANY(${episodes}::uuid[])`,
        () => sql`DELETE FROM user_media_state WHERE media_id = ANY(${episodes}::uuid[])`,
        () => sql`DELETE FROM watch_history WHERE media_id = ANY(${episodes}::uuid[])`,
        () => sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${episodes}::uuid[])`,
        () => sql`DELETE FROM media_files WHERE id = ANY(${seed.fileIds}::uuid[])`,
        () => sql`DELETE FROM media_items WHERE id = ANY(${[seed.a, seed.b]}::uuid[])`,
        () => sql`DELETE FROM media_items WHERE id = ${seed.seasonId}::uuid`,
        () => sql`DELETE FROM media_items WHERE id = ${seed.seriesId}::uuid`,
    ];
    for (const step of steps) {
        // Best effort: a failed step must not hide the test's own verdict.
        await step().catch((err: Error) => console.warn('[resume-handoff] cleanup:', err.message));
    }
}

interface TabSession {
    id: string;
    deviceId: string;
    entryMode: string | null;
}

/** The tab's own play session on `mediaId` (any device but the TV). */
async function tabSessionFor(mediaId: string, tvDeviceId: string): Promise<TabSession | null> {
    const rows = await sql<{ id: string; device_id: string; entry_mode: string | null }[]>`
        SELECT ps.id::text AS id, ps.device_id, ps.entry_mode
        FROM play_sessions ps
        JOIN users u ON u.id = ps.user_id
        WHERE u.username = ${TEST_USER}
          AND ps.media_id = ${mediaId}::uuid
          AND ps.device_id <> ${tvDeviceId}
        ORDER BY ps.started_at DESC
        LIMIT 1
    `;
    const row = rows[0];
    return row ? { id: row.id, deviceId: row.device_id, entryMode: row.entry_mode } : null;
}

async function waitForTabSession(mediaId: string, tvDeviceId: string): Promise<TabSession> {
    await expect
        .poll(async () => (await tabSessionFor(mediaId, tvDeviceId))?.id ?? null, {
            timeout: 30_000,
            message: 'the tab never registered a play session',
        })
        .not.toBeNull();
    return (await tabSessionFor(mediaId, tvDeviceId))!;
}

/** Open a watch URL with a no-op play() so the fixture stays paused. */
async function openPausedTab(page: Page, url: string, mediaId: string): Promise<void> {
    await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = async function (): Promise<void> {};
    });
    await page.goto(url);
    await expectHydrated(page);
    await expect(page.getByRole('toolbar', { name: 'Video controls' })).toBeVisible();
    await expect
        .poll(
            () =>
                page
                    .locator('video')
                    .evaluate(
                        (video: HTMLVideoElement) =>
                            video.currentSrc.length > 0 &&
                            video.readyState >= HTMLMediaElement.HAVE_METADATA,
                    )
                    .catch((error: unknown) => {
                        // A cold dev server may reload the page once while optimising deps.
                        if (/Execution context was destroyed|navigation/i.test(String(error))) {
                            return false;
                        }
                        throw error;
                    }),
            { timeout: 30_000 },
        )
        .toBe(true);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    expect(page.url()).toContain(`/watch/${mediaId}`);
}

let eventSeq = 0;

async function startRemote(
    request: APIRequestContext,
    seed: Seed,
    mediaId: string,
    entry: 'continue' | 'next_up' | 'autoplay' | 'resume' | 'explicit',
): Promise<string> {
    eventSeq = 0;
    const r = await request.post('/api/play-sessions', {
        data: {
            mediaId,
            deviceId: seed.tvDeviceId,
            clientInfo: { name: TV_NAME, client: 'Apple TV' },
            capabilities: CAPABILITIES,
            entry,
        },
    });
    expect(r.status(), await r.text()).toBe(201);
    return ((await r.json()) as { playbackSessionId: string }).playbackSessionId;
}

async function beat(
    request: APIRequestContext,
    sessionId: string,
    body: {
        positionMs: number;
        status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
        sessionElapsedMs: number;
        endReason?: 'completion';
    },
): Promise<void> {
    eventSeq += 1;
    const r = await request.put(`/api/play-sessions/${sessionId}`, {
        data: { ...body, eventSeq },
    });
    expect(r.status(), await r.text()).toBeLessThan(300);
}

/**
 * The second device finishes A (linear, continue) and autoplays into B,
 * pausing at 3 s with >= 60 s of engagement so the position is durable.
 */
async function remoteFinishesAThenPausesInB(
    request: APIRequestContext,
    seed: Seed,
): Promise<string[]> {
    const sessions: string[] = [];
    const sessionA = await startRemote(request, seed, seed.a, 'continue');
    sessions.push(sessionA);
    await beat(request, sessionA, { positionMs: 4000, status: 'ACTIVE', sessionElapsedMs: 61_000 });
    await beat(request, sessionA, {
        positionMs: 4900,
        status: 'COMPLETED',
        sessionElapsedMs: 62_000,
        endReason: 'completion',
    });

    const sessionB = await startRemote(request, seed, seed.b, 'autoplay');
    sessions.push(sessionB);
    await beat(request, sessionB, { positionMs: 1000, status: 'ACTIVE', sessionElapsedMs: 61_000 });
    await beat(request, sessionB, { positionMs: 2000, status: 'ACTIVE', sessionElapsedMs: 62_000 });
    await beat(request, sessionB, { positionMs: 3000, status: 'PAUSED', sessionElapsedMs: 63_000 });

    // The tab can only follow what the server holds durably.
    await expect
        .poll(
            async () => {
                const rows = await sql<{ position_ms: string | number | null }[]>`
                    SELECT position_ms FROM user_media_events
                    WHERE media_id = ${seed.b}::uuid AND session_id = ${sessionB}
                      AND source = 'lumastra-player' AND repudiated_at IS NULL
                    ORDER BY occurred_at DESC LIMIT 1
                `;
                return rows[0] ? Number(rows[0].position_ms) : null;
            },
            { timeout: 15_000, message: 'the remote progress in B was not written durably' },
        )
        .toBe(3000);
    return sessions;
}

/** Leave and come back: a window blur, a wait past the 3 s threshold, then focus. */
async function leaveAndReturn(page: Page): Promise<void> {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(3300);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

function progressSlider(page: Page) {
    return page.getByRole('slider', { name: 'Video progress', exact: true });
}

test.describe('implicit resume handoff', () => {
    test.setTimeout(90_000);

    test('a paused linear tab follows the second device into the next episode', async ({
        page,
        request,
    }) => {
        const seed = await seedSeries();
        try {
            // 1. The tab opens A as a linear entry and stays paused.
            await openPausedTab(page, `/watch/${seed.a}?entry=next_up`, seed.a);
            const tab = await waitForTabSession(seed.a, seed.tvDeviceId);
            expect(tab.entryMode, 'the tab session records its next_up entry').toBe('next_up');
            // The landing param is dropped from the address bar.
            expect(page.url()).not.toContain('entry=');

            // 2. The second device finishes A and pauses in B, after the tab's last action.
            await page.waitForTimeout(1500);
            await remoteFinishesAThenPausesInB(request, seed);

            // 3. The viewer comes back to the tab.
            const handoffAsked = page.waitForResponse(
                (res) =>
                    res.url().includes('/me/resume-handoff') && res.request().method() === 'GET',
                { timeout: 15_000 },
            );
            await leaveAndReturn(page);
            const answer = await handoffAsked;
            expect(answer.status()).toBe(200);

            // 4. The tab lands on B, paused at the TV's position, with the Back toast.
            await expect(page).toHaveURL(new RegExp(`/watch/${seed.b}`), { timeout: 20_000 });
            await expect(page.getByText('Continued at S01E02 · 0:03 from Living room')).toBeVisible(
                {
                    timeout: 20_000,
                },
            );
            await expect(page.getByRole('button', { name: 'Back to S01E01' })).toBeVisible();

            await expect
                .poll(
                    () =>
                        page
                            .locator('video')
                            .evaluate(
                                (video: HTMLVideoElement) =>
                                    video.currentSrc.length > 0 &&
                                    video.readyState >= HTMLMediaElement.HAVE_METADATA,
                            )
                            .catch(() => false),
                    { timeout: 20_000 },
                )
                .toBe(true);
            await expect(page.locator('video')).toHaveJSProperty('paused', true);
            await expect
                .poll(
                    () => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
                    {
                        timeout: 15_000,
                    },
                )
                .toBeGreaterThan(2.5);
            const t = await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
            expect(t).toBeLessThan(3.6);
            await expect(progressSlider(page)).toHaveAttribute(
                'aria-valuenow',
                /^(2\.[5-9]|3(\.[0-5])?)/,
            );

            // The tab's player really is on B: it opened its own play session there.
            const onB = await waitForTabSession(seed.b, seed.tvDeviceId);
            expect(onB.deviceId).toBe(tab.deviceId);

            // 5. Back returns to A.
            // The player's control overlay sits over the toast corner, so dispatch the click on the button itself.
            await page.getByRole('button', { name: 'Back to S01E01' }).dispatchEvent('click');
            await expect(page).toHaveURL(new RegExp(`/watch/${seed.a}`), { timeout: 20_000 });
        } finally {
            await cleanup(seed);
        }
    });

    test('an explicit tab does not move under the same remote activity', async ({
        page,
        request,
    }) => {
        const seed = await seedSeries();
        try {
            // No `entry` param: the viewer picked this episode themselves.
            await openPausedTab(page, `/watch/${seed.a}`, seed.a);
            const tab = await waitForTabSession(seed.a, seed.tvDeviceId);
            expect(tab.entryMode ?? 'explicit', 'an explicit pick records no linear entry').toBe(
                'explicit',
            );

            await page.waitForTimeout(1500);
            await remoteFinishesAThenPausesInB(request, seed);
            await leaveAndReturn(page);

            // Give a (wrongly) triggered check ample time to ask, answer and navigate.
            await page.waitForTimeout(4000);
            expect(page.url()).toContain(`/watch/${seed.a}`);
            expect(page.url()).not.toContain(seed.b);
            await expect(page.getByText(/^Continued at /)).toHaveCount(0);
            await expect(page.locator('video')).toHaveJSProperty('paused', true);
        } finally {
            await cleanup(seed);
        }
    });
});
