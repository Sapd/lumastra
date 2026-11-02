#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Remove the persistent setup lock on an install that has lost every admin,
// without a restart. Running this inside the container is the proof of host
// control; SETUP_UNLOCK is not needed. It does nothing while any admin exists.
//
// In the Docker image (working directory /app):
//
//   docker exec -it <container> sh -c 'NODE_OPTIONS="--import ./scripts/register-lua.mjs" \
//     node_modules/.bin/tsx --tsconfig tsconfig.scripts.json scripts/setup-unlock.ts'
//
// Exit codes: 0 = setup is now open (or already was), 2 = an admin exists and
// the lock was kept, 1 = error.

async function loadDotenvIfAvailable(): Promise<void> {
    try {
        const dotenvModule = await import('dotenv');
        const load =
            'default' in dotenvModule
                ? (dotenvModule.default?.config ?? dotenvModule.config)
                : dotenvModule.config;
        if (typeof load === 'function') load();
    } catch (error) {
        const err = error as { code?: string };
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
}

async function main(): Promise<number> {
    await loadDotenvIfAvailable();
    const { config } = await import('../src/lib/server/config.js');
    const { getDb } = await import('../src/lib/server/database/connection.js');
    const { reconcileSetupLock } = await import('../src/lib/server/services/setup-lock.service.js');

    const sql = getDb();
    if (!sql) {
        console.error('No database connection (DATABASE_URL is not set).');
        return 1;
    }
    try {
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: true,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        switch (outcome) {
            case 'unlocked':
                console.log(
                    'Setup lock removed. No admin exists, so first-run setup at /setup is open to anyone who can reach it. Create the admin now.',
                );
                return 0;
            case 'already-unlocked':
                console.log('Setup was not locked and no admin exists. /setup is open.');
                return 0;
            default:
                console.log(
                    'An admin exists, so the setup lock was kept. Sign in as that admin instead.',
                );
                return 2;
        }
    } finally {
        await sql.end({ timeout: 5 });
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error('setup-unlock failed:', error instanceof Error ? error.message : error);
        process.exit(1);
    });
