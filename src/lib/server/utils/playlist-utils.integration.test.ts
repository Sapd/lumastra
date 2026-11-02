// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for getUserRole — the central playlist access-control gate.
 *
 * Verifies the full role matrix against a real database: owner, accepted
 * editor/readonly members, pending invites (no access), public vs private
 * visibility for non-members, unknown playlists, and the userId-vs-username
 * resolution paths (playlists.user_id is a users.id UUID since mig 16.46.0).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import {
    createPlaylist,
    inviteMember,
    acceptInvite,
} from '../database/queries/playlists.queries.js';
import { getUserRole } from './playlist-utils.js';

describe('getUserRole', () => {
    let sql: postgres.Sql;
    const owner = generateTestUserId();
    const editor = generateTestUserId();
    const reader = generateTestUserId();
    const pending = generateTestUserId();
    const outsider = generateTestUserId();
    const allUsers = [owner, editor, reader, pending, outsider];

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM playlist_members WHERE user_id = ANY(${sql.array(allUsers)}::uuid[])`;
        await sql`DELETE FROM playlists WHERE user_id = ANY(${sql.array(allUsers)}::uuid[])`;
        for (const u of allUsers) await ensureTestUser(sql, u);
    });

    async function makePlaylist(visibility: 'private' | 'public' = 'private') {
        return createPlaylist(sql, owner, 'Role Test', null, visibility, 'general');
    }

    it('returns "owner" (with visibility + userId) when resolved by username', async () => {
        const playlist = await makePlaylist('private');
        const result = await getUserRole(sql, playlist.id, derivedUsername(owner));
        expect(result.role).toBe('owner');
        expect(result.visibility).toBe('private');
        expect(result.userId).toBe(owner);
    });

    it('returns "owner" when resolved by userId directly (skips username lookup)', async () => {
        const playlist = await makePlaylist('private');
        const result = await getUserRole(sql, playlist.id, null, owner);
        expect(result.role).toBe('owner');
    });

    it('returns "editor" for an accepted editor member', async () => {
        const playlist = await makePlaylist('private');
        await inviteMember(sql, playlist.id, editor, 'editor');
        await acceptInvite(sql, playlist.id, editor);
        const result = await getUserRole(sql, playlist.id, derivedUsername(editor));
        expect(result.role).toBe('editor');
    });

    it('returns "readonly" for an accepted readonly member', async () => {
        const playlist = await makePlaylist('private');
        await inviteMember(sql, playlist.id, reader, 'readonly');
        await acceptInvite(sql, playlist.id, reader);
        const result = await getUserRole(sql, playlist.id, derivedUsername(reader));
        expect(result.role).toBe('readonly');
    });

    it('returns null for a pending (not-yet-accepted) member on a private playlist', async () => {
        const playlist = await makePlaylist('private');
        await inviteMember(sql, playlist.id, pending, 'editor');
        const result = await getUserRole(sql, playlist.id, derivedUsername(pending));
        expect(result.role).toBeNull();
    });

    it('returns "readonly" for a non-member on a public playlist', async () => {
        const playlist = await makePlaylist('public');
        const result = await getUserRole(sql, playlist.id, derivedUsername(outsider));
        expect(result.role).toBe('readonly');
        expect(result.visibility).toBe('public');
    });

    it('returns null for a non-member on a private playlist', async () => {
        const playlist = await makePlaylist('private');
        const result = await getUserRole(sql, playlist.id, derivedUsername(outsider));
        expect(result.role).toBeNull();
    });

    it('returns null for an unknown playlist id', async () => {
        const result = await getUserRole(sql, 999999999, derivedUsername(owner));
        expect(result.role).toBeNull();
    });

    it('returns null for an anonymous viewer on a private playlist', async () => {
        const playlist = await makePlaylist('private');
        const result = await getUserRole(sql, playlist.id, null);
        expect(result.role).toBeNull();
    });

    it('returns "readonly" for an anonymous viewer on a public playlist', async () => {
        const playlist = await makePlaylist('public');
        const result = await getUserRole(sql, playlist.id, null);
        expect(result.role).toBe('readonly');
    });
});
