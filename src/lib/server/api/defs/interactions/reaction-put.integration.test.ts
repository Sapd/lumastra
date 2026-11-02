// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../tests/integration/fixtures/media.fixtures.js';
import { makeReactionsDef } from './handlers.js';
import { config } from '$lib/server/config.js';
import { mount } from '$lib/server/api/mount.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import type { RequestEvent } from '@sveltejs/kit';
const userId = generateTestUserId();
const targetId = randomUUID();
const def = makeReactionsDef('media');
beforeAll(async () => {
    await ensureTestUser(getTestDb(), userId);
    await insertTestMediaItem(
        getTestDb(),
        createTestMediaItem({ id: targetId, media_type: 'movie' }),
    );
});
afterAll(async () => {
    vi.restoreAllMocks();
    const sql = getTestDb();
    await sql`DELETE FROM interaction_reactions WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM media_items WHERE id = ${targetId}`;
});
it('repeating PUT holds one reaction and unauthenticated mutations hold none', async () => {
    vi.spyOn(config, 'FEATURE_COMMENTS', 'get').mockReturnValue(true);
    const handlers = mount(def, { surface: 'v1' });
    const event = (authenticated: boolean): RequestEvent =>
        ({
            url: new URL(`http://localhost/api/v1/media/${targetId}/reactions`),
            params: { id: targetId },
            request: new Request(`http://localhost/api/v1/media/${targetId}/reactions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji: '👍' }),
            }),
            locals: authenticated
                ? principalLocals({
                      kind: 'session',
                      ownerIsAdmin: false,
                      userId,
                      username: derivedUsername(userId),
                  })
                : {},
            getClientAddress: () => '127.0.0.1',
        }) as RequestEvent;
    expect((await handlers.PUT!(event(false))).status).toBe(401);
    expect((await handlers.PUT!(event(true))).status).toBe(204);
    expect((await handlers.PUT!(event(true))).status).toBe(204);
    const [{ n }] = await getTestDb()<
        { n: number }[]
    >`SELECT count(*)::int AS n FROM interaction_reactions WHERE target_id = ${targetId} AND user_id = ${userId}`;
    expect(n).toBe(1);
    expect(handlers.POST).toBeUndefined();
});
