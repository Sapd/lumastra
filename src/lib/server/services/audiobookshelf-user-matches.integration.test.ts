// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: fetch }));

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { checkAudiobookshelfUserMatches } from './audiobookshelf-user-matches.js';
import { config } from '$lib/server/config.js';
import { PluginSecrets } from '../tasks/secrets.js';
import {
    AUDIOBOOKSHELF_PLUGIN_ID,
    API_KEY_SECRET,
    PULL_DISABLED_SECRET,
} from './audiobookshelf-credentials.service.js';

describe('Audiobookshelf user-match snapshot', () => {
    let sql: postgres.Sql;
    const ids: string[] = [];
    const prefix = `abs-match-${crypto.randomUUID()}-`;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterEach(async () => {
        await sql`DELETE FROM plugin_user_credentials WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
        ids.length = 0;
        fetch.mockReset();
        vi.restoreAllMocks();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    async function user(
        name: string,
        flag?: 'disabled' | 'deleted',
        secret?: string,
    ): Promise<string> {
        const id = crypto.randomUUID();
        ids.push(id);
        const username = prefix + name;
        await sql`INSERT INTO users (id, username, disabled_at, deleted_at)
            VALUES (${id}::uuid, ${username}, ${flag === 'disabled' ? new Date() : null}, ${flag === 'deleted' ? new Date() : null})`;
        if (secret === API_KEY_SECRET) {
            await new PluginSecrets(sql).setUser(
                AUDIOBOOKSHELF_PLUGIN_ID,
                id,
                secret,
                'test-user-key',
            );
        } else if (secret) {
            await sql`INSERT INTO plugin_user_credentials (plugin_id, user_id, key, value_encrypted)
                VALUES (${AUDIOBOOKSHELF_PLUGIN_ID}, ${id}::uuid, ${secret}, ${Buffer.from([0])})`;
        }
        return username;
    }

    it('uses active, collision-safe identities; respects links and explicit unlink, and observes repairs without a sync run', async () => {
        vi.spyOn(config, 'AUDIOBOOK_AUTO_CREATE_USERS', 'get').mockReturnValue(false);
        const matched = await user('cafe\u0301');
        const missing = await user('missing');
        const ambiguous = await user('ambiguous');
        const linked = await user('renamed-linked', undefined, API_KEY_SECRET);
        const optedOut = await user('opted-out', undefined, PULL_DISABLED_SECRET);
        const disabled = await user('disabled', 'disabled');
        const deleted = await user('deleted', 'deleted');
        const collisionOne = await user('duplicate-café');
        const collisionTwo = await user('duplicate-cafe\u0301');
        const upstream = [
            { id: 'match', username: matched.normalize('NFC').toUpperCase() },
            { id: 'ambiguous-one', username: ambiguous },
            { id: 'ambiguous-two', username: ambiguous.toUpperCase() },
            { id: 'collision', username: collisionOne },
            { id: 'disabled', username: disabled },
            { id: 'deleted', username: deleted },
            { id: 'root', username: 'root-account', type: 'root', isActive: true },
            { id: 'guest', username: 'guest-account', type: 'guest', isActive: true },
            { id: 'inactive', username: 'inactive-account', type: 'user', isActive: false },
        ];
        fetch.mockImplementation(
            async (url: string) =>
                new Response(
                    JSON.stringify(
                        url.includes('/api/me')
                            ? { id: 'linked', username: 'renamed-upstream' }
                            : { users: upstream },
                    ),
                ),
        );
        const options = {
            knownUsernames: new Set(
                [matched, missing, ambiguous, linked, optedOut, disabled, deleted].map((name) =>
                    name.normalize('NFC').trim().toLowerCase(),
                ),
            ),
        };
        const snapshot = await checkAudiobookshelfUserMatches(
            sql,
            'http://abs.example',
            'test-key',
            missing,
            options,
        );
        expect(snapshot.adminMatched).toBe(false);
        for (const name of ['root-account', 'guest-account', 'inactive-account'])
            expect(snapshot.unmatchedUsernames).not.toContain(name);
        expect(snapshot.matchedUsernames).toEqual(expect.arrayContaining([matched, linked]));
        expect(snapshot.unmatchedUsernames).toEqual(expect.arrayContaining([missing, ambiguous]));
        for (const name of [
            matched,
            linked,
            optedOut,
            disabled,
            deleted,
            collisionOne,
            collisionTwo,
        ]) {
            expect(snapshot.unmatchedUsernames).not.toContain(name);
        }
        upstream.push({ id: 'repaired', username: missing.toUpperCase() });
        const repaired = await checkAudiobookshelfUserMatches(
            sql,
            'http://abs.example',
            'test-key',
            missing,
            options,
        );
        expect(repaired.adminMatched).toBe(true);
        expect(repaired.unmatchedUsernames).not.toContain(missing);
    });

    it('does not warn about a normal, not-yet-played user under the default auto-create policy', async () => {
        vi.spyOn(config, 'AUDIOBOOK_AUTO_CREATE_USERS', 'get').mockReturnValue(true);
        const username = await user('first-play');
        fetch.mockImplementation(async () => new Response(JSON.stringify({ users: [] })));
        const result = await checkAudiobookshelfUserMatches(
            sql,
            'http://abs.example',
            'test-key',
            username,
        );
        expect(result.pendingUsernames).toContain(username);
        expect(result.unmatchedUsernames).not.toContain(username);
        expect(result.adminMatched).toBe(false);
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/me'))).toBe(false);
    });

    it('reports a rejected persisted credential without deleting or replacing it', async () => {
        const username = await user('rejected', undefined, API_KEY_SECRET);
        fetch.mockImplementation(async (url: string) =>
            url.includes('/api/me')
                ? new Response('{}', { status: 403 })
                : new Response(JSON.stringify({ users: [{ id: 'abs-user', username }] })),
        );
        const result = await checkAudiobookshelfUserMatches(
            sql,
            'http://abs.example',
            'test-key',
            username.toUpperCase(),
        );
        expect(result.adminMatched).toBe(false);
        expect(result.unmatchedUsernames).toContain(username);
        expect(result.matchedUsernames).not.toContain(username);
        expect(
            await new PluginSecrets(sql).getUserRaw(
                AUDIOBOOKSHELF_PLUGIN_ID,
                ids[0],
                API_KEY_SECRET,
            ),
        ).toBe('test-user-key');
    });
});
