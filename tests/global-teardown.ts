// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playwright Global Teardown
 *
 * Cleans up test data after running e2e tests.
 */

import postgres from 'postgres';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    TEST_MEDIA_ITEM_ID,
    TEST_RELATED_MEDIA_ITEM_ID,
    TEST_LIBRARY_PATH_ID,
    TEST_LIBRARY_GROUP_ID,
} from './global-setup';

const TEST_USER = process.env.TEST_USER || 'TestUser';

async function globalTeardown() {
    const databaseUrl =
        process.env.DATABASE_URL || 'postgresql://lumastra:lumastra@localhost:5432/lumastra_dev';

    console.log('[Teardown] Connecting to database...');
    const sql = postgres(databaseUrl, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 10,
    });

    try {
        // Clean up ALL test user tokens (not just E2E prefixed ones)
        console.log('[Teardown] Cleaning up test tokens...');

        // `user_id` is a uuid and TEST_USER is a name — the mismatch raised 22P02
        // and this catch hid it, so the teardown never actually deleted anything
        // and tokens accumulated until the per-user cap rejected new ones. Resolve
        // the name through `users` (which stores the lowercased spelling).
        await sql`
			DELETE FROM personal_access_tokens
			WHERE user_id IN (SELECT id FROM users WHERE username = ${TEST_USER.toLowerCase()})
		`.catch((err: Error) => {
            console.warn('[Teardown] Could not clean up test tokens:', err.message);
        });

        await sql`
			DELETE FROM service_tokens
			WHERE name LIKE 'E2E%'
		`.catch(() => {
            // Table may not exist
        });

        // Clean up streaming sessions
        await sql`
			DELETE FROM streaming_sessions
			WHERE user_id IN (SELECT id FROM users WHERE username = ${TEST_USER.toLowerCase()})
		`.catch(() => {
            // Table may not exist on this schema version.
        });

        // Optionally remove test user (uncomment if you want full cleanup)
        // await sql`DELETE FROM users WHERE username = ${TEST_USER}`;

        // Clean up test media item
        await sql`
            DELETE FROM media_items WHERE id IN (${TEST_MEDIA_ITEM_ID}, ${TEST_RELATED_MEDIA_ITEM_ID})
        `
            .then(() => {
                console.log('[Teardown] Removed test media item');
            })
            .catch(() => {});

        // Clean up the fixture library root seeded by global-setup, so a later
        // run against the same database does not inherit a root pointing at a
        // checkout that may have moved.
        await sql`
            DELETE FROM library_paths WHERE id = ${TEST_LIBRARY_PATH_ID}
        `
            .then(() => {
                console.log('[Teardown] Removed fixture library root');
            })
            .catch(() => {});
        await sql`
            DELETE FROM library_groups WHERE id = ${TEST_LIBRARY_GROUP_ID}
        `.catch(() => {});

        console.log('[Teardown] Cleanup complete');
    } catch (error) {
        console.error('[Teardown] Error during teardown:', error);
        // Don't fail on cleanup errors
    } finally {
        await sql.end();
        await rm(join(tmpdir(), `lumastra-e2e-${Number(process.env.PLAYWRIGHT_PORT ?? 5173)}`), {
            recursive: true,
            force: true,
        });
    }
}

export default globalTeardown;
