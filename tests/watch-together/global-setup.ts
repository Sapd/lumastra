// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * globalSetup for playwright.watch-together.config.ts.
 *
 * Runs AFTER the config's webServer is up (Playwright starts plugins first), so it
 * can talk to the app as well as to the database:
 *   1. library root holding only the WT fixtures (+ its library_groups row: FK);
 *   2. an admin row if there is none — first-run setup must be complete before a
 *      forward-auth request auto-provisions a user;
 *   3. user rows for the party members of every worker (non-admin, group Users);
 *   4. leftovers of earlier runs removed (seeded media rows, parties).
 * The server poller reads GET /api/watch-together/{code} with forward-auth headers,
 * so no PAT is needed (FEATURE_USER_PATS is off by default and CI does not set it).
 */

import { chromium } from '@playwright/test';
import { allWtUsers, WT_USERS, webUrl } from './wt-env';
import {
    cleanupOldRows,
    connect,
    FIXTURE_DIR,
    LIBRARY_GROUP_ID,
    LIBRARY_PATH_ID,
    seedMovie,
} from './wt-seed';

function headersFor(user: string): Record<string, string> {
    return { 'X-Forwarded-User': user, 'X-Forwarded-Groups': 'Users', Origin: webUrl() };
}

async function waitForApp(user: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${webUrl()}/api/watch-together/parties`, {
                headers: headersFor(user),
            });
            last = String(res.status);
            if (res.status === 200) return;
        } catch (e) {
            last = String(e);
        }
        await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(
        `app never answered GET /api/watch-together with 200 as ${user} (last: ${last})`,
    );
}

/** End a party an interrupted run left behind (the per-user "active session" pointer). */
async function endStaleParty(user: string): Promise<void> {
    const res = await fetch(`${webUrl()}/api/watch-together/parties`, {
        headers: headersFor(user),
    });
    const body = (await res.json().catch(() => null)) as { party?: { code?: string } } | null;
    const code = body?.party?.code;
    if (code) {
        await fetch(`${webUrl()}/api/watch-together/${code}`, {
            method: 'DELETE',
            headers: headersFor(user),
        });
    }
}

/**
 * Load the watch page once in a real browser before the first scenario. A cold dev
 * server compiles the route and optimises client deps on first use: the very first
 * /watch SSR answered 500 and the first video never became ready within 90 s, which
 * failed whichever scenario happened to run first.
 */
async function warmUp(itemId: string): Promise<void> {
    const browser = await chromium.launch({
        args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
    try {
        const ctx = await browser.newContext({
            baseURL: webUrl(),
            extraHTTPHeaders: { 'X-Forwarded-User': WT_USERS[0], 'X-Forwarded-Groups': 'Users' },
        });
        const page = await ctx.newPage();
        let lastError = '';
        for (let attempt = 1; attempt <= 6; attempt++) {
            try {
                const res = await page.goto(`/watch/${itemId}`, { timeout: 120_000 });
                if (res && res.status() >= 500) throw new Error(`HTTP ${res.status()}`);
                await page.waitForFunction(
                    () => (document.querySelector('video')?.readyState ?? 0) >= 2,
                    undefined,
                    { timeout: 60_000 },
                );
                // Party pages too (/party/{code} 404s for an unknown code — still compiles).
                await page.goto('/party/WARMUP', { timeout: 60_000 }).catch(() => {});
                console.log(`[wt-setup] dev server warm after ${attempt} attempt(s)`);
                return;
            } catch (e) {
                lastError = String(e).slice(0, 200);
                await new Promise((r) => setTimeout(r, 3_000));
            }
        }
        throw new Error(`watch page never became playable during warm-up: ${lastError}`);
    } finally {
        await browser.close();
    }
}

export default async function globalSetup(): Promise<void> {
    const sql = connect();
    let warmItem: string;
    try {
        await sql`
            INSERT INTO library_groups (id, name, description)
            VALUES (${LIBRARY_GROUP_ID}, 'WT Web E2E', 'Watch Together web e2e fixtures')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO library_paths (id, path, media_type, library_group_id, enabled)
            VALUES (${LIBRARY_PATH_ID}, ${FIXTURE_DIR}, 'movie', ${LIBRARY_GROUP_ID}, true)
            ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, enabled = true
        `;

        const [{ admins }] = await sql<{ admins: number }[]>`
            SELECT count(*)::int AS admins FROM users WHERE is_admin AND deleted_at IS NULL
        `;
        if (admins === 0) {
            await sql`
                INSERT INTO users (username, is_admin, groups, groups_updated_at)
                VALUES ('wt-e2e-admin', true, ${['Users', 'admin']}, NOW())
                ON CONFLICT (username) DO UPDATE SET is_admin = true
            `;
        }
        for (const u of allWtUsers()) {
            await sql`
                INSERT INTO users (username, is_admin, groups, groups_updated_at)
                VALUES (${u}, false, ${['Users']}, NOW())
                ON CONFLICT (username) DO UPDATE
                SET is_admin = false, groups = ${['Users']}, groups_updated_at = NOW(), deleted_at = NULL
            `;
        }
        // Two users start dozens of streams back to back, and a closed tab's play
        // session keeps counting until it ages out: with the default limit of 2 the
        // next scenario's player showed "Stream limit reached (2 of 2)" (POST
        // /api/play-sessions 422). A per-user policy row wins over every default; the
        // limit stays enforced, just out of the way.
        for (const u of allWtUsers()) {
            await sql`
                INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_by)
                VALUES (${u}, 100, 'wt-web-e2e')
                ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 100, updated_at = NOW()
            `;
        }
        await cleanupOldRows(sql);
        warmItem = (await seedMovie(sql, 'warm-up')).id;
    } finally {
        await sql.end();
    }

    // The admin-exists check is cached ~10 s; waitForApp retries through it.
    await waitForApp(WT_USERS[0]);
    for (const u of allWtUsers()) {
        await waitForApp(u);
        await endStaleParty(u);
    }
    await warmUp(warmItem);
}
