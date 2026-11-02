// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** PAT revocation and cleanup must still cascade to playback grants. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getStreamingSessionService, WILDCARD_IP } from './streaming-session.service.js';
import { mintPlaybackGrant } from '../services/playback-grant.js';
import { getPatService } from './pat.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';

const testMediaId = randomUUID();
const testUserId = toUserId(randomUUID());

const svc = getStreamingSessionService();

beforeEach(async () => {
    const sql = getTestDb();
    await ensureTestUser(sql, testUserId);
    await sql`INSERT INTO media_items (id, title, media_type) VALUES (${testMediaId}, 'Grant cascade track', 'track')`;
});

afterEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM media_items WHERE id = ${testMediaId}`;
    await sql`DELETE FROM users WHERE id = ${testUserId}::uuid`;
});

describe('revoking a PAT ends the stream sessions minted under it', () => {
    // hls_playback_tokens.valid_ended_reason did not list the two PAT reasons,
    // so both writers below threw a check violation: the revoke cascade only
    // logged a WARN and left the stream token valid until it expired, and
    // cleanup() aborted at the orphan sweep (old ended rows were never purged).
    async function sessionUnderNewPat() {
        const sql = getTestDb();
        const pat = await getPatService().create({
            userId: testUserId,
            name: 'cascade test',
            scopes: ['read'],
            groups: [],
        });
        const [{ token_hash: patHash }] = await sql<{ token_hash: string }[]>`
            SELECT token_hash FROM personal_access_tokens WHERE id = ${pat.id}
        `;
        const session = await mintPlaybackGrant({
            userId: testUserId,
            mediaId: testMediaId,
            playbackSessionId: null,
            kind: 'music',
            clientIp: WILDCARD_IP,
            parentTokenHash: patHash,
        });
        return { sql, pat, session };
    }

    afterEach(async () => {
        const sql = getTestDb();
        await sql`DELETE FROM hls_playback_tokens WHERE user_id = ${testUserId}::uuid`;
        await sql`DELETE FROM personal_access_tokens WHERE user_id = ${testUserId}::uuid`;
    });

    it('the revoke cascade ends the session (parent_pat_revoked)', async () => {
        const { sql, pat, session } = await sessionUnderNewPat();

        expect(await getPatService().revoke(pat.id, testUserId)).toBe(true);

        const [row] = await sql<{ is_active: boolean; ended_reason: string | null }[]>`
            SELECT is_active, ended_reason FROM hls_playback_tokens WHERE id = ${session.id}
        `;
        expect(row).toEqual({ is_active: false, ended_reason: 'parent_pat_revoked' });
    });

    it('the cleanup sweep ends a session whose PAT was revoked behind its back', async () => {
        const { sql, pat, session } = await sessionUnderNewPat();
        // Revoked without the cascade, as when the cascade was interrupted.
        await sql`UPDATE personal_access_tokens SET revoked_at = NOW() WHERE id = ${pat.id}`;

        await svc.cleanup();

        const [row] = await sql<{ is_active: boolean; ended_reason: string | null }[]>`
            SELECT is_active, ended_reason FROM hls_playback_tokens WHERE id = ${session.id}
        `;
        expect(row).toEqual({ is_active: false, ended_reason: 'parent_pat_revoked_sweep' });
    });
});
