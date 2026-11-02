// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { GlideClient } from '@valkey/valkey-glide';

/**
 * Clears the per-user stream-token create window for the e2e test user.
 *
 * `POST /api/v1/playback/stream-tokens` allows 10 creates per user per sliding
 * minute, kept in Valkey under `ratelimit:streamtoken:<username>`
 * (src/lib/server/api/defs/playback/stream-tokens/index.ts). Every spec mints
 * as the same user, and streaming-sessions-security drives that window to 429
 * on purpose — so whichever block ran next inherited a spent budget and
 * skipped as "rate limited". Clearing the key gives each block the budget the
 * property it tests assumes, instead of an ordering accident.
 *
 * Talks to the server's own Valkey (CACHE_URL, including its DB index). Throws
 * if Valkey is unreachable: a silent no-op would bring the skips back.
 */
export async function resetStreamTokenRateLimit(
    username: string = (process.env.TEST_USER || 'TestUser').toLowerCase(),
): Promise<void> {
    const url = new URL(process.env.CACHE_URL || 'redis://localhost:6379/0');
    const databaseId = Number(url.pathname.replace(/^\//, '') || '0');
    const client = await GlideClient.createClient({
        addresses: [{ host: url.hostname, port: Number(url.port || '6379') }],
        requestTimeout: 5000,
        clientName: 'e2e-rate-limit-reset',
        ...(Number.isInteger(databaseId) && databaseId > 0 ? { databaseId } : {}),
        ...(url.password
            ? {
                  credentials: {
                      // Raw, not percent-decoded: the same as the server's
                      // parseRedisUrl (src/lib/server/cache/valkey.ts).
                      username: url.username || 'default',
                      password: url.password,
                  },
              }
            : {}),
    });
    try {
        await client.del([`ratelimit:streamtoken:${username}`]);
    } finally {
        client.close();
    }
}
