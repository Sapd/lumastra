#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Set a new built-in-login password for a user from the command line — the way back in
// when the only admin has forgotten theirs. Running this inside the container is the
// proof of host control. Same effect as Admin → Users → Reset password: the password
// policy applies, and every session, token and device of that user is signed out.
//
// In the Docker image (working directory /app):
//
//   docker compose exec lumastra npx tsx --tsconfig tsconfig.scripts.json \
//     scripts/reset-password.ts <username>
//
// Prints a generated password. To choose one instead, pass it in the environment:
//   docker compose exec -e LUMASTRA_NEW_PASSWORD='…' lumastra npx tsx … <username>
//
// Exit codes: 0 = password set and every credential revoked, 2 = user not found or
// password rejected, 3 = password set but some credentials could not be revoked, 1 = error.

import { randomBytes } from 'node:crypto';

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
    const username = process.argv[2]?.trim();
    if (!username) {
        console.error('Usage: scripts/reset-password.ts <username>');
        return 1;
    }
    const chosen = process.env.LUMASTRA_NEW_PASSWORD;
    const newPassword =
        chosen && chosen.length > 0 ? chosen : randomBytes(12).toString('base64url');

    await loadDotenvIfAvailable();
    // The credential-revocation chain reaches the task system's `.lua` scripts; register
    // their text loader here so the command needs no NODE_OPTIONS (see register-lua.mjs).
    const { register } = await import('node:module');
    register('./tsx-lua-loader.mjs', import.meta.url);
    // ...and `@sveltejs/kit`, `$app/*`, `$env/*` and `import.meta.glob`, which only the
    // SvelteKit/Vite runtime provides. This command never answers an HTTP request, so the
    // stand-ins in tsx-sveltekit-shim-loader.mjs are enough. Without them the PAT,
    // service-token and /j stores could not be revoked (v0.1.4 fresh-install report).
    register('./tsx-sveltekit-shim-loader.mjs', import.meta.url);
    // Tell boot/compat-init.ts to register the /j revocation hook only, without starting
    // its background loops (sweeper, remote control, relay enrolment, retry timers).
    process.env.LUMASTRA_CLI = '1';
    const { getDb } = await import('../src/lib/server/database/connection.js');
    // Not admin-user.service's resetPassword(): its import graph reaches @sveltejs/kit,
    // which the runtime image doesn't ship. Same steps, from the modules it composes.
    const { getUserByUsername, setUserPassword } =
        await import('../src/lib/server/database/queries/users.queries.js');
    const { hashPassword } = await import('../src/lib/server/crypto/password.js');
    const { validatePasswordPolicy } = await import('../src/lib/shared/password-strength.js');
    const { revokeAllCredentialsForUser } =
        await import('../src/lib/server/services/credential-revocation.service.js');

    // The /j session store and the Subsonic auth cache live in Valkey; without a connection
    // their sweeps fail (and are reported as failed stores below).
    const { connectValkey, disconnectValkey } = await import('../src/lib/server/cache/valkey.js');
    await connectValkey();

    const sql = getDb();
    if (!sql) {
        console.error('No database connection (DATABASE_URL is not set).');
        return 1;
    }
    try {
        const user = await getUserByUsername(sql, username.toLowerCase());
        if (!user) {
            console.error(`Password not changed: no user "${username}".`);
            return 2;
        }
        const policyError = validatePasswordPolicy(newPassword);
        if (policyError) {
            console.error(`Password not changed: ${policyError}`);
            return 2;
        }
        await setUserPassword(sql, user.id, await hashPassword(newPassword));
        const { failedStores } = await revokeAllCredentialsForUser(sql, user.id, user.username);
        if (failedStores.length > 0) {
            // The password IS changed, but old credentials may still work: say so
            // loudly and fail, so a script or an operator cannot miss it.
            console.error(
                `Password for "${user.username}" changed, but these credentials could NOT be ` +
                    `revoked and may still work: ${failedStores.join(', ')}. ` +
                    'Revoke them under Admin → Users, then run this command again.',
            );
            if (!chosen) console.log(`New password: ${newPassword}`);
            return 3;
        }
        console.log(
            `Password for "${user.username}" changed. All of their sessions were signed out.`,
        );
        if (!chosen) console.log(`New password: ${newPassword}`);
        return 0;
    } finally {
        await sql.end({ timeout: 5 });
        await disconnectValkey().catch(() => undefined);
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error('reset-password failed:', error instanceof Error ? error.message : error);
        process.exit(1);
    });
