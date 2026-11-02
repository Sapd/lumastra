// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playwright Global Setup
 *
 * Creates test data in the database before running e2e tests.
 * This ensures tests work in CI environments with fresh databases.
 */

import { resolve, dirname, relative, isAbsolute, sep } from 'path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { GlideClient, TimeUnit } from '@valkey/valkey-glide';

const TEST_USER = process.env.TEST_USER || 'TestUser';
/**
 * The username as the app stores it.
 *
 * forward-auth lowercases every identity it reads ("Normalize username to
 * lowercase for consistent storage/lookup across all tables"), so the row the
 * running server creates for `TestUser` is `testuser`. Seeding the mixed-case
 * spelling straight into `users` bypassed that and produced a SECOND row the
 * app would never have written — and then the two identities drifted apart:
 * `verifyPlaySessionOwnership()` compares `users.username` to the authenticated
 * (lowercased) name with `===`, so a play session recorded against `TestUser`
 * answered 404 to every HLS variant/segment request made by `testuser`.
 * Seed the canonical spelling; the forward-auth HEADERS keep the mixed case,
 * which is what a real IdP sends.
 */
const TEST_USER_ROW = TEST_USER.toLowerCase();
const TEST_GROUPS = ['Users', 'Librarians', 'admin'];
// Non-admin test user (for permission testing)
const NON_ADMIN_USER = 'TestUserNonAdmin';
/** Canonical (lowercased) spelling — see TEST_USER_ROW. */
const NON_ADMIN_USER_ROW = NON_ADMIN_USER.toLowerCase();
const NON_ADMIN_GROUPS = ['Users']; // No admin groups
// Mock Jellyfin user ID for testing (UUID format)
const TEST_JELLYFIN_USER_ID = 'e2e-test-user-0000-0000-000000000001';
const NON_ADMIN_JELLYFIN_USER_ID = 'e2e-test-user-0000-0000-000000000002';

// Test media item backed by the synthetic fixture file
// RFC 9562 UUIDs: PostgreSQL accepts zero version/variant bits, but API z.uuid() does not.
const TEST_MEDIA_ITEM_ID = 'e2e00000-0000-4000-8000-000000000001';
const TEST_RELATED_MEDIA_ITEM_ID = 'e2e00000-0000-4000-8000-000000000006';
// Absolute path — resolved at runtime so it works in any checkout location
const TEST_FIXTURE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/test-video.mp4',
);
// The directory holding the fixtures, registered as a library root so the
// fail-closed containment guard in media-path-resolver.ts permits serving them.
const TEST_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TEST_LIBRARY_PATH_ID = 'e2e00000-0000-4000-8000-11b0a7000001';
const TEST_LIBRARY_GROUP_ID = 'e2e00000-0000-4000-8000-11b0a7000002';

// Two combined files of two episodes each — play-session-progress.api.spec.ts
const TEST_EP1_ID = 'e2e00000-0000-4000-8000-000000000002';
const TEST_EP2_ID = 'e2e00000-0000-4000-8000-000000000003';
const TEST_EP3_ID = 'e2e00000-0000-4000-8000-000000000004';
const TEST_EP4_ID = 'e2e00000-0000-4000-8000-000000000005';

// Music test hierarchy: artist → album → tracks
// `music…` is not a UUID — m, u, s and i are not hex digits — so every one of
// these inserts died on `invalid input syntax for type uuid`, the seed block's
// catch logged "migration may be pending", and the music specs then ran against
// an empty library. `c0ffee` is all-hex and just as recognisable.
const TEST_MUSIC_ARTIST_ID = 'e2e00000-0000-4000-8000-c0ffee000001';
const TEST_MUSIC_ALBUM_ID = 'e2e00000-0000-4000-8000-c0ffee000002';
const TEST_MUSIC_TRACK_ID = 'e2e00000-0000-4000-8000-c0ffee000003';
const TEST_MUSIC_TRACK_2_ID = 'e2e00000-0000-4000-8000-c0ffee000004';
// `fixtures/music` ships one file, sample.flac; the per-album directory these
// constants used to point at has never existed, so every seeded track named a
// path with nothing behind it. Both tracks share the one real file, the same way
// the two episode fixtures share one video.
const TEST_MUSIC_FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/music');
const TEST_MUSIC_TRACK_FILE = resolve(TEST_MUSIC_FIXTURE_DIR, 'sample.flac');

export {
    TEST_MEDIA_ITEM_ID,
    TEST_RELATED_MEDIA_ITEM_ID,
    TEST_FIXTURE_PATH,
    TEST_FIXTURE_DIR,
    TEST_LIBRARY_PATH_ID,
    TEST_LIBRARY_GROUP_ID,
    TEST_EP1_ID,
    TEST_EP2_ID,
    TEST_EP3_ID,
    TEST_EP4_ID,
    TEST_MUSIC_ARTIST_ID,
    TEST_MUSIC_ALBUM_ID,
    TEST_MUSIC_TRACK_ID,
    TEST_MUSIC_TRACK_2_ID,
};

// Parse Redis/Valkey URL to extract connection details
function parseRedisUrl(
    url: string,
): { host: string; port: number; username?: string; password?: string } | null {
    try {
        if (!url) return null;
        const urlObj = new URL(url);
        return {
            host: urlObj.hostname,
            port: parseInt(urlObj.port || '6379', 10),
            username: urlObj.username || undefined,
            password: urlObj.password || undefined,
        };
    } catch {
        return null;
    }
}

async function seedMusicTestData(sql: postgres.Sql): Promise<void> {
    // music.queries.ts states the hierarchy explicitly:
    //   Artist → media_type = 'artist', Album → 'album', Track → 'track'.
    // This seed used 'music'/'music'/'audio', a vocabulary no query matches, so
    // every browse endpoint returned an empty page and every detail endpoint 404'd.
    // Artist (no parent)
    await sql`
        INSERT INTO media_items (id, title, media_type, has_files, status, created_at, updated_at, custom_metadata)
        VALUES (
            ${TEST_MUSIC_ARTIST_ID},
            'Test Artist',
            'artist',
            TRUE, 'active',
            NOW(), NOW(),
            '{"genres": ["Electronic"]}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET has_files = TRUE, status = 'active', updated_at = NOW()
    `;

    // Album (parent = artist)
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, created_at, updated_at, custom_metadata)
        VALUES (
            ${TEST_MUSIC_ALBUM_ID},
            'Test Album',
            'album',
            ${TEST_MUSIC_ARTIST_ID},
            TRUE, 'active',
            NOW(), NOW(),
            '{"genres": ["Electronic"], "release_year": 2025}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET parent_id = ${TEST_MUSIC_ARTIST_ID}, has_files = TRUE, status = 'active', updated_at = NOW()
    `;

    // Track 1 (parent = album) — with full audio features
    const track1Path = TEST_MUSIC_TRACK_FILE;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, parent_id, file_path, sort_order,
            runtime_seconds, has_files, status, created_at, updated_at, custom_metadata
        )
        VALUES (
            ${TEST_MUSIC_TRACK_ID},
            'Test Track 01',
            'track',
            ${TEST_MUSIC_ALBUM_ID},
            ${track1Path},
            1,
            2,
            TRUE, 'active',
            NOW(), NOW(),
            ${sql.json({
                artist: 'Test Artist',
                album: 'Test Album',
                track_number: 1,
                genres: ['Electronic'],
                release_year: 2025,
                essentia: {
                    bpm: 120,
                    key: 'C',
                    scale: 'major',
                    energy: 0.75,
                    danceability: 0.8,
                    loudness_lufs: -14,
                    beat_grid: [0, 500, 1000, 1500],
                    downbeats: [0, 2000],
                    intro_end_ms: 500,
                    outro_start_ms: 1500,
                    energy_curve: [0.5, 0.7, 0.8, 0.6],
                },
                lyrics: {
                    synced: '[00:00.50]Test lyric line one\n[00:01.00]Test lyric line two',
                    plain: 'Test lyric line one\nTest lyric line two',
                },
            } as never)}
        )
        ON CONFLICT (id) DO UPDATE SET
            parent_id = ${TEST_MUSIC_ALBUM_ID},
            file_path = ${track1Path},
            has_files = TRUE,
            status = 'active',
            custom_metadata = EXCLUDED.custom_metadata,
            updated_at = NOW()
    `;

    // Track 2 (parent = album)
    const track2Path = TEST_MUSIC_TRACK_FILE;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, parent_id, file_path, sort_order,
            runtime_seconds, has_files, status, created_at, updated_at, custom_metadata
        )
        VALUES (
            ${TEST_MUSIC_TRACK_2_ID},
            'Test Track 02',
            'track',
            ${TEST_MUSIC_ALBUM_ID},
            ${track2Path},
            2,
            2,
            TRUE, 'active',
            NOW(), NOW(),
            ${sql.json({
                artist: 'Test Artist',
                album: 'Test Album',
                track_number: 2,
                genres: ['Electronic'],
                release_year: 2025,
                essentia: {
                    bpm: 125,
                    key: 'G',
                    scale: 'major',
                    energy: 0.65,
                    danceability: 0.7,
                    loudness_lufs: -12,
                },
            } as never)}
        )
        ON CONFLICT (id) DO UPDATE SET
            parent_id = ${TEST_MUSIC_ALBUM_ID},
            file_path = ${track2Path},
            has_files = TRUE,
            status = 'active',
            custom_metadata = EXCLUDED.custom_metadata,
            updated_at = NOW()
    `;

    // Create media_files + media_file_items entries for both tracks
    for (const [trackId, trackPath] of [
        [TEST_MUSIC_TRACK_ID, track1Path],
        [TEST_MUSIC_TRACK_2_ID, track2Path],
    ]) {
        const fileRows = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path)
            VALUES (${trackPath})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        const fileId = fileRows[0]?.id;
        if (fileId) {
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}, ${trackId})
                ON CONFLICT DO NOTHING
            `;
        }
    }

    console.log(
        '[Setup] Music test data seeded:',
        `artist=${TEST_MUSIC_ARTIST_ID}`,
        `album=${TEST_MUSIC_ALBUM_ID}`,
        `tracks=${TEST_MUSIC_TRACK_ID}, ${TEST_MUSIC_TRACK_2_ID}`,
    );
}

/**
 * Wait until the running app stops sending HTML page requests to /setup.
 *
 * WHY THIS EXISTS — a 10-second race that made a whole suite time-dependent.
 *
 * forward-auth.ts caches `anAdminExists()`: `true` forever, `false` for
 * ADMIN_EXISTS_FALSE_TTL_MS = 10_000. A request against a freshly booted server
 * on an empty database caches FALSE. This file then creates the admin with
 * DIRECT SQL, so `invalidateAdminExistsCache()` — which the /setup wizard calls
 * — never fires. For up to ten seconds afterwards every HTML page request hits
 * the first-run guard and 303s to /setup, which 303s back, and Playwright gives
 * up with "Max redirect count exceeded".
 *
 * The full suite runs ~9 minutes, so the window shuts during its first seconds
 * and nobody noticed. A SHORT run lands inside it: a 6-file run finished in 33
 * seconds and its first spec failed exactly this way, while the same file
 * passed in the full suite minutes earlier. That is the worst shape of flake —
 * pass/fail decided by how much else you happened to run.
 *
 * One request after the TTL expires re-checks, finds the admin, and caches
 * `true` permanently. So this only has to outlast the window once.
 *
 * BEST-EFFORT ON PURPOSE. Playwright's ordering of webServer vs globalSetup is
 * not something this file should depend on, so a server that never answers is
 * reported and skipped rather than failing setup — that case leaves behaviour
 * exactly as it was before this function existed. What it must never do is fail
 * the run for being unable to tidy a cache.
 */
async function waitForFirstRunRedirectToClear(): Promise<void> {
    // MUST resolve the port the same way playwright.config.ts does. The first
    // version of this function hardcoded 5173 while the config had just gained
    // PLAYWRIGHT_PORT, so in the ratchet job (port 5273) this polled a port
    // nothing was listening on, burned its whole 30s budget and logged the
    // "not reachable" branch. The job passed anyway — because 30s of accidental
    // waiting outlasts the 10s TTL this exists to outlast. A fix that works by
    // coincidence is not a fix, and it would have stopped working the moment
    // the budget was tuned down.
    const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
    // 3x the 10s TTL, so an ordinary expiry has ample room.
    const deadline = Date.now() + 30_000;
    let everAnswered = false;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(baseUrl + '/', {
                redirect: 'manual',
                headers: {
                    // Same identity the specs use; without it the probe would
                    // exercise a different auth path than the tests do.
                    'X-Forwarded-User': TEST_USER,
                    'X-Forwarded-Groups': TEST_GROUPS.join('|'),
                },
            });
            everAnswered = true;
            const location = res.headers.get('location') ?? '';
            if (!location.startsWith('/setup')) {
                // The URL is in the message on purpose: the previous version
                // polled the wrong port and nothing in the log said so, which
                // left "did the wait work?" to be inferred from step timings.
                console.log(`[Setup] App at ${baseUrl} is past first-run onboarding.`);
                return;
            }
        } catch {
            // Server not up (yet, or at all in this phase) — keep trying until
            // the deadline; `everAnswered` records which case this was.
        }
        await new Promise((r) => setTimeout(r, 500));
    }

    console.warn(
        everAnswered
            ? `[Setup] WARNING: app at ${baseUrl} still redirects to /setup after 30s. HTML ` +
                  'specs will fail with "Max redirect count exceeded"; the admin row may not ' +
                  'have been created.'
            : `[Setup] WARNING: nothing answered at ${baseUrl} in 30s — skipping the ` +
                  'first-run wait. Either webServer starts after globalSetup, or the port is ' +
                  'wrong (check PLAYWRIGHT_PORT against playwright.config.ts). A short run ' +
                  'may still race the 10s admin-exists cache.',
    );
}

/**
 * Fail the run unless the server attributes forward-auth headers to the user
 * they name.
 *
 * The server only honours `X-Forwarded-User` from a trusted proxy peer. When
 * neither TRUSTED_PROXY_IPS nor LUMASTRA_TRUST_ANY_PROXY is set it drops the
 * headers and, in dev, serves DEFAULT_USER (`admin`) instead. Nothing failed:
 * every request just ran as admin. CI ran that way until 2026-10-01, so
 * TestUserNonAdmin had admin rights and the permission specs passed without
 * testing anything. A reused local server that does not trust loopback would
 * do the same, so this check talks to whatever server the specs will use.
 */
async function assertServerSeesForwardAuthIdentity(): Promise<void> {
    const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
    const identities: Array<[user: string, groups: string[]]> = [
        [TEST_USER, TEST_GROUPS],
        [NON_ADMIN_USER, NON_ADMIN_GROUPS],
    ];
    for (const [user, groups] of identities) {
        const res = await fetch(`${baseUrl}/api/user`, {
            headers: { 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups.join('|') },
        });
        const body = (await res.json().catch(() => null)) as { id?: string } | null;
        const seen = body?.id ?? `<HTTP ${res.status}>`;
        if (seen.toLowerCase() !== user.toLowerCase()) {
            throw new Error(
                `[Setup] The server at ${baseUrl} answered /api/user for X-Forwarded-User ` +
                    `"${user}" as "${seen}". The forward-auth headers were ignored, so every ` +
                    'spec would run as that user. Set TRUSTED_PROXY_IPS to the loopback ' +
                    'addresses in the dev server env (see webServer.env in playwright.config.ts), ' +
                    'or restart a reused server with it.',
            );
        }
    }
    // And the reverse: no identity header must mean no identity. Under `vite dev`
    // it means DEFAULT_USER with admin groups unless LUMASTRA_DEV_NO_DEFAULT_USER
    // is set, and then every "unauthenticated" or bearer-only spec runs as admin.
    const anon = await fetch(`${baseUrl}/api/user`);
    if (anon.status !== 401) {
        const body = (await anon.json().catch(() => null)) as { id?: string } | null;
        throw new Error(
            `[Setup] The server at ${baseUrl} answered /api/user WITHOUT identity headers ` +
                `with HTTP ${anon.status}${body?.id ? ` as "${body.id}"` : ''}, not 401. ` +
                'Header-less specs would run as the dev DEFAULT_USER. Set ' +
                'LUMASTRA_DEV_NO_DEFAULT_USER=true in the dev server env (see webServer.env ' +
                'in playwright.config.ts), or restart a reused server with it.',
        );
    }
    console.log(
        `[Setup] Server at ${baseUrl} honours forward-auth identity headers and rejects requests without them.`,
    );
}

async function globalSetup() {
    const databaseUrl =
        process.env.DATABASE_URL || 'postgresql://lumastra:lumastra@localhost:5432/lumastra_dev';
    const cacheUrl = process.env.CACHE_URL || 'redis://localhost:6379/0';

    console.log('[Setup] Connecting to database...');
    const sql = postgres(databaseUrl, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 10,
    });

    // Connect to Valkey using valkey-glide
    let valkeyClient: GlideClient | null = null;
    try {
        const config = parseRedisUrl(cacheUrl);
        if (config) {
            const clientConfig: Parameters<typeof GlideClient.createClient>[0] = {
                addresses: [{ host: config.host, port: config.port }],
                requestTimeout: 10000,
                clientName: 'e2e-test-setup',
            };

            if (config.password) {
                clientConfig.credentials = {
                    username: config.username || 'default',
                    password: config.password,
                };
            }

            valkeyClient = await GlideClient.createClient(clientConfig);
            console.log('[Setup] Connected to Valkey');

            // Set mock Jellyfin user ID for test users (expires in 1 hour)
            const valkeyKey = `jellyfin:user:${TEST_USER_ROW}`;
            await valkeyClient.set(valkeyKey, TEST_JELLYFIN_USER_ID, {
                expiry: { type: TimeUnit.Seconds, count: 3600 },
            });
            console.log(
                `[Setup] Set mock Jellyfin user ID: ${valkeyKey} = ${TEST_JELLYFIN_USER_ID}`,
            );

            // Set mock Jellyfin user ID for non-admin test user
            const nonAdminValkeyKey = `jellyfin:user:${NON_ADMIN_USER_ROW}`;
            await valkeyClient.set(nonAdminValkeyKey, NON_ADMIN_JELLYFIN_USER_ID, {
                expiry: { type: TimeUnit.Seconds, count: 3600 },
            });
            console.log(
                `[Setup] Set mock Jellyfin user ID: ${nonAdminValkeyKey} = ${NON_ADMIN_JELLYFIN_USER_ID}`,
            );
        }
    } catch (error) {
        console.warn('[Setup] Could not connect to Valkey:', error);
        console.warn('[Setup] Streaming session tests may be skipped');
    }

    // Seed a library root covering the fixture directory.
    //
    // Every file-serving endpoint runs the DB-sourced path through
    // `isPathWithinLibraryRoots()` (media-path-resolver.ts) before streaming it,
    // so a tampered media_files row cannot serve arbitrary host files. That guard
    // is FAIL-CLOSED: with no library_paths rows it returns false for everything.
    // The e2e database configures no libraries, so direct play and the HLS
    // manifests answered 404 "Media not found" for the seeded fixture — the specs
    // blamed a missing SESSION_MODE (a setting that no longer exists) instead.
    console.log('[Setup] Seeding fixture library root...');
    // library_paths.library_group_id defaults to gen_random_uuid() but carries a
    // FK to library_groups, so the default alone always violates it — the group
    // has to exist first.
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${TEST_LIBRARY_GROUP_ID}, 'E2E Fixtures')
        ON CONFLICT (id) DO NOTHING
    `.catch((err: Error) =>
        console.warn('[Setup] Could not seed fixture library group:', err.message),
    );
    await sql`
        INSERT INTO library_paths (id, path, media_type, enabled, library_group_id)
        VALUES (${TEST_LIBRARY_PATH_ID}, ${TEST_FIXTURE_DIR}, 'movie', TRUE, ${TEST_LIBRARY_GROUP_ID})
        ON CONFLICT (id) DO UPDATE SET path = ${TEST_FIXTURE_DIR}, enabled = TRUE
    `
        .then(() => console.log('[Setup] Fixture library root seeded:', TEST_FIXTURE_DIR))
        .catch((err: Error) =>
            console.warn('[Setup] Could not seed fixture library root:', err.message),
        );

    // Seed test media item — runs independently of users table
    console.log('[Setup] Seeding test media item...');
    await sql`
        INSERT INTO media_items (
            id, title, media_type, file_path, has_files, status, created_at, updated_at
        )
        VALUES (
            ${TEST_MEDIA_ITEM_ID},
            'E2E Test Video',
            'movie',
            ${TEST_FIXTURE_PATH},
            TRUE,
            'active',
            NOW(),
            NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
            file_path = ${TEST_FIXTURE_PATH},
            has_files = TRUE,
            status = 'active',
            updated_at = NOW()
    `
        .then(async () => {
            console.log('[Setup] Test media item seeded:', TEST_MEDIA_ITEM_ID);
            // Also seed a media_files row and junction so HLS endpoint exercises
            // the media_file_items code path (migration 11.22.0)
            const fileRows = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path)
                VALUES (${TEST_FIXTURE_PATH})
                ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
                RETURNING id
            `;
            const fileId = fileRows[0]?.id;
            if (fileId) {
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileId}, ${TEST_MEDIA_ITEM_ID})
                    ON CONFLICT DO NOTHING
                `;
                console.log('[Setup] media_file_items row seeded for test item');
            }
        })
        .catch((err: Error) => {
            console.warn('[Setup] Could not seed test media item:', err.message);
        });

    // Hero swipes and modal navigation need two independent library titles.
    // Never depend on a watch-together spec running earlier to seed its movie.
    await sql`
        INSERT INTO media_items (id, title, media_type, file_path, has_files, status)
        VALUES (${TEST_RELATED_MEDIA_ITEM_ID}, 'E2E Related Video', 'movie', ${TEST_FIXTURE_PATH}, TRUE, 'active')
        ON CONFLICT (id) DO UPDATE SET file_path = ${TEST_FIXTURE_PATH}, has_files = TRUE, status = 'active'
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        SELECT id, ${TEST_RELATED_MEDIA_ITEM_ID}::uuid FROM media_files WHERE file_path = ${TEST_FIXTURE_PATH}
        ON CONFLICT DO NOTHING
    `;
    await sql`
        UPDATE media_items SET backdrop_blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj'
        WHERE id IN (${TEST_MEDIA_ITEM_ID}, ${TEST_RELATED_MEDIA_ITEM_ID})
    `;

    // Seed two combined files of two episodes each (play-session-progress.api.spec.ts).
    // One per completion test: the forward fan-out marks a whole pair watched,
    // and the forward-only control needs a pair that test never touched.
    const combinedPairs = [
        { first: TEST_EP1_ID, second: TEST_EP2_ID, file: 'combined-S01E01E02.mp4' },
        { first: TEST_EP3_ID, second: TEST_EP4_ID, file: 'combined-S01E03E04.mp4' },
    ];
    const combinedEpisodeIds = combinedPairs.flatMap((p) => [p.first, p.second]);
    await (async () => {
        // A dot directory is NOT excluded by the scanner: it accepts legitimate
        // dot-prefixed titles. Keep these manually linked episode files out of
        // the enabled movie library, or a scan will create spurious movies.
        // global-teardown removes this run's temporary directory.
        const generatedDir = resolve(
            tmpdir(),
            `lumastra-e2e-${Number(process.env.PLAYWRIGHT_PORT ?? 5173)}`,
            'combined-media',
        );
        const libraryRoots = await sql<{ path: string }[]>`
            SELECT path FROM library_paths
        `;
        for (const { path } of libraryRoots) {
            const rel = relative(resolve(path), generatedDir);
            if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) {
                throw new Error(
                    `[Setup] Generated media must be outside library roots: ${generatedDir} is within ${path}`,
                );
            }
        }
        mkdirSync(generatedDir, { recursive: true });
        // Rebuild links as well as files, including runs against the old seed
        // whose is_default row pointed at /nonexistent/lumastra-e2e.
        await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${combinedEpisodeIds}::uuid[])`;
        for (const [i, pair] of combinedPairs.entries()) {
            await sql`
                INSERT INTO media_items (id, title, media_type, file_path, created_at, updated_at)
                VALUES
                    (${pair.first}, ${`E2E Test Episode ${2 * i + 1}`}, 'episode', ${TEST_FIXTURE_PATH}, NOW(), NOW()),
                    (${pair.second}, ${`E2E Test Episode ${2 * i + 2}`}, 'episode', ${TEST_FIXTURE_PATH}, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET file_path = EXCLUDED.file_path, updated_at = NOW()
            `;
            // Probe a real 20-minute file matching the two episode windows.
            // A tiny, low-frame-rate video keeps generation cheap in CI.
            const sharedFilePath = resolve(generatedDir, pair.file);
            try {
                execFileSync(
                    process.env.FFMPEG_PATH || 'ffmpeg',
                    [
                        '-hide_banner',
                        '-loglevel',
                        'error',
                        '-y',
                        '-f',
                        'lavfi',
                        '-i',
                        'color=c=black:s=32x32:r=1',
                        '-t',
                        '1200',
                        '-c:v',
                        'libx264',
                        '-preset',
                        'ultrafast',
                        '-pix_fmt',
                        'yuv420p',
                        '-an',
                        '-movflags',
                        '+faststart',
                        sharedFilePath,
                    ],
                    { timeout: 30_000 },
                );
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    throw new Error(
                        `[Setup] FFmpeg executable not found (${process.env.FFMPEG_PATH || 'ffmpeg'}). ` +
                            'Install FFmpeg or set FFMPEG_PATH to its executable to generate the combined-episode fixtures.',
                        { cause: error },
                    );
                }
                throw error;
            }
            const fileRows = await sql<[{ id: string }]>`
                INSERT INTO media_files (file_path)
                VALUES (${sharedFilePath})
                ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
                RETURNING id
            `;
            const fileId = fileRows[0]?.id;
            if (!fileId) continue;
            // Episode windows are what make it a combined file: completion of a
            // session opened on the first episode fans out to the second against
            // the second's own window (watch-manager.reportProgress). Without
            // offsets the file has no windows and nothing fans out.
            await sql`
                INSERT INTO media_file_items
                    (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms)
                VALUES
                    (${fileId}, ${pair.first}, TRUE, 0, 600000),
                    (${fileId}, ${pair.second}, TRUE, 600000, 1200000)
                ON CONFLICT (file_id, media_item_id) DO UPDATE SET
                    is_default = TRUE,
                    start_offset_ms = EXCLUDED.start_offset_ms,
                    end_offset_ms = EXCLUDED.end_offset_ms
            `;
        }
        // Start every run unwatched, with no event history left over from
        // earlier runs (so watch_count and first/last_watched_at are fresh too).
        await sql`DELETE FROM user_media_events WHERE media_id = ANY(${combinedEpisodeIds}::uuid[])`;
        await sql`DELETE FROM user_media_state WHERE media_id = ANY(${combinedEpisodeIds}::uuid[])`;
        console.log('[Setup] Combined-file episodes seeded:', combinedEpisodeIds.join(', '));
    })();

    // Seed music hierarchy: artist → album → 2 tracks
    console.log('[Setup] Seeding music test data...');
    await seedMusicTestData(sql).catch((err: Error) => {
        console.warn(
            '[Setup] Could not seed music test data (migration may be pending):',
            err.message,
        );
    });

    try {
        // Check if users table exists
        const tableExists = await sql`
			SELECT EXISTS (
				SELECT FROM information_schema.tables
				WHERE table_schema = 'public'
				AND table_name = 'users'
			) as exists
		`;

        if (!tableExists[0]?.exists) {
            console.log('[Setup] users table does not exist, skipping user creation');
            console.log('[Setup] Some tests may be skipped due to missing database tables');
            await sql.end();
            return;
        }

        // Insert or update test user (admin)
        console.log(`[Setup] Creating test user: ${TEST_USER_ROW}`);
        await sql`
			INSERT INTO users (username, is_admin, groups, groups_updated_at)
			VALUES (${TEST_USER_ROW}, true, ${TEST_GROUPS}, NOW())
			ON CONFLICT (username)
			DO UPDATE SET groups = ${TEST_GROUPS}, groups_updated_at = NOW(), is_admin = true
		`;
        console.log('[Setup] Admin test user created/updated successfully');

        // Insert or update non-admin test user
        console.log(`[Setup] Creating non-admin test user: ${NON_ADMIN_USER_ROW}`);
        await sql`
			INSERT INTO users (username, is_admin, groups, groups_updated_at)
			VALUES (${NON_ADMIN_USER_ROW}, false, ${NON_ADMIN_GROUPS}, NOW())
			ON CONFLICT (username)
			DO UPDATE SET groups = ${NON_ADMIN_GROUPS}, groups_updated_at = NOW()
		`;
        console.log('[Setup] Non-admin test user created/updated successfully');

        // Clean up ALL test tokens from previous runs (not just E2E prefixed)
        console.log('[Setup] Cleaning up stale test tokens...');
        // `personal_access_tokens.user_id` is a uuid, not a username. Comparing it
        // to a name made Postgres raise 22P02, the catch below swallowed it, and
        // the cleanup silently never ran — so tokens piled up across runs until
        // the "Maximum of 10 active tokens allowed per user" cap answered 409 and
        // every spec that mints a PAT failed on a null token. Resolve the names to
        // ids, and report a failure instead of hiding it.
        await sql`
			DELETE FROM personal_access_tokens
			WHERE user_id IN (
				SELECT id FROM users WHERE username IN (${TEST_USER_ROW}, ${NON_ADMIN_USER_ROW})
			)
		`.catch((err: Error) => {
            console.warn('[Setup] Could not clean up stale test tokens:', err.message);
        });

        await sql`
			DELETE FROM service_tokens
			WHERE name LIKE 'E2E%'
		`.catch(() => {
            // Table may not exist
        });

        // Clean up streaming sessions. Same uuid-vs-username hazard as the tokens
        // above, so resolve through users here too.
        await sql`
			DELETE FROM streaming_sessions
			WHERE user_id IN (
				SELECT id FROM users WHERE username IN (${TEST_USER_ROW}, ${NON_ADMIN_USER_ROW})
			)
		`.catch(() => {
            // Table may not exist on this schema version.
        });

        // Last, and after the admin row above exists: close the first-run
        // window so a short run cannot start inside it. See the function's
        // comment — this is the fix for a 6-file run failing where the same
        // files passed in the 43-file one.
        await waitForFirstRunRedirectToClear();

        console.log('[Setup] Setup complete');
    } catch (error) {
        console.error('[Setup] Error during setup:', error);
        // Don't fail - tests will skip if data isn't available
    } finally {
        await sql.end();
        if (valkeyClient) {
            try {
                valkeyClient.close();
            } catch {
                // Ignore close errors
            }
        }
    }

    // Outside the try above on purpose: its catch logs and carries on, and this
    // must stop the run.
    await assertServerSeesForwardAuthIdentity();
}

export default globalSetup;
