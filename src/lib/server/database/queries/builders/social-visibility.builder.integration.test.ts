// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the shared listening-visibility predicate.
 *
 * These run against real SQL because every property under test is a property of
 * the SQL and of nothing else:
 *
 * - The effective-groups UNION spans two tables (`users.groups` and
 *   `user_access_groups -> access_groups`). A predicate reading only the first
 *   returns EMPTY on a standalone install and gives asymmetric visibility on a
 *   mixed one — both of which type-check perfectly and neither of which a mocked
 *   unit test would notice.
 * - `&&` is case-sensitive while `hashGroups` lowercases, so `['Household']` vs
 *   `['household']` is a live trap that only real Postgres can confirm closed.
 * - "shares a DESIGNATED group" vs "shares any group" differ only when a broad
 *   group like `users` exists, which needs rows to demonstrate.
 *
 * Every exclusion in the design doc's §7 matrix is asserted INDEPENDENTLY: each
 * case starts from a row that is provably visible and flips exactly one thing.
 * Otherwise a predicate that excludes everything would pass the whole matrix.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    buildSocialVisibilityFilter,
    buildSocialAudienceReach,
    getDesignatedTrustGroups,
    isSocialSharingConfigured,
} from './social-visibility.builder.js';

// Fixed ids so teardown can be exact and can never touch another suite's rows.
const BOOK = '3a000000-0000-4000-8000-00000000b001';
const OTHER_BOOK = '3a000000-0000-4000-8000-00000000b002';

const VIEWER = '3a000000-0000-4000-8000-00000000d001';
const MEMBER = '3a000000-0000-4000-8000-00000000d002';
const PRIVATE_MEMBER = '3a000000-0000-4000-8000-00000000d003';
const OUTSIDER = '3a000000-0000-4000-8000-00000000d004';
const OTHER_CIRCLE = '3a000000-0000-4000-8000-00000000d005';
const INAPP_MEMBER = '3a000000-0000-4000-8000-00000000d006';
const CASE_MEMBER = '3a000000-0000-4000-8000-00000000d007';
const INAPP_VIEWER = '3a000000-0000-4000-8000-00000000d008';

const ALL_USERS = [
    VIEWER,
    MEMBER,
    PRIVATE_MEMBER,
    OUTSIDER,
    OTHER_CIRCLE,
    INAPP_MEMBER,
    CASE_MEMBER,
    INAPP_VIEWER,
];

const GROUP_HOUSEHOLD = '3a000000-0000-4000-8000-00000000a001';
const GROUP_OTHER = '3a000000-0000-4000-8000-00000000a002';

/** The configured circle for these tests. Passed explicitly, never via env. */
const TRUST = ['household'];

interface SeedUser {
    id: string;
    username: string;
    /** `users.groups` — the IdP projection. `null` models a standalone install. */
    groups: string[] | null;
    hideStreams?: boolean;
    shareActivity?: boolean;
    /** in-app access group ids (the union's second source) */
    inApp?: string[];
}

const USERS: SeedUser[] = [
    // The viewer: in the circle via the IdP, plus a broad group everyone has.
    { id: VIEWER, username: 'svp_viewer', groups: ['Household', 'users'], shareActivity: true },
    // Plain circle member — the control row every exclusion test flips away from.
    { id: MEMBER, username: 'svp_member', groups: ['household', 'users'], shareActivity: true },
    // Same, but private tier.
    {
        id: PRIVATE_MEMBER,
        username: 'svp_private',
        groups: ['household', 'users'],
        hideStreams: true,
        shareActivity: true,
    },
    // Shares ONLY the broad group. Must never be visible.
    { id: OUTSIDER, username: 'svp_outsider', groups: ['users'], shareActivity: true },
    // In a DIFFERENT designated-looking circle plus the broad group.
    { id: OTHER_CIRCLE, username: 'svp_other', groups: ['nachbarn', 'users'], shareActivity: true },
    // Standalone-install shape: no IdP groups at all, circle membership is in-app.
    {
        id: INAPP_MEMBER,
        username: 'svp_inapp',
        groups: null,
        inApp: [GROUP_HOUSEHOLD],
        shareActivity: true,
    },
    // Circle membership spelled in a different case by the IdP.
    { id: CASE_MEMBER, username: 'svp_case', groups: ['  HOUSEHOLD '], shareActivity: true },
    // A viewer whose own circle membership is in-app only (reverse direction).
    {
        id: INAPP_VIEWER,
        username: 'svp_inapp_viewer',
        groups: null,
        inApp: [GROUP_HOUSEHOLD],
        shareActivity: true,
    },
];

describe('social visibility predicate', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();

        await sql`
            INSERT INTO media_items (id, title, media_type)
            VALUES (${BOOK}, 'Predicate Book', 'audiobook'),
                   (${OTHER_BOOK}, 'Predicate Book Two', 'audiobook')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO access_groups (id, name, display_name)
            VALUES (${GROUP_HOUSEHOLD}, 'HouseHold', 'Haushalt'),
                   (${GROUP_OTHER}, 'nachbarn', 'Nachbarn')
            ON CONFLICT (id) DO NOTHING
        `;

        for (const u of USERS) {
            await sql`
                INSERT INTO users (id, username, groups, hide_streams,
                                   share_listening_activity, share_audiobook_activity)
                VALUES (${u.id}, ${u.username}, ${u.groups}, ${u.hideStreams ?? false},
                        ${u.shareActivity ?? false}, true)
                ON CONFLICT (id) DO NOTHING
            `;
            for (const groupId of u.inApp ?? []) {
                await sql`
                    INSERT INTO user_access_groups (user_id, group_id)
                    VALUES (${u.id}, ${groupId})
                    ON CONFLICT DO NOTHING
                `;
            }
            // Everyone is mid-book on both titles, so a missing row can never be
            // mistaken for a working exclusion.
            await sql`
                INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms)
                VALUES (${u.id}, ${BOOK}, 1000, 100000),
                       (${u.id}, ${OTHER_BOOK}, 2000, 100000)
                ON CONFLICT (user_id, media_id) DO NOTHING
            `;
        }
    });

    afterAll(async () => {
        // media_items cascades to user_media_state and user_media_share_opt_out;
        // users cascades to user_access_groups. Both are deleted explicitly so this
        // suite leaves lumastra_tests exactly as it found it (a sibling suite once
        // failed because audiobook rows outlived their test).
        await sql`DELETE FROM media_items WHERE id IN (${BOOK}, ${OTHER_BOOK})`;
        await sql`DELETE FROM users WHERE id = ANY(${ALL_USERS}::uuid[])`;
        await sql`DELETE FROM access_groups WHERE id IN (${GROUP_HOUSEHOLD}, ${GROUP_OTHER})`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM user_media_share_opt_out WHERE user_id = ANY(${ALL_USERS}::uuid[])`;
        await sql`
            UPDATE users SET hide_streams = false,
                share_listening_activity = true, share_audiobook_activity = true
            WHERE id = ANY(${ALL_USERS}::uuid[])
        `;
        await sql`UPDATE users SET hide_streams = true WHERE id = ${PRIVATE_MEMBER}`;
    });

    async function reachesOthers(
        userId: string,
        audience: 'household' | 'groups',
        designated: string[],
    ): Promise<boolean> {
        const [row] = await sql<{ reachable: boolean }[]>`
            SELECT ${buildSocialAudienceReach(sql, 'subject', audience, designated)} AS reachable
            FROM users subject WHERE subject.id = ${userId}::uuid
        `;
        return row.reachable;
    }

    it('policy reach requires a shared designated group with another live user', async () => {
        expect(await reachesOthers(MEMBER, 'groups', ['HOUSEHOLD'])).toBe(true);
        expect(await reachesOthers(INAPP_MEMBER, 'groups', ['household'])).toBe(true);
        expect(await reachesOthers(OUTSIDER, 'groups', TRUST)).toBe(false);
        expect(await reachesOthers(MEMBER, 'groups', [])).toBe(false);
        // OTHER_CIRCLE is the only member of nachbarn: self is not an audience.
        expect(await reachesOthers(OTHER_CIRCLE, 'groups', ['nachbarn'])).toBe(false);
        await sql`UPDATE users SET groups = ARRAY['nachbarn'] WHERE id = ${MEMBER}`;
        try {
            expect(await reachesOthers(OTHER_CIRCLE, 'groups', ['nachbarn'])).toBe(true);
            await sql`UPDATE users SET disabled_at = now() WHERE id = ${MEMBER}`;
            expect(await reachesOthers(OTHER_CIRCLE, 'groups', ['nachbarn'])).toBe(false);
            await sql`UPDATE users SET disabled_at = NULL, deleted_at = now() WHERE id = ${MEMBER}`;
            expect(await reachesOthers(OTHER_CIRCLE, 'groups', ['nachbarn'])).toBe(false);
        } finally {
            await sql`UPDATE users SET groups = ARRAY['household', 'users'],
                disabled_at = NULL, deleted_at = NULL WHERE id = ${MEMBER}`;
        }
    });

    it('policy household reach includes opted-in users without groups', async () => {
        expect(await reachesOthers(OUTSIDER, 'household', [])).toBe(true);
        // Isolated temporary users table also proves a one-person household is dark.
        await sql.begin(async (raw) => {
            const tx = raw as unknown as postgres.Sql;
            await tx`CREATE TEMP TABLE users (id uuid, deleted_at timestamptz, disabled_at timestamptz, share_audiobook_activity boolean DEFAULT true)
                ON COMMIT DROP`;
            await tx`INSERT INTO users (id) VALUES (${VIEWER})`;
            const [alone] = await tx<{ reachable: boolean }[]>`
                SELECT ${buildSocialAudienceReach(tx, 'subject', 'household', [])} AS reachable
                FROM users subject
            `;
            expect(alone.reachable).toBe(false);
            await tx`INSERT INTO users (id) VALUES (${MEMBER})`;
            const [together] = await tx<{ reachable: boolean }[]>`
                SELECT ${buildSocialAudienceReach(tx, 'subject', 'household', [])} AS reachable
                FROM users subject WHERE subject.id = ${VIEWER}::uuid
            `;
            expect(together.reachable).toBe(true);
        });
    });

    /**
     * The real call shape: a `users` row joined as `u_priv` next to the
     * per-user state rows, filtered by the shared predicate.
     */
    async function visible(
        options: {
            viewerId?: string;
            mediaId?: string;
            tier?: 'ambient' | 'activity';
            trustGroups?: readonly string[];
            audienceMode?: string;
            byColumn?: boolean;
        } = {},
    ): Promise<string[]> {
        const mediaId = options.mediaId ?? BOOK;
        const filter = buildSocialVisibilityFilter(sql, {
            viewerId: options.viewerId ?? VIEWER,
            media: options.byColumn ? { alias: 'ums', column: 'media_id' } : mediaId,
            subjectAlias: 'u_priv',
            tier: options.tier,
            trustGroups: options.trustGroups ?? TRUST,
            // Group mode unless a case says otherwise. These fixtures are all about
            // group matching, and under the default 'auto' an empty trustGroups would
            // silently switch them to household — turning "shows nothing" cases into
            // "shows everyone" and masking real group-matching regressions.
            audienceMode: options.audienceMode ?? 'groups',
        });
        const rows = await sql<{ username: string }[]>`
            SELECT u_priv.username
            FROM user_media_state ums
            JOIN users u_priv ON u_priv.id = ums.user_id
            WHERE ums.media_id = ${mediaId}::uuid
            ${filter}
            ORDER BY u_priv.username
        `;
        return rows.map((r) => r.username);
    }

    // -----------------------------------------------------------------------
    // The control: without it, every exclusion below proves nothing.
    // -----------------------------------------------------------------------

    it('shows exactly the people who share a designated group with the viewer', async () => {
        // svp_inapp_viewer is a household member too (via an in-app group) — it is
        // only called "viewer" because a later test looks FROM it.
        expect(await visible()).toEqual([
            'svp_case',
            'svp_inapp',
            'svp_inapp_viewer',
            'svp_member',
        ]);
    });

    // -----------------------------------------------------------------------
    // §7 matrix — each excludes on its own
    // -----------------------------------------------------------------------

    it('hide_streams excludes, independently of everything else', async () => {
        // svp_private is identical to svp_member apart from the flag.
        expect(await visible()).not.toContain('svp_private');

        await sql`UPDATE users SET hide_streams = false WHERE id = ${PRIVATE_MEMBER}`;
        expect(await visible()).toContain('svp_private');

        await sql`UPDATE users SET hide_streams = true WHERE id = ${PRIVATE_MEMBER}`;
        expect(await visible()).not.toContain('svp_private');
    });

    it('no shared designated group excludes, even when a broad group is shared', async () => {
        // svp_outsider shares `users` with the viewer and nothing else.
        expect(await visible()).not.toContain('svp_outsider');
        // svp_other is in its own circle and also shares `users`.
        expect(await visible()).not.toContain('svp_other');

        // Designating the second circle makes svp_other visible only if the VIEWER
        // is in it too — designation alone must not be enough.
        expect(await visible({ trustGroups: ['household', 'nachbarn'] })).not.toContain(
            'svp_other',
        );
    });

    it('two people in different designated circles cannot see each other', async () => {
        // The leak this predicate is shaped to avoid: both sides pass "is in a
        // designated group", and they do share a group — the broad `users` one.
        const seen = await visible({
            viewerId: OTHER_CIRCLE,
            trustGroups: ['household', 'nachbarn'],
        });
        expect(seen).toEqual([]);
    });

    it('the viewer never sees themselves', async () => {
        const seen = await visible();
        expect(seen).not.toContain('svp_viewer');
        // ...and is genuinely a circle member, so the exclusion is the self-check
        // and not a missing membership.
        expect(await visible({ viewerId: MEMBER })).toContain('svp_viewer');
    });

    it('a per-book opt-out excludes that book only', async () => {
        expect(await visible()).toContain('svp_member');

        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}, ${BOOK})
        `;

        expect(await visible()).not.toContain('svp_member');
        // The same person is still visible on the title they did not suppress.
        expect(await visible({ mediaId: OTHER_BOOK })).toContain('svp_member');
    });

    it('honours the opt-out when the media id comes from a column, not a parameter', async () => {
        // The rail form. A predicate that silently ignored the column reference
        // would look identical on the modal path and leak on the rail.
        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}, ${BOOK})
        `;
        expect(await visible({ byColumn: true })).not.toContain('svp_member');
        expect(await visible({ byColumn: true, mediaId: OTHER_BOOK })).toContain('svp_member');
    });

    // -----------------------------------------------------------------------
    // The union of both group sources — the reason this helper exists
    // -----------------------------------------------------------------------

    it('counts in-app access groups, not just users.groups', async () => {
        // svp_inapp has users.groups = NULL: on a standalone install this is the
        // ONLY shape there is. A predicate on users.groups alone returns [] here.
        expect(await visible()).toContain('svp_inapp');
    });

    it('is symmetric across the two group sources', async () => {
        // Viewer in-app-only, subject IdP-only — the asymmetric-visibility case.
        const seenByInApp = await visible({ viewerId: INAPP_VIEWER });
        expect(seenByInApp).toContain('svp_member');
        expect(seenByInApp).toContain('svp_viewer');

        // ...and back the other way.
        expect(await visible({ viewerId: MEMBER })).toContain('svp_inapp_viewer');
    });

    it('matches group names case- and whitespace-insensitively', async () => {
        // svp_case carries '  HOUSEHOLD ' from the IdP; the viewer carries
        // 'Household'; access_groups stores 'HouseHold'; the config says
        // 'household'. Postgres && would agree with none of them.
        expect(await visible()).toContain('svp_case');
        expect(await visible({ trustGroups: ['  HouseHold  '] })).toContain('svp_case');
    });

    // -----------------------------------------------------------------------
    // Unconfigured = dark, not open
    // -----------------------------------------------------------------------

    it('shows nothing at all when no trust circle is configured', async () => {
        expect(await visible({ trustGroups: [] })).toEqual([]);
        // Whitespace-only entries are not a configuration.
        expect(await visible({ trustGroups: ['   ', ''] })).toEqual([]);
        expect(isSocialSharingConfigured(['  '], 'groups')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Household audience
    // -----------------------------------------------------------------------

    it('household mode ignores groups entirely and shows everyone sharing', async () => {
        const seen = await visible({ audienceMode: 'household', trustGroups: [] });
        // The group-mode fixtures: an outsider in NO designated group, and a member
        // of a DIFFERENT circle, both become visible because there is no group test.
        expect(seen).toContain('svp_member');
        expect(seen).toContain('svp_outsider');
        expect(seen).toContain('svp_other');
    });

    it('household mode still honours every non-audience gate', async () => {
        const seen = await visible({ audienceMode: 'household', trustGroups: [] });
        // hide_streams is a master opt-out and outranks the audience.
        expect(seen).not.toContain('svp_private');
        // Never yourself.
        expect(seen).not.toContain('svp_viewer');
    });

    it('household mode honours the per-item opt-out', async () => {
        const before = await visible({ audienceMode: 'household', trustGroups: [] });
        expect(before).toContain('svp_member');

        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}::uuid, ${BOOK}::uuid)
            ON CONFLICT DO NOTHING
        `;
        try {
            const after = await visible({ audienceMode: 'household', trustGroups: [] });
            expect(after).not.toContain('svp_member');
        } finally {
            await sql`
                DELETE FROM user_media_share_opt_out
                WHERE user_id = ${MEMBER}::uuid AND media_id = ${BOOK}::uuid
            `;
        }
    });

    it('household mode excludes deactivated and soft-deleted accounts', async () => {
        // The clause exists FOR household: under group mode a dead account only
        // leaked if an admin had put it in the circle, but household puts every row
        // in `users` in the audience. Without this, a deactivated person keeps
        // broadcasting their reading position forever.
        expect(await visible({ audienceMode: 'household', trustGroups: [] })).toContain(
            'svp_member',
        );

        await sql`UPDATE users SET disabled_at = now() WHERE id = ${MEMBER}::uuid`;
        try {
            expect(await visible({ audienceMode: 'household', trustGroups: [] })).not.toContain(
                'svp_member',
            );
        } finally {
            await sql`UPDATE users SET disabled_at = NULL WHERE id = ${MEMBER}::uuid`;
        }

        await sql`UPDATE users SET deleted_at = now() WHERE id = ${MEMBER}::uuid`;
        try {
            expect(await visible({ audienceMode: 'household', trustGroups: [] })).not.toContain(
                'svp_member',
            );
        } finally {
            await sql`UPDATE users SET deleted_at = NULL WHERE id = ${MEMBER}::uuid`;
        }
    });

    it('group mode also excludes dead accounts', async () => {
        expect(await visible()).toContain('svp_member');
        await sql`UPDATE users SET disabled_at = now() WHERE id = ${MEMBER}::uuid`;
        try {
            expect(await visible()).not.toContain('svp_member');
        } finally {
            await sql`UPDATE users SET disabled_at = NULL WHERE id = ${MEMBER}::uuid`;
        }
    });

    it('auto picks household with no groups and groups once any are named', async () => {
        // Same call, same fixtures — only the configured group list differs.
        const asHousehold = await visible({ audienceMode: 'auto', trustGroups: [] });
        expect(asHousehold).toContain('svp_outsider');

        const asGroups = await visible({ audienceMode: 'auto', trustGroups: TRUST });
        expect(asGroups).not.toContain('svp_outsider');
        expect(asGroups).toContain('svp_member');
    });

    it('a configured circle nobody is in shows nothing, and is not an error', async () => {
        expect(await visible({ trustGroups: ['does-not-exist'] })).toEqual([]);
        expect(isSocialSharingConfigured(['does-not-exist'])).toBe(true);
    });

    // -----------------------------------------------------------------------
    // The coarse activity tier is reciprocal
    // -----------------------------------------------------------------------

    it('activity tier requires the subject to have opted in', async () => {
        expect(await visible({ tier: 'activity' })).toContain('svp_member');

        await sql`
            UPDATE users SET share_listening_activity = false WHERE id = ${MEMBER}
        `;
        expect(await visible({ tier: 'activity' })).not.toContain('svp_member');
        // The ambient tier is unaffected — the flag gates the rail, not the modal.
        expect(await visible({ tier: 'ambient' })).toContain('svp_member');
    });

    it('activity tier requires the VIEWER to have opted in (no lurking)', async () => {
        expect(await visible({ tier: 'activity' })).not.toEqual([]);

        await sql`
            UPDATE users SET share_listening_activity = false WHERE id = ${VIEWER}
        `;
        expect(await visible({ tier: 'activity' })).toEqual([]);
        // ...while the ambient tier still works, so this is the reciprocity gate
        // and not a broken predicate.
        expect(await visible({ tier: 'ambient' })).not.toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Normalisation helper
    // -----------------------------------------------------------------------

    it('normalises the configured circle list without folding its case', () => {
        // Trim + de-dup + drop empties, but the operator's spelling survives: the
        // case fold is Postgres `lower()`'s job on BOTH sides (see the case test
        // above), and doing half of it here is what made the two disagree.
        expect(
            getDesignatedTrustGroups([' Household ', 'Household', '', '  ', 'nachbarn']),
        ).toEqual(['Household', 'nachbarn']);
    });

    it('rejects an unsafe subject alias instead of interpolating it', () => {
        expect(() =>
            buildSocialVisibilityFilter(sql, {
                viewerId: VIEWER,
                media: BOOK,
                subjectAlias: 'u_priv"; DROP TABLE users; --',
                trustGroups: TRUST,
            }),
        ).toThrow(/invalid subjectAlias/);
    });

    it('rejects a literal media id that is not a UUID', () => {
        // Reaching Postgres with this produced a raw 22P02 from inside a builder,
        // naming neither the caller nor the value.
        expect(() =>
            buildSocialVisibilityFilter(sql, {
                viewerId: VIEWER,
                media: 'tmdb:550:movie',
                trustGroups: TRUST,
            }),
        ).toThrow(/invalid media id/);
        // The column form is unaffected — it is an identifier, not a value.
        expect(() =>
            buildSocialVisibilityFilter(sql, {
                viewerId: VIEWER,
                media: { alias: 'ums', column: 'media_id' },
                trustGroups: TRUST,
            }),
        ).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // Catalogue dismissal
    // -----------------------------------------------------------------------

    it('stops sharing a book that has been dismissed from the catalogue', async () => {
        // Decided here rather than left implicit (the design doc calls it open):
        // a dismissed row is filtered out of every browse read, so broadcasting a
        // position in it advertises a title nobody in the circle can open.
        expect(await visible()).toContain('svp_member');

        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${BOOK}`;
        try {
            expect(await visible()).toEqual([]);
            // The OTHER book is untouched, so this is the dismissal and not a
            // predicate that collapsed.
            expect(await visible({ mediaId: OTHER_BOOK })).toContain('svp_member');
        } finally {
            await sql`UPDATE media_items SET is_dismissed = false WHERE id = ${BOOK}`;
        }
    });

    it('applies dismissal on the column form too, per row', async () => {
        // The rail passes a column reference. A dismissal check wired only into the
        // literal branch would look correct on the modal and leak on the rail.
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${BOOK}`;
        try {
            expect(await visible({ byColumn: true })).toEqual([]);
            expect(await visible({ byColumn: true, mediaId: OTHER_BOOK })).toContain('svp_member');
        } finally {
            await sql`UPDATE media_items SET is_dismissed = false WHERE id = ${BOOK}`;
        }
    });

    // -----------------------------------------------------------------------
    // Case folding happens in ONE place
    // -----------------------------------------------------------------------

    it('matches a non-ASCII circle name whatever case each side stores', async () => {
        // HONEST SCOPE: this case does NOT discriminate the single-place fold. It
        // was measured to pass both before and after that change, because
        // `lumastra_tests` runs `en_US.utf8`, where Postgres `lower()` and JS
        // `toLowerCase()` happen to agree on 'Í'. The divergence needs a `C`-locale
        // database, which this suite cannot create.
        //
        // What it does prove is that a non-ASCII circle works end-to-end at all —
        // and it is the reason the JS half must stop folding: that half is pinned
        // by `social-visibility.builder.test.ts` ("does NOT lowercase"), which
        // fails against the old code.
        await sql`UPDATE users SET groups = ARRAY['FAMÍLIA'] WHERE id = ${MEMBER}`;
        await sql`UPDATE users SET groups = ARRAY['família'] WHERE id = ${VIEWER}`;
        try {
            expect(await visible({ trustGroups: ['Família'] })).toContain('svp_member');
        } finally {
            await sql`UPDATE users SET groups = ARRAY['household', 'users'] WHERE id = ${MEMBER}`;
            await sql`UPDATE users SET groups = ARRAY['Household', 'users'] WHERE id = ${VIEWER}`;
        }
    });

    // -----------------------------------------------------------------------
    // Tier exhaustiveness
    // -----------------------------------------------------------------------

    it('throws on a tier it does not handle instead of silently serving ambient', async () => {
        // A third tier added to the union without updating the predicate used to
        // fall through to the WEAKER ambient behaviour — a downgrade with no error.
        expect(() =>
            buildSocialVisibilityFilter(sql, {
                viewerId: VIEWER,
                media: BOOK,
                trustGroups: TRUST,
                // Deliberately outside the union: this is the shape a future tier
                // arrives in before anyone remembers this file.
                tier: 'precise' as 'ambient',
            }),
        ).toThrow(/unhandled sharing tier/);
    });
});
