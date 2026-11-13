// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `scripts/reset-password.ts` runs under plain `tsx` in the production image, OUTSIDE the
 * SvelteKit runtime: no `$app/*` / `$env/*` virtual modules. It promises to sign the user
 * out everywhere; a fresh-install test on v0.1.4 found it logged `Cannot find package '$app'`
 * and left /j sessions, PATs and service-token impersonation alive. This test spawns the
 * real script against the test database and checks every store is really revoked.
 *
 * Run with: npm run test:integration -- tests/integration/reset-password-cli.integration.test.ts
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    createSession,
    getOrCreatePassword,
    validatePassword,
    validateSession,
} from '$lib/server/proprietary/jellyfin-compat/auth';
import type { JellyfinSession } from '$lib/server/proprietary/jellyfin-compat/auth';
import { getTestDatabaseUrl } from './setup/test-database.js';

const run = promisify(execFile);
const appRoot = resolve(__dirname, '../..');
const NEW_PASSWORD = 'Replacement!Passphrase-for-cli-2026';

let sql: postgres.Sql;
const userIds: string[] = [];

beforeAll(async () => {
    expect(await connectValkey()).toBe(true);
    sql = postgres(getTestDatabaseUrl(), { max: 1 });
});

afterAll(async () => {
    if (userIds.length > 0) {
        await sql`DELETE FROM service_tokens WHERE act_as_user IN ${sql(userIds)}`;
        await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;
    }
    await sql.end();
    await disconnectValkey();
});

async function runCli(
    username: string,
    extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
    try {
        const { stdout, stderr } = await run(
            'npx',
            ['tsx', '--tsconfig', 'tsconfig.scripts.json', 'scripts/reset-password.ts', username],
            {
                cwd: appRoot,
                env: { ...process.env, LUMASTRA_NEW_PASSWORD: NEW_PASSWORD, ...extraEnv },
                timeout: 120_000,
            },
        );
        return { code: 0, out: stdout + stderr };
    } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

describe('scripts/reset-password.ts outside SvelteKit', () => {
    it('revokes /j sessions, PATs and service-token impersonation and exits 0', async () => {
        const username = `clireset_${randomUUID().slice(0, 12)}`;
        const [row] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
        userIds.push(row.id);
        const uid = toUserId(row.id);

        const pin = await getOrCreatePassword(row.id);
        const verified = await validatePassword(username, pin);
        expect(verified).not.toBeNull();
        const jSession: JellyfinSession = {
            ...verified!,
            deviceId: 'cli-device',
            deviceName: 'cli',
            clientName: 'test',
            clientVersion: '1',
            createdAt: new Date().toISOString(),
        };
        const jToken = await createSession(jSession, verified!);
        expect(jToken).not.toBeNull();
        expect(await validateSession(jToken!, '/j/Users/Me')).not.toBeNull();

        const pat = await getPatService().create({
            userId: uid,
            name: 'cli-test',
            scopes: ['read'],
            groups: [],
        });
        expect(await getPatService().validate(pat.token)).not.toBeNull();

        const svc = getServiceTokenService();
        const svcToken = await svc.create({
            name: 'cli-test',
            createdBy: username,
            actAsUser: uid,
            scopes: ['read'],
        });
        expect(await svc.validate(svcToken.token)).not.toBeNull();

        const { code, out } = await runCli(username);

        expect(out, out).not.toContain("Cannot find package '$app'");
        expect(out).not.toContain('could NOT be revoked');
        expect(out).not.toContain('failed {');
        expect(code, out).toBe(0);
        expect(await validateSession(jToken!, '/j/Users/Me')).toBeNull();
        expect(await getPatService().validate(pat.token)).toBeNull();
        expect(await svc.validate(svcToken.token)).toBeNull();
    }, 180_000);

    it('exits non-zero and names the store when one cannot be revoked', async () => {
        const username = `clireset_${randomUUID().slice(0, 12)}`;
        const [row] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
        userIds.push(row.id);

        // The /j session store lives in the coordination Valkey: make it unreachable.
        const { code, out } = await runCli(username, { TASK_CACHE_URL: 'redis://127.0.0.1:1/0' });

        expect(code, out).toBe(3);
        expect(out).toContain('could NOT be revoked');
        expect(out).toContain('jellyfin_compat_sessions');
    }, 180_000);
});
