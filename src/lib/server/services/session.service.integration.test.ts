// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    createSession,
    revokeSessionsByOidcSid,
    revokeSessionsByOidcSub,
} from '../database/queries/user-sessions.queries.js';

let sql: postgres.Sql;

// Minimal user fixture: user_sessions.user_id FKs users.id.
async function makeUser(username: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin) VALUES (${username}, false)
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING id
    `;
    return rows[0].id;
}

describe('session revocation by OP identity', () => {
    const ISS = 'https://idp.test/application/o/lumastra/';
    // Unique suffix per test-run so repeated runs don't accumulate leftover rows
    // that would cause the "revokes exactly 1" assertion to see count > 1.
    const RUN = Date.now();

    beforeAll(async () => {
        sql = getTestDb();
    });

    it('revokes exactly the session matching (iss, sid)', async () => {
        const userId = await makeUser(`bcl_sid_${RUN}`);
        await createSession(sql, {
            userId,
            tokenHash: `h_a_${RUN}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            oidcIss: ISS,
            oidcSub: 'sub-1',
            oidcSid: `sid-A-${RUN}`,
        });
        await createSession(sql, {
            userId,
            tokenHash: `h_b_${RUN}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            oidcIss: ISS,
            oidcSub: 'sub-1',
            oidcSid: `sid-B-${RUN}`,
        });

        const revoked = await revokeSessionsByOidcSid(sql, ISS, `sid-A-${RUN}`);
        expect(revoked).toBe(1);
    });

    it('revokes all sessions for (iss, sub) and returns the user ids', async () => {
        const userId = await makeUser(`bcl_sub_${RUN}`);
        await createSession(sql, {
            userId,
            tokenHash: `h_c_${RUN}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            oidcIss: ISS,
            oidcSub: `sub-2-${RUN}`,
            oidcSid: `sid-C-${RUN}`,
        });
        await createSession(sql, {
            userId,
            tokenHash: `h_d_${RUN}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            oidcIss: ISS,
            oidcSub: `sub-2-${RUN}`,
            oidcSid: null,
        });

        const userIds = await revokeSessionsByOidcSub(sql, ISS, `sub-2-${RUN}`);
        expect(userIds).toContain(userId);

        // Second call revokes nothing (already revoked) and returns no users.
        const again = await revokeSessionsByOidcSub(sql, ISS, `sub-2-${RUN}`);
        expect(again).toHaveLength(0);
    });

    it('ignores a non-matching issuer', async () => {
        const userId = await makeUser(`bcl_iss_${RUN}`);
        await createSession(sql, {
            userId,
            tokenHash: `h_e_${RUN}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            oidcIss: ISS,
            oidcSub: `sub-3-${RUN}`,
            oidcSid: `sid-E-${RUN}`,
        });
        const revoked = await revokeSessionsByOidcSid(sql, 'https://other.test/', `sid-E-${RUN}`);
        expect(revoked).toBe(0);
    });
});
