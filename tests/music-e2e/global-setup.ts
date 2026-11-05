// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * globalSetup for tests/playwright/playwright.music.config.ts. Runs after the webServer is up:
 *   1. an admin row if there is none (first-run setup must be complete before a
 *      forward-auth request auto-provisions a user), and the listener's user row;
 *   2. the previous run's rows removed, the fixture tracks generated + seeded;
 *   3. the fault proxy started in front of the server (all browser traffic);
 *   4. the listener's playback preferences pinned: crossfade on at 16 beats (8 s at
 *      the fixtures' 120 BPM — a short, deterministic fade), autoplay off (no smart
 *      items appearing in the queue mid-assertion; mood radio turns it on itself).
 */

import type http from 'http';
import { MUSIC_USER, musicPort, proxyPort, serverUrl, webUrl } from './music-env';
import { startFaultProxy } from './music-proxy';
import { cleanupOldRows, connect, seedCatalog, XF } from './music-seed';

function headers(): Record<string, string> {
    return {
        'X-Forwarded-User': MUSIC_USER,
        'X-Forwarded-Groups': 'Users',
        Origin: webUrl(),
        'Content-Type': 'application/json',
    };
}

async function waitForApp(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${serverUrl()}/api/me/playback-preferences`, {
                headers: headers(),
            });
            last = String(res.status);
            if (res.status === 200) return;
        } catch (e) {
            last = String(e);
        }
        await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`app never answered playback-preferences with 200 (last: ${last})`);
}

/**
 * The first-run "admin exists" check is cached for a few seconds: until it sees the
 * seeded admin, page requests bounce through /setup (a redirect loop for the browser).
 */
async function waitForPages(): Promise<void> {
    const deadline = Date.now() + 90_000;
    let last = '';
    while (Date.now() < deadline) {
        const res = await fetch(`${serverUrl()}/music`, {
            headers: headers(),
            redirect: 'manual',
        }).catch((e: Error) => ({ status: e.message }) as unknown as Response);
        last = String(res.status);
        if (res.status === 200) return;
        await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`/music never answered 200 (last: ${last})`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
    const sql = connect();
    try {
        const [{ admins }] = await sql<{ admins: number }[]>`
            SELECT count(*)::int AS admins FROM users WHERE is_admin AND deleted_at IS NULL
        `;
        if (admins === 0) {
            await sql`
                INSERT INTO users (username, is_admin, groups, groups_updated_at)
                VALUES ('music-e2e-admin', true, ${['Users', 'admin']}, NOW())
                ON CONFLICT (username) DO UPDATE SET is_admin = true
            `;
        }
        await sql`
            INSERT INTO users (username, is_admin, groups, groups_updated_at)
            VALUES (${MUSIC_USER}, false, ${['Users']}, NOW())
            ON CONFLICT (username) DO UPDATE
            SET is_admin = false, groups = ${['Users']}, groups_updated_at = NOW(), deleted_at = NULL
        `;
        // Tabs open and close dozens of play sessions; a closed tab's session keeps
        // counting for a while (see the WT e2e global-setup).
        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams, updated_by)
            VALUES (${MUSIC_USER}, 100, 'music-e2e')
            ON CONFLICT (user_id) DO UPDATE SET max_concurrent_streams = 100, updated_at = NOW()
        `;
        await cleanupOldRows(sql);
        const catalog = await seedCatalog(sql);
        console.log(
            `[music-e2e] seeded ${catalog.xfade.length + catalog.long.length + catalog.search.length + 12} tracks`,
        );
    } finally {
        await sql.end();
    }

    const proxy: http.Server = await startFaultProxy(proxyPort(), musicPort());
    console.log(`[music-e2e] fault proxy ${webUrl()} -> ${serverUrl()}`);

    await waitForApp();
    await waitForPages();
    const res = await fetch(`${serverUrl()}/api/me/playback-preferences`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({
            musicCrossfadeEnabled: true,
            musicCrossfadeBeats: XF.beats,
            musicAutoplayEnabled: false,
        }),
    });
    if (!res.ok) {
        throw new Error(`PATCH playback-preferences: ${res.status} ${await res.text()}`);
    }

    return async () => {
        proxy.closeAllConnections();
        await new Promise<void>((r) => proxy.close(() => r()));
    };
}
