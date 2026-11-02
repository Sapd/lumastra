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
// Exit codes: 0 = password set, 2 = user not found or password rejected, 1 = error.

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
    // ...and it reaches `@sveltejs/kit` (api/problem.ts imports its `json`), a build-time
    // dependency the runtime image doesn't ship. This command never answers an HTTP
    // request, so a stand-in module is enough.
    const kitShim = `export const json = (d, i) => Response.json(d, i);
export const error = (s, b) => { throw Object.assign(new Error(String(b ?? s)), { status: s }); };
export const redirect = (s, l) => { throw Object.assign(new Error('redirect'), { status: s, location: l }); };`;
    const kitHook = `export async function resolve(specifier, context, next) {
  if (specifier === '@sveltejs/kit') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(kitShim)}), shortCircuit: true };
  return next(specifier, context);
}`;
    register(`data:text/javascript,${encodeURIComponent(kitHook)}`);
    const { getDb } = await import('../src/lib/server/database/connection.js');
    // Not admin-user.service's resetPassword(): its import graph reaches @sveltejs/kit,
    // which the runtime image doesn't ship. Same steps, from the modules it composes.
    const { getUserByUsername, setUserPassword } =
        await import('../src/lib/server/database/queries/users.queries.js');
    const { hashPassword } = await import('../src/lib/server/crypto/password.js');
    const { validatePasswordPolicy } = await import('../src/lib/shared/password-strength.js');
    const { revokeAllCredentialsForUser } =
        await import('../src/lib/server/services/credential-revocation.service.js');

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
        console.log(
            `Password for "${user.username}" changed. All of their sessions were signed out.`,
        );
        if (failedStores.length > 0) {
            console.warn(`Some sign-outs did not complete: ${failedStores.join(', ')}`);
        }
        if (!chosen) console.log(`New password: ${newPassword}`);
        return 0;
    } finally {
        await sql.end({ timeout: 5 });
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error('reset-password failed:', error instanceof Error ? error.message : error);
        process.exit(1);
    });
