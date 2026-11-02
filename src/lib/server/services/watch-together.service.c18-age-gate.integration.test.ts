// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for C18 (2026-09-18 fix plan 4 task 6) and C2 (2026-09-24
 * fix plan 6 task 4) — Watch Together's participant-block check.
 *
 * C18: the check built a `UserContext` that omitted `isAgeRestricted`, so
 * `checkMediaAccess`'s `if (!user.isAgeRestricted) return true;` skipped the
 * age gate unconditionally for EVERY participant `resolveBlockedParticipants`
 * evaluated, regardless of their real `max_age_rating`.
 *
 * C2: even after C18, the subject was rebuilt from the raw `users` row
 * (`is_admin`/`max_age_rating`/`groups`) instead of the canonical
 * `resolveTokenUserAccess()` resolver. That raw read is blind to every cap
 * that isn't in the column: a stale-true `is_admin` on an unpinned row, any
 * OIDC participant capped by an IdP `age-<n>` group (the column is always
 * NULL for OIDC), and in-app age cohorts were all treated as unrestricted.
 * The cases below drive each of those three fixtures plus two controls (an
 * uncapped participant, a genuine pinned admin) through the REAL resolver and
 * the REAL `checkMediaAccess` — a test that hand-builds the `UserContext`
 * itself cannot prove either bug is fixed.
 *
 * Unlike the existing `watch-together.service.navigate-party.test.ts` and
 * `.integration.test.ts` suites (which mock `checkMediaAccess` entirely, or
 * run Valkey-only with no database behind it), this test drives the REAL,
 * unmocked `checkMediaAccess` and `resolveTokenUserAccess` against a REAL
 * Postgres row. `getSession`/`joinSession`/`participantsBlockedBy` are called
 * for real too (real Valkey), because `resolveBlockedParticipants` is an
 * unexported helper reached only through `participantsBlockedBy`, itself
 * defined in the same module — an external mock of a sibling export in that
 * module would not intercept its internal same-module call.
 *
 * Requires CACHE_URL (real Valkey) and TEST_DATABASE_URL/DATABASE_URL (real
 * Postgres) — skipped otherwise, same convention as the sibling suites.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { connectValkey, del } from '../cache/valkey.js';
import {
    insertAccessGroup,
    insertAccessGroupCapabilities,
    addAccessGroupMember,
} from '$lib/server/database/queries/access-groups.queries.js';
import { clearUserAccessCache } from '$lib/server/cache/user-access-cache.js';
import { invalidateUserAdminCache } from '$lib/server/cache/user-admin-cache.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

const RUN = Boolean(
    (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) && process.env.CACHE_URL,
);

describe.runIf(RUN)('Watch Together participant-block age gate (C18, C2)', () => {
    let sql: postgres.Sql;
    let createSession: typeof import('./watch-together.service.js').createSession;
    let joinSession: typeof import('./watch-together.service.js').joinSession;
    let participantsBlockedBy: typeof import('./watch-together.service.js').participantsBlockedBy;
    let endSession: typeof import('./watch-together.service.js').endSession;

    const hostId = randomUUID();
    const participantId = randomUUID();
    const hostDisplayName = derivedUsername(hostId);
    const participantUsername = derivedUsername(participantId);
    const mildItemId = randomUUID();
    const restrictedItemId = randomUUID();

    // Every session code created across this file's tests, ended + cleaned in
    // afterAll. Every fixture user id created for the C2 cases, deleted the
    // same way. Every access group created for the in-app-cohort case.
    const sessionCodes: string[] = [];
    const createdUserIds: string[] = [];
    const accessGroupIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        await connectValkey();
        const mod = await import('./watch-together.service.js');
        createSession = mod.createSession;
        joinSession = mod.joinSession;
        participantsBlockedBy = mod.participantsBlockedBy;
        endSession = mod.endSession;

        await ensureTestUser(sql, hostId);
        await ensureTestUser(sql, participantId);
        // Participant is age-restricted (max_age_rating = 13); host is not.
        // `age_rating_pinned = true` (research §Risks 1): after the C2 fix the
        // subject comes from `resolveTokenUserAccess`, which only reads the
        // raw `max_age_rating` column when the row is PINNED — an unpinned
        // cap is re-derived from groups instead, and this fixture's groups
        // are NULL, which would make the participant read as unrestricted and
        // turn this pre-existing case RED.
        await sql`
            UPDATE users
            SET max_age_rating = 13, age_rating_pinned = true
            WHERE id = ${participantId}::uuid
        `;

        // Mild item — rated well below the participant's ceiling (13), so the
        // participant can JOIN the party (UNRATED_CONTENT_VISIBLE defaults to
        // false, so a NULL rating would itself be blocked for an age-restricted
        // user — use an explicit low rating instead).
        await sql`
            INSERT INTO media_items (id, title, media_type, status, age_rating)
            VALUES (${mildItemId}::uuid, 'C18 Mild Item', 'movie', 'active', 6)
        `;
        // Restricted item — the HOST later navigates the party here.
        await sql`
            INSERT INTO media_items (id, title, media_type, status, age_rating)
            VALUES (${restrictedItemId}::uuid, 'C18 Restricted Item', 'movie', 'active', 18)
        `;
    });

    afterAll(async () => {
        for (const code of sessionCodes) {
            await endSession(code, hostId).catch(() => {});
            await del(`wt:session:${code.toUpperCase()}`).catch(() => {});
        }
        for (const groupId of accessGroupIds) {
            await sql`DELETE FROM access_groups WHERE id = ${groupId}::uuid`.catch(() => {});
        }
        await sql`DELETE FROM media_items WHERE id = ANY(${[mildItemId, restrictedItemId]}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${[hostId, participantId, ...createdUserIds]}::uuid[])`;
        await closeTestDb();
    });

    /** Fresh fixture user, cleaned up in afterAll. */
    async function makeParticipant(): Promise<{ id: string; displayName: string }> {
        const id = randomUUID();
        await ensureTestUser(sql, id);
        createdUserIds.push(id);
        return { id, displayName: derivedUsername(id) };
    }

    /**
     * A viewer with no restriction at all, used ONLY to pass `joinSession`'s
     * gate on the mild (age 6) item — that gate reads the object passed in,
     * not the DB row, so it is deliberately decoupled from each fixture's raw
     * `users`/access-group state below. The C2 fix under test is exercised
     * entirely by `participantsBlockedBy`, which re-derives the subject from
     * the DB live at call time.
     */
    function permissiveViewer(id: string, displayName: string): UserContext {
        return {
            userId: id,
            username: displayName,
            groups: '',
            userGroups: [],
            isAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
        } as unknown as UserContext;
    }

    /** Create a party, join `participant`, navigate to the restricted item, and report whether they were blocked. */
    async function isParticipantBlockedOnRestrictedItem(participant: {
        id: string;
        displayName: string;
    }): Promise<boolean> {
        const session = await createSession(
            hostId,
            hostDisplayName,
            mildItemId,
            'movie',
            'C18 Mild Item',
        );
        expect(session).not.toBeNull();
        const code = session!.code;
        sessionCodes.push(code);

        const joined = await joinSession(
            code,
            participant.id,
            participant.displayName,
            `${participant.displayName}-client`,
            permissiveViewer(participant.id, participant.displayName),
        );
        expect(joined).not.toBeNull();
        expect(joined!.participants.map((p) => p.userId)).toContain(participant.id);

        const blocked = await participantsBlockedBy(code, restrictedItemId, hostId);
        return blocked.includes(participant.id);
    }

    it('a participant whose max_age_rating is below the navigated item is blocked, not silently passed', async () => {
        const session = await createSession(
            hostId,
            hostDisplayName,
            mildItemId,
            'movie',
            'C18 Mild Item',
        );
        expect(session).not.toBeNull();
        const code = session!.code;
        sessionCodes.push(code);

        const joined = await joinSession(
            code,
            participantId,
            participantUsername,
            'participant-client',
            {
                userId: participantId,
                username: participantUsername,
                groups: '',
                userGroups: [],
                isAdmin: false,
                maxAgeRating: 13,
                isAgeRestricted: true,
            } as unknown as UserContext,
        );
        expect(joined).not.toBeNull();
        expect(joined!.participants.map((p) => p.userId)).toContain(participantId);

        // The host navigates the party to the restricted item. The participant
        // (age ceiling 13) must be reported as blocked against an 18-rated item
        // — this is the exact call `navigateParty` makes before broadcasting.
        const blocked = await participantsBlockedBy(code, restrictedItemId, hostId);

        expect(blocked).toContain(participantId);
    });

    it('C2: a stale-true admin (unpinned is_admin, pinned age cap) is blocked — the column does not override the resolver', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = true, admin_pinned = false, groups = ${['users']},
                max_age_rating = 6, age_rating_pinned = true
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(true);
    });

    it('C2: an OIDC-style participant capped only by an IdP age-<n> group is blocked, not treated as unrestricted', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = false, admin_pinned = false, groups = ${['age-12']},
                max_age_rating = null, age_rating_pinned = false
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(true);
    });

    it('C2: an in-app age cohort (no column cap) blocks via its access-group capability', async () => {
        const participant = await makeParticipant();
        const group = await insertAccessGroup(sql, {
            name: `c2-cohort-${participant.id}`,
            displayName: 'C2 Age Cohort',
            description: null,
        });
        accessGroupIds.push(group.id);
        await insertAccessGroupCapabilities(sql, group.id, [
            { capability: 'max_age_rating', value: '6' },
        ]);
        await addAccessGroupMember(sql, group.id, participant.id, null);
        clearUserAccessCache();
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(true);
    });

    it('control: an uncapped participant is NOT blocked', async () => {
        const participant = await makeParticipant();
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(false);
    });

    it('control: a genuine pinned admin is NOT blocked even with an age-cap column set', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = true, admin_pinned = true, max_age_rating = 6, age_rating_pinned = true
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(false);
    });

    // Ruling F-I2 (fix plan 6, final wave): `resolveTokenUserAccess` reads
    // `max_age_rating` only for a PINNED row and otherwise derives the cap
    // from `users.groups`. A Valkey-less forward-auth install never syncs
    // `users.groups` but does write `max_age_rating`, so the reviewer's
    // fixture below — column cap 12, unpinned, groups NULL — read as
    // unrestricted after Task 4 (blocked at ecfabb98f^, passed at
    // ecfabb98f). A non-admin participant's effective cap is the STRICTER of
    // the resolver's cap and the column.
    it('F-I2: an unpinned column-only cap (max_age_rating=12, groups NULL) blocks an 18-rated item', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = false, admin_pinned = false, groups = NULL,
                max_age_rating = 12, age_rating_pinned = false
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(true);
    });

    it('F-I2 control: an admin participant with the same unpinned column cap is NOT blocked', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = true, admin_pinned = true, groups = NULL,
                max_age_rating = 12, age_rating_pinned = false
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(false);
    });

    // A pinned row's cap IS the column, so the stricter-of merge cannot move
    // it in either direction: a pinned 12 still blocks an 18-rated item and a
    // pinned 18 still admits it (groups NULL in both, so no group-derived
    // `age-<n>` is MIN-merged on top by the resolver).
    it.each([
        [12, true],
        [18, false],
    ])(
        'F-I2 control: a pinned cap still decides (pinned %i → blocked: %s)',
        async (cap, expected) => {
            const participant = await makeParticipant();
            await sql`
                UPDATE users
                SET is_admin = false, admin_pinned = false, groups = NULL,
                    max_age_rating = ${cap}, age_rating_pinned = true
                WHERE id = ${participant.id}::uuid
            `;
            invalidateUserAdminCache(participant.displayName);

            const blocked = await isParticipantBlockedOnRestrictedItem(participant);

            expect(blocked).toBe(expected);
        },
    );

    it('F-I2 control: a participant with no cap anywhere (column NULL, unpinned, groups NULL) is NOT blocked', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users
            SET is_admin = false, admin_pinned = false, groups = NULL,
                max_age_rating = NULL, age_rating_pinned = false
            WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(false);
    });

    // Fix plan 6 ledger, folded-in Task 4 minor: watch-together.service.ts's
    // `if (!access || access.disabled || access.deleted)` branch (~:1163) had
    // no test, so a mutation removing it would survive every other case above
    // (they all reach it with `access` truthy and both flags false). These two
    // drive that exact branch: a disabled participant must be blocked (not
    // silently passed through to `checkMediaAccess` with a stale, unrestricted
    // subject), and an otherwise-identical active participant must not be.
    it('fail-closed: a disabled participant is blocked, not silently passed (watch-together.service.ts ~:1163)', async () => {
        const participant = await makeParticipant();
        await sql`
            UPDATE users SET disabled_at = now() WHERE id = ${participant.id}::uuid
        `;
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(true);
    });

    it('control: an otherwise-identical active (non-disabled) participant is NOT blocked', async () => {
        const participant = await makeParticipant();
        // disabled_at left NULL — active and otherwise uncapped.
        invalidateUserAdminCache(participant.displayName);

        const blocked = await isParticipantBlockedOnRestrictedItem(participant);

        expect(blocked).toBe(false);
    });
});
