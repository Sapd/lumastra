// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /j (Jellyfin-compat) helpers for e2e specs: seed a playable movie, get a real
 * /j token via Quick Connect, and ask PlaybackInfo for an HLS transcode.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { APIRequestContext } from '@playwright/test';
import { expect } from '../fixtures/auth';

/** Tracked 240 s h264/AAC fixture (the long test video is gitignored). */
export const LONG_FIXTURE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../fixtures/watch-together/wt-movie-240s.mp4',
);
export const LONG_FIXTURE_SECONDS = 240;

/** A client that can play nothing directly: every playback is an HLS transcode. */
export const TRANSCODE_ONLY_PROFILE = {
    Name: 'E2E transcode-only',
    MaxStreamingBitrate: 120_000_000,
    DirectPlayProfiles: [],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            AudioCodec: 'aac',
            VideoCodec: 'h264',
            Context: 'Streaming',
            Protocol: 'hls',
            MaxAudioChannels: '2',
        },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [],
};

export function embyAuthorization(deviceId: string): string {
    return `MediaBrowser Client="E2E", Device="E2E", DeviceId="${deviceId}", Version="1.0"`;
}

/** Seed `itemId` as an active movie backed by exactly the long fixture file (idempotent). */
export async function seedLongFixtureMovie(itemId: string, title: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) return;
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
    try {
        await sql`
            INSERT INTO media_items (id, title, media_type, file_path, has_files, runtime_seconds, status, created_at, updated_at)
            VALUES (${itemId}, ${title}, 'movie', ${LONG_FIXTURE}, true, ${LONG_FIXTURE_SECONDS}, 'active', NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET file_path = ${LONG_FIXTURE}, has_files = true, updated_at = NOW()
        `;
        const fileRows = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path) VALUES (${LONG_FIXTURE})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        if (fileRows[0]?.id) {
            // Exactly this one file: a stale link from an earlier run would be
            // the version the transcode picks.
            await sql`
                DELETE FROM media_file_items
                WHERE media_item_id = ${itemId} AND file_id <> ${fileRows[0].id}
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRows[0].id}, ${itemId})
                ON CONFLICT DO NOTHING
            `;
        }
    } finally {
        await sql.end();
    }
}

/** Quick Connect: the "TV" initiates, the forward-auth admin approves, the TV gets a token. */
export async function jellyfinToken(request: APIRequestContext, deviceId: string): Promise<string> {
    const embyAuth = embyAuthorization(deviceId);
    const initiate = await request.post('/j/QuickConnect/Initiate', {
        headers: { 'X-Emby-Authorization': embyAuth },
    });
    expect(initiate.ok(), `QuickConnect/Initiate ${initiate.status()}`).toBe(true);
    const { Secret, Code } = (await initiate.json()) as { Secret: string; Code: string };

    const authorize = await request.post('/api/jellyfin-connect/quick-connect/authorize', {
        data: { code: Code },
    });
    expect(authorize.ok(), `quick-connect/authorize ${authorize.status()}`).toBe(true);

    const auth = await request.post('/j/Users/AuthenticateWithQuickConnect', {
        headers: { 'X-Emby-Authorization': embyAuth, 'X-Forwarded-User': '' },
        data: { Secret },
    });
    expect(auth.ok(), `AuthenticateWithQuickConnect ${auth.status()}`).toBe(true);
    const token = ((await auth.json()) as { AccessToken?: string }).AccessToken;
    expect(token).toBeTruthy();
    return token!;
}

/** POST PlaybackInfo (optionally resuming at `startSeconds`); returns the /j TranscodingUrl. */
export async function transcodingUrl(
    request: APIRequestContext,
    token: string,
    itemId: string,
    startSeconds = 0,
): Promise<{ url: string; playSessionId: string }> {
    const query = startSeconds > 0 ? `?StartTimeTicks=${startSeconds * 10_000_000}` : '';
    const info = await request.post(`/j/Items/${itemId}/PlaybackInfo${query}`, {
        headers: { 'X-Emby-Token': token, 'X-Forwarded-User': '' },
        data: { DeviceProfile: TRANSCODE_ONLY_PROFILE },
    });
    expect(info.ok(), `PlaybackInfo ${info.status()}`).toBe(true);
    const body = (await info.json()) as {
        PlaySessionId: string;
        MediaSources: Array<{ TranscodingUrl?: string }>;
    };
    const path = body.MediaSources[0]?.TranscodingUrl;
    expect(path, 'a transcode-only profile must get a TranscodingUrl').toBeTruthy();
    const playSessionId = new URL(path!, 'http://x').searchParams.get('PlaySessionId');
    expect(playSessionId).toBeTruthy();
    return { url: `/j${path}`, playSessionId: playSessionId! };
}

/**
 * End a /j playback the way a client does: report it Stopped (closes the
 * play_sessions row that counts against the user's stream limit) and stop its
 * transcode. Without this, sessions left by one spec push the next spec's
 * viewer over the limit.
 */
export async function endJellyfinPlayback(
    request: APIRequestContext,
    token: string,
    itemId: string,
    playSessionId: string,
): Promise<void> {
    const stopped = await request.post('/j/Sessions/Playing/Stopped', {
        headers: { 'X-Emby-Token': token, 'X-Forwarded-User': '' },
        data: { ItemId: itemId, PlaySessionId: playSessionId, PositionTicks: 0 },
    });
    expect(stopped.status(), await stopped.text()).toBe(204);
    const transcode = await request.delete(`/api/admin/ffmpeg-jobs?playSessionId=${playSessionId}`);
    // Stopped may already have released the encoder; both outcomes leave no
    // active job. A rejected cleanup (notably CSRF 403) must fail the fixture.
    expect([200, 404], await transcode.text()).toContain(transcode.status());
}
