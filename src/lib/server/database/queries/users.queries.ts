// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Users Query Module
 *
 * Centralized queries for the local `users` table, which stores OIDC-synced
 * user records. Admin status follows the "OIDC-authoritative with pin override"
 * pattern: by default is_admin syncs from IdP groups on every request, but an
 * admin can "pin" a user's status to override the IdP value.
 */

import type postgres from 'postgres';
import { defaultActivitySharing } from '$lib/server/config/activity-sharing.js';

import { toUserId, type UserId } from '$lib/shared/user-id';
import { foldUsername } from '$lib/shared/username-fold.js';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { withTx } from '$lib/server/database/with-tx.js';
// hasGroupPermission (fix plan 6, C5 fix round 2, controller ruling): Formula
// A's OWN name-match primitive, imported rather than re-implemented in SQL —
// see setupGateAdminExists()'s doc comment for why. No import cycle: auth.ts
// imports only config.js and utils/age-rating-resolver.ts, neither of which
// reaches back into database/queries/.
import { buildUserPermissions, hasGroupPermission } from '$lib/server/auth.js';

const logger = Logger.for('UsersQueries');

// =============================================================================
// Types
// =============================================================================

export interface UserRow {
    id: string;
    username: string;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
    allow_live_tv?: boolean | null;
    display_name: string | null;
    email: string | null;
    hide_streams: boolean;
    groups: string[] | null;
    groups_updated_at: Date | null;
    created_at: Date;
    updated_at: Date;
    last_seen_at: Date | null;
    disabled_at: Date | null;
    /**
     * Soft-delete marker. `deleteUser` in this codebase is a hard DELETE and
     * nothing in server code currently writes this column (security review
     * 2026-09-16, task 6 follow-up) — selecting it here is defence in depth
     * for a column that exists in the schema and is already read/enforced
     * elsewhere (`getUserIdByUsername`, `pat.service.ts`,
     * `jellyfin-compat/middleware.ts`'s live re-check), not a response to a
     * live exploit. Without it, `getUserByUsername` — the read every
     * token→user resolver in `resolve-token-user-access.ts` funnels through —
     * could not tell a soft-deleted row from an active one.
     */
    deleted_at: Date | null;
    avatar_data: Buffer | null;
    avatar_content_type: string | null;
    /** True when the user has an ACTIVE or PAUSED play_sessions row right now. Only populated by `listUsers`. */
    currently_streaming?: boolean;
    /** MAX(GREATEST(started_at, last_heartbeat_at)) across the user's play_sessions. Only populated by `listUsers`. */
    last_activity_at?: Date | null;
    /** media_items.title for the user's most recent play_sessions row. Only populated by `listUsers`. */
    last_watched_title?: string | null;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Result of {@link upsertUser}: the row's stable id, plus whether this write
 * itself flipped `is_admin` (only possible for an UNPINNED existing row —
 * see the CASE in the query). `demoted`/`promoted` are both `false` for a
 * brand-new row (nothing to transition FROM) and for a pinned row (the CASE
 * never changes `is_admin` for one).
 */
export interface UpsertUserResult {
    id: string;
    isAdmin: boolean;
    demoted: boolean;
    promoted: boolean;
    /** The row did not exist before this call (`promoted` is false for it). */
    created?: boolean;
}

/**
 * How long a forward-auth upsert may leave `last_seen_at` / `updated_at`
 * untouched when nothing else about the row changed. The admin user list and
 * the licence seat count (days) read these at minute resolution at best.
 */
export const UPSERT_LAST_SEEN_REFRESH_SECONDS = 60;

/**
 * Upsert a user record on every login.
 *
 * INSERT: creates row with is_admin derived from IdP groups (admin_pinned=false).
 * ON CONFLICT: syncs is_admin from IdP groups ONLY if not pinned. Pinned users
 * keep their manually-set admin status regardless of IdP group changes.
 *
 * `display_name` is BACKFILLED rather than overwritten: `COALESCE(EXCLUDED, users)`
 * means a login that carries a name fills a NULL — so users who predate the
 * NAMEHEADER feature get one on their next request, not only new accounts —
 * while a login WITHOUT one (proxy stopped sending the header, an OIDC or
 * native-auth caller that never had it) leaves the stored name intact. A plain
 * assignment would blank every name the first time any caller omitted it.
 * Callers must therefore pass a SANITISED value (see sanitizeDisplayName) — the
 * name is rendered to other users, and this write is the last boundary.
 *
 * Returns whether THIS call demoted or promoted the user (security review
 * 2026-09-16, fix round 1 review, Important 3): `forward-auth.ts`'s two
 * callers use this to narrow/restore admin-scoped PAT/service-token access
 * in lockstep with the IdP-group-driven admin transition — group-driven
 * demotion is the PRIMARY demotion path on an Authentik forward-auth
 * deployment (an unpinned user simply loses `ADMIN_GROUPS` membership on
 * their next login), and a C4 fix that only covered the explicit admin-API
 * write sites left this path completely unnarrowed. The `before` CTE reads
 * the row's PRE-statement `is_admin`/`admin_pinned` (a data-modifying
 * statement's read-only CTEs all see the same pre-statement snapshot as the
 * main statement, per Postgres semantics) — zero rows for a brand-new user,
 * so `previous_is_admin` is `NULL` and both flags come back `false`.
 */
export async function upsertUser(
    sql: postgres.Sql,
    params: {
        username: string;
        isAdmin: boolean;
        maxAgeRating?: number | null;
        displayName?: string | null;
        email?: string | null;
    },
): Promise<UpsertUserResult> {
    const sharing = defaultActivitySharing();
    // One statement, one round trip. The INSERT ... SELECT is skipped (no row
    // lock, no new tuple version, no WAL) when the stored row already equals
    // what the ON CONFLICT branch below would write AND last_seen_at is fresh
    // (UPSERT_LAST_SEEN_REFRESH_SECONDS). Forward auth calls this on nearly
    // every request; before the skip it was ~1,270 row rewrites an hour on the
    // same few users rows, and at the nightly checkpoint those writers queued
    // on one row for up to 36 s behind slow commits.
    //
    // "Unchanged" mirrors the DO UPDATE assignments exactly: is_admin and
    // max_age_rating only count when the matching *_pinned flag is false (a
    // pinned row ignores the parameter), and display_name only when a name was
    // supplied (COALESCE keeps the stored one otherwise).
    //
    // The skipped path reports is_admin from this statement's snapshot. A pin or
    // demote committing in the same milliseconds is seen by the next request, as
    // it would be had this request arrived a moment earlier.
    const maxAgeRating = params.maxAgeRating ?? null;
    const displayName = params.displayName ?? null;
    const rows = await sql<
        Array<{ id: string; is_admin: boolean; previous_is_admin: boolean | null }>
    >`
        WITH before AS (
            SELECT id, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name,
                   last_seen_at
            FROM users WHERE username = ${params.username}
        ),
        written AS (
            INSERT INTO users (allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity, username, is_admin, max_age_rating, display_name, email, last_seen_at, updated_at)
            SELECT
                ${maxAgeRating === null ? null : false}::boolean, ${!sharing}::boolean, ${sharing}::boolean, ${sharing}::boolean,
                ${params.username}::text,
                ${params.isAdmin}::boolean,
                ${maxAgeRating}::int,
                ${displayName}::text,
                NULL::text, -- Forward-auth email assertions have no verification proof.
                NOW(),
                NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM before b
                WHERE b.last_seen_at > NOW() - make_interval(secs => ${UPSERT_LAST_SEEN_REFRESH_SECONDS}::float8)
                  -- A future stamp (clock stepped back) must not extend the skip.
                  AND b.last_seen_at <= NOW()
                  AND (b.admin_pinned OR b.is_admin = ${params.isAdmin}::boolean)
                  AND (b.age_rating_pinned OR b.max_age_rating IS NOT DISTINCT FROM ${maxAgeRating}::int)
                  AND (${displayName}::text IS NULL OR b.display_name IS NOT DISTINCT FROM ${displayName}::text)
            )
            ON CONFLICT (username) DO UPDATE SET
                is_admin       = CASE WHEN users.admin_pinned THEN users.is_admin ELSE ${params.isAdmin} END,
                -- A rating fallback may create a bare row before its first authentication.
                -- Only unprovisioned rows adopt the creation default; returning accounts
                -- and explicit admin decisions retain their existing choice.
                allow_live_tv = CASE WHEN users.allow_live_tv IS NULL
                    AND users.last_seen_at IS NULL AND users.groups_updated_at IS NULL
                    AND users.password_hash IS NULL AND users.max_age_rating IS NULL AND NOT users.age_rating_pinned
                    THEN EXCLUDED.allow_live_tv ELSE users.allow_live_tv END,
                max_age_rating = CASE WHEN users.age_rating_pinned THEN users.max_age_rating ELSE ${maxAgeRating} END,
                display_name   = COALESCE(EXCLUDED.display_name, users.display_name),
                last_seen_at   = NOW(),
                updated_at     = NOW()
            RETURNING id, is_admin
        )
        SELECT id, is_admin, (SELECT is_admin FROM before) AS previous_is_admin FROM written
        UNION ALL
        SELECT id, is_admin, is_admin FROM before WHERE NOT EXISTS (SELECT 1 FROM written)
    `;
    const row = rows[0];
    const wasAdmin = row.previous_is_admin === true;
    const nowAdmin = row.is_admin === true;
    return {
        id: row.id,
        isAdmin: nowAdmin,
        demoted: wasAdmin && !nowAdmin,
        promoted: row.previous_is_admin === false && nowAdmin,
        created: row.previous_is_admin === null,
    };
}

/**
 * Insert a brand-new federated (e.g. OIDC) user, FAILING on a username collision
 * rather than merging. This is deliberately NOT upsertUser: an OIDC provision must
 * never silently fold its identity into a pre-existing, unrelated account that
 * happens to share the derived username — that would be an account-hijack. Returns
 * the new user's id, or null if the username is already taken (the caller then
 * derives a collision-suffixed username and retries).
 *
 * admin_pinned is left false: OIDC group membership is authoritative and should
 * keep syncing is_admin on each login (an operator can still pin later).
 */
export async function insertFederatedUser(
    sql: postgres.Sql,
    params: {
        username: string;
        isAdmin: boolean;
        groups: string[];
        email?: string | null;
        displayName?: string | null;
    },
): Promise<string | null> {
    const sharing = defaultActivitySharing();
    const insert = (email: string | null): Promise<{ id: string }[]> => sql<{ id: string }[]>`
        INSERT INTO users (allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity, username, is_admin, admin_pinned, groups, groups_updated_at, email, display_name, last_seen_at, updated_at)
        VALUES (
            ${buildUserPermissions(params.groups, { isAdminOverride: params.isAdmin }).isAgeRestricted ? false : null}, ${!sharing}, ${sharing}, ${sharing},
            ${params.username.toLowerCase()},
            ${params.isAdmin},
            false,
            ${params.groups},
            NOW(),
            ${email},
            ${params.displayName ?? null},
            NOW(),
            NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING id
    `;
    const email = params.email?.trim().toLowerCase() || null;
    let rows = await insert(email);
    // Either a username or normalized-email collision may suppress the insert.
    // NULL email removes only the email conflict; an occupied username still
    // returns null so the caller can allocate a suffix. No aborted transaction.
    if (!rows.length && email) rows = await insert(null);
    return rows[0]?.id ?? null;
}

/**
 * Get a single user by username. Returns null if not found.
 *
 * Deliberately does NOT filter `WHERE deleted_at IS NULL` (unlike
 * `getUserIdByUsername`'s four sibling lookups): every caller of this
 * function is a permission/lifecycle resolver (`resolve-token-user-access.ts`,
 * `resolveDbAuth`, `jellyfin-compat/livetv-token-access.ts`, the Quick
 * Connect authorize def) that needs the RAW row — including a soft-deleted
 * one — so it can inspect `deleted_at` itself and deny, rather than have a
 * deleted user silently look identical to "no such user" everywhere this is
 * called. Selecting `deleted_at` (added security review 2026-09-16, task 6
 * follow-up) is what makes that inspection possible; before this, a caller
 * had no way to tell a soft-deleted row from an active one through this
 * function at all.
 */
export async function getUserByUsername(
    sql: postgres.Sql,
    username: string,
): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        SELECT id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at, disabled_at, deleted_at
        FROM users
        WHERE username = ${username}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Resolve a username → stable users.id UUID (branded UserId), or null if no
 * such user. Used by admin-PREVIEW surfaces that hold a (possibly impersonated)
 * username from `getEffectiveUser` and must key user-data by UUID (mig 16.46.0).
 * Mints the brand at this trusted DB-read boundary.
 *
 * Usernames are stored lowercase (all creation paths call toLowerCase before
 * insert). The lookup is case-insensitive so that a mixed-case path param
 * from an admin request resolves correctly, consistent with other username
 * queries in this module (e.g. getNativeLoginRecord, getJellyfinMapping).
 */
export async function getUserIdByUsername(
    sql: postgres.Sql,
    username: string,
): Promise<UserId | null> {
    // `deleted_at IS NULL`, as four other lookups in this module already do.
    // Without it a soft-deleted account still resolved, and every caller here
    // takes the id to READ that user's data — watch history, excluded series,
    // Jellyfin permissions. Resolving to null instead means their data is not
    // read, which is the direction to fail in.
    //
    // No ORDER BY is needed alongside LIMIT 1: usernames are stored lowercase
    // (every creation path lowercases before insert), so the case-insensitive
    // comparison can match at most one row.
    const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM users
        WHERE LOWER(username) = LOWER(${username}) AND deleted_at IS NULL
        LIMIT 1
    `;
    return rows[0] ? toUserId(rows[0].id) : null;
}

/**
 * Batch-resolve active login names to `{ id, username }`, keyed by the shared
 * trimmed, NFC-normalized, lowercase form. Omit `names` to resolve every active
 * user; pass a list to retain only matching canonical keys.
 *
 * For providers whose usernames match Lumastra's by construction rather than via
 * a per-user override column — AudiobookShelf, whose accounts come from the same
 * Authentik directory Lumastra authenticates against. (Jellyfin has its own
 * resolver, `resolveJellyfinNamesToUserIds`, because it honours the
 * `jellyfin_username` override; do not use this one for it.)
 *
 * Fail-closed on ambiguity, same policy as `collisionSafeUserIdMap`: `username`
 * is case-sensitive-unique, so `Alice` and `alice` (or canonically equivalent
 * Unicode spellings) can both exist and collide on the folded key. Rather than
 * pick one at random — which would attribute a stranger's listening session to
 * the wrong person's name and avatar — both are dropped and the caller treats
 * the name as unmatched. Disabled and soft-deleted users are never returned.
 *
 * A name with no Lumastra account simply has no entry. Callers MUST NOT invent a
 * sentinel id for it.
 *
 * COST: this reads every active user and folds in JS rather than pushing the
 * match into SQL. That is deliberate — Postgres has no NFC normalization, so a
 * `LOWER(username) = ANY(...)` predicate would silently miss canonically
 * equivalent spellings, which is the bug this function exists to prevent. The
 * trade is a full scan of `users` per call (watch-sync pull, direct-sessions
 * poll). Fine for a household or small-team instance; if this ever runs on an
 * instance with a large user table, add a covering index and pre-filter on the
 * ASCII-foldable majority before reaching for a schema change.
 */
export async function resolveUsernamesToUsers(
    sql: postgres.Sql,
    names?: readonly string[],
): Promise<Map<string, { id: UserId; username: string }>> {
    if (names?.length === 0) return new Map();

    const rows = await sql<Array<{ id: string; username: string }>>`
        SELECT id, username
        FROM users
        WHERE disabled_at IS NULL
          AND deleted_at IS NULL
    `;
    const targets = names ? new Set(names.map(foldUsername)) : null;
    const eligibleRows = targets
        ? rows.filter((row) => targets.has(foldUsername(row.username)))
        : rows;

    const counts = new Map<string, number>();
    for (const row of eligibleRows) {
        const key = foldUsername(row.username);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const map = new Map<string, { id: UserId; username: string }>();
    const collisions: string[] = [];
    for (const row of eligibleRows) {
        const key = foldUsername(row.username);
        if ((counts.get(key) ?? 0) > 1) {
            if (!collisions.includes(key)) collisions.push(key);
            continue;
        }
        map.set(key, { id: toUserId(row.id), username: row.username });
    }

    if (collisions.length > 0) {
        logger.warn(
            'Ambiguous username(s) map to multiple Lumastra users — treating as unmatched ' +
                'rather than attributing activity to an arbitrary one of them.',
            { collisions },
        );
    }

    return map;
}

/**
 * Find active (non-disabled) users whose email matches (case-insensitively). Used
 * by the OIDC verified-email account-linking guard, which links only when EXACTLY
 * ONE active user matches — more than one match is ambiguous and must NOT auto-link
 * (it would non-deterministically pick a takeover target). Disabled accounts are
 * excluded so a suspended user can't be silently re-attached via email.
 */
export async function getActiveUsersByEmail(
    sql: postgres.Sql,
    email: string,
): Promise<Array<{ id: string; username: string }>> {
    return sql<Array<{ id: string; username: string }>>`
        SELECT id, username
        FROM users
        WHERE LOWER(BTRIM(email)) = LOWER(BTRIM(${email}))
          AND email IS NOT NULL
          AND disabled_at IS NULL
          AND deleted_at IS NULL
    `;
}

/** Must be called inside the email-link transaction; serializes link decisions. */
export async function lockAdminEmailLinkTarget(
    sql: postgres.Sql,
    userId: string,
    email: string,
): Promise<{ id: string; username: string; is_admin: boolean } | null> {
    const rows = await sql<Array<{ id: string; username: string; is_admin: boolean }>>`
        SELECT id, username, is_admin FROM users
        WHERE id = ${userId}
          AND LOWER(BTRIM(email)) = LOWER(BTRIM(${email}))
          AND email_set_by_admin_at IS NOT NULL
          AND disabled_at IS NULL AND deleted_at IS NULL
        FOR UPDATE
    `;
    return rows[0] ?? null;
}

/**
 * Get a user by id. Returns null if not found. Used by OIDC login resolution,
 * which holds a user_id (from the identity link) and needs the username + the
 * disabled/deleted lifecycle flags before minting a session — also used by
 * `tasks/api-auth.ts`'s service-token impersonation-target lookup, which is
 * why `deleted_at` is selected (security review 2026-09-17, C17 — it was
 * missing from this SELECT despite `UserRow` typing the field as non-optional
 * `Date | null`, so a caller reading `row.deleted_at` got `undefined`, not a
 * real column value).
 */
export async function getUserById(sql: postgres.Sql, id: string): Promise<UserRow | null> {
    // A username or other non-UUID string can't match, and Postgres would throw
    // on the uuid cast. Admin routes pass the path id straight through.
    if (!isUuid(id)) return null;
    const rows = await sql<UserRow[]>`
        SELECT id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at, disabled_at, deleted_at
        FROM users
        WHERE id = ${id}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Resolve a set of users.id UUIDs to their usernames in one round-trip.
 * Returns a Map keyed by the lowercased id → username. Missing ids are simply
 * absent from the map. Used by the social activity feed to label review authors
 * (whose rows carry only the users.id UUID) without an N+1 lookup.
 */
export async function getUsernamesByIds(
    sql: postgres.Sql,
    ids: string[],
): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await sql<Array<{ id: string; username: string }>>`
        SELECT id, username FROM users WHERE id = ANY(${ids}::uuid[])
    `;
    return new Map(rows.map((r) => [r.id.toLowerCase(), r.username]));
}

// =============================================================================
// Jellyfin account mapping (migration 16.45.0)
// =============================================================================

export interface JellyfinMapping {
    /** Optional Jellyfin login override; NULL means "use the Lumastra username". */
    jellyfin_username: string | null;
    /** Cached stable Jellyfin user UUID, or NULL until first resolved. */
    jellyfin_user_id: string | null;
}

/** Read a user's Jellyfin mapping by (lowercased) username. Null if no such user. */
export async function getJellyfinMapping(
    sql: postgres.Sql,
    username: string,
): Promise<JellyfinMapping | null> {
    const rows = await sql<JellyfinMapping[]>`
        SELECT jellyfin_username, jellyfin_user_id
        FROM users
        WHERE LOWER(username) = LOWER(${username})
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Read a user's Jellyfin mapping by stable `users.id` UUID (UserId). Null if no
 * such user. Mirrors {@link getJellyfinMapping} but keys by the immutable id
 * (callers that hold a `users.id` UUID post-mig-16.46.0 use this instead of the
 * username variant) and ALSO returns the `username` — needed for the same-name
 * API fallback and the username-keyed UUID cache write.
 */
export async function getJellyfinMappingById(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{
    username: string;
    jellyfin_username: string | null;
    jellyfin_user_id: string | null;
} | null> {
    const rows = await sql<
        Array<{
            username: string;
            jellyfin_username: string | null;
            jellyfin_user_id: string | null;
        }>
    >`
        SELECT username, jellyfin_username, jellyfin_user_id
        FROM users
        WHERE id = ${userId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Cache the resolved Jellyfin UUID for a user, but only when it is not already set
 * (idempotent cache fill — never clobbers a value an admin's re-resolve just wrote).
 */
export async function cacheJellyfinUserId(
    sql: postgres.Sql,
    username: string,
    jellyfinUserId: string,
): Promise<void> {
    await sql`
        UPDATE users
        SET jellyfin_user_id = ${jellyfinUserId}, updated_at = NOW()
        WHERE LOWER(username) = LOWER(${username})
          AND jellyfin_user_id IS DISTINCT FROM ${jellyfinUserId}
    `;
}

/**
 * Set (or clear, with null) a user's Jellyfin username override by user id. ALWAYS
 * clears the cached jellyfin_user_id so the next resolution re-derives it from the
 * new name. Returns the updated row, or null if the user does not exist.
 */
export async function setJellyfinUsername(
    sql: postgres.Sql,
    userId: string,
    jellyfinUsername: string | null,
): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        UPDATE users
        SET jellyfin_username = ${jellyfinUsername},
            jellyfin_user_id = NULL,
            updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at, disabled_at
    `;
    return rows[0] ?? null;
}

/**
 * List all users with their Jellyfin mapping (admin UI). One JF-name→Lumastra-name
 * map for the watch-sync attribution uses COALESCE(jellyfin_username, username).
 */
export async function getJellyfinUsernameMap(
    sql: postgres.Sql,
): Promise<Array<{ username: string; jellyfin_name: string }>> {
    return sql<Array<{ username: string; jellyfin_name: string }>>`
        SELECT username, COALESCE(jellyfin_username, username) AS jellyfin_name
        FROM users
    `;
}

/**
 * Shared INGEST-direction resolver for Jellyfin (and same-name provider) sync.
 *
 * Maps each provider login name (Jellyfin's reported username) to the stable
 * Lumastra `users.id` UUID, matching on `LOWER(COALESCE(jellyfin_username,
 * username))` so the per-user Jellyfin-name override (migration 16.45.0) is
 * honored. The key is the lowercased provider name; the value is a branded
 * `UserId` minted from a real `users.id` read.
 *
 * Provider users with NO matching Lumastra account simply have no entry — the
 * caller MUST skip their items (never invent a sentinel/NULL UUID; see the
 * re-key orphan policy). Used by BOTH the watch-sync pull and the
 * active-sessions observed-session attribution.
 *
 * `names` is optional: pass the set of observed provider names to bound the
 * query, or omit to map every user (the pull path filters afterward anyway).
 */
export async function resolveJellyfinNamesToUserIds(
    sql: postgres.Sql,
    names?: readonly string[],
): Promise<Map<string, UserId>> {
    const rows =
        names && names.length > 0
            ? await sql<Array<{ id: string; jellyfin_name: string }>>`
                  SELECT id, LOWER(COALESCE(jellyfin_username, username)) AS jellyfin_name
                  FROM users
                  WHERE LOWER(COALESCE(jellyfin_username, username)) = ANY(
                      ${sql.array(names.map((n) => n.toLowerCase()))}::text[]
                  )
              `
            : await sql<Array<{ id: string; jellyfin_name: string }>>`
                  SELECT id, LOWER(COALESCE(jellyfin_username, username)) AS jellyfin_name
                  FROM users
              `;
    const { map, collisions } = collisionSafeUserIdMap(rows);
    if (collisions.length > 0) {
        logger.warn(
            'Ambiguous Jellyfin name(s) map to multiple Lumastra users — skipping to avoid ' +
                'cross-attributing watch state. Disambiguate via per-user jellyfin_username, ' +
                'or unique (case-insensitive) usernames.',
            { collisions },
        );
    }
    return map;
}

/**
 * Build the provider-name → `UserId` map, EXCLUDING any provider name claimed by
 * more than one Lumastra user. `users.username` is case-sensitive-unique and
 * `jellyfin_username` has no uniqueness constraint, so two users can collide on
 * `LOWER(COALESCE(jellyfin_username, username))` (e.g. `Alice` + `alice`). A
 * last-write-wins map would silently attribute one user's watch history to the
 * other; instead we drop ALL colliding entries (fail-closed) and report them so
 * the caller can warn. Pure + unit-tested.
 */
export function collisionSafeUserIdMap(
    rows: ReadonlyArray<{ id: string; jellyfin_name: string }>,
): { map: Map<string, UserId>; collisions: string[] } {
    const counts = new Map<string, number>();
    for (const row of rows) {
        counts.set(row.jellyfin_name, (counts.get(row.jellyfin_name) ?? 0) + 1);
    }
    const map = new Map<string, UserId>();
    const collisions: string[] = [];
    for (const row of rows) {
        if ((counts.get(row.jellyfin_name) ?? 0) > 1) {
            if (!collisions.includes(row.jellyfin_name)) collisions.push(row.jellyfin_name);
            continue;
        }
        map.set(row.jellyfin_name, toUserId(row.id));
    }
    return { map, collisions };
}

/**
 * List all users, most recently seen first.
 * No pagination — acceptable for an internal admin UI with small user counts.
 *
 * Also aggregates per-user playback activity from `play_sessions` via a single
 * LEFT JOIN LATERAL (no N+1 queries): whether the user currently has an
 * ACTIVE/PAUSED session, the timestamp of their most recent activity
 * (`GREATEST(started_at, last_heartbeat_at)`), and the title of the last
 * media they played. Users with no play_sessions rows get
 * `currently_streaming = false` and null activity/title.
 */
/** A `listUsers` row: the base user plus directory-only sign-in and activity facts. */
export interface ListedUserRow extends UserRow {
    has_native_password: boolean;
    identity_providers: string[];
    jellyfin_linked: boolean;
    api_token_count: number;
    currently_streaming: boolean;
    last_activity_at: Date | null;
    last_activity_source: string | null;
    last_watched_title: string | null;
}

export async function listUsers(sql: postgres.Sql): Promise<ListedUserRow[]> {
    // The media_items join below only surfaces a title string for operator
    // visibility (last_watched_title) on an admin-only surface — GET
    // /api/admin/users requires the users:admin scope, enforced by
    // defineEndpoint's auth spec before this ever runs. It is not a media
    // listing subject to per-user library/age scoping.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- see comment above
    return sql<ListedUserRow[]>`
        SELECT
            u.id, u.username, u.is_admin, u.admin_pinned, u.max_age_rating, u.age_rating_pinned, u.allow_live_tv,
            u.display_name, u.email, u.hide_streams, u.groups, u.groups_updated_at,
            u.created_at, u.updated_at, u.last_seen_at, u.disabled_at,
            -- Sign-in evidence for the directory's "Sign-in" column and its
            -- "Needs attention" filter. Without these the page could only guess
            -- from groups, and flagged Jellyfin-only and token-only accounts
            -- as having no way in.
            (u.password_hash IS NOT NULL) AS has_native_password,
            ARRAY(
                SELECT DISTINCT ui.provider FROM user_identities ui
                WHERE ui.user_id = u.id ORDER BY ui.provider
            ) AS identity_providers,
            (u.jellyfin_user_id IS NOT NULL) AS jellyfin_linked,
            (
                (SELECT count(*) FROM personal_access_tokens pat
                 WHERE pat.user_id = u.id AND pat.revoked_at IS NULL
                   AND (pat.expires_at IS NULL OR pat.expires_at > now()))
                + (SELECT count(*) FROM service_tokens st
                 WHERE st.act_as_user = u.id AND st.revoked_at IS NULL
                   AND (st.expires_at IS NULL OR st.expires_at > now()))
            )::int AS api_token_count,
            COALESCE(recent.currently_streaming, false) AS currently_streaming,
            recent.last_activity_at,
            recent.last_activity_source,
            recent.last_watched_title
        FROM users u
        LEFT JOIN LATERAL (
            SELECT
                bool_or(ps.status IN ('ACTIVE', 'PAUSED')) AS currently_streaming,
                MAX(GREATEST(ps.started_at, ps.last_heartbeat_at)) AS last_activity_at,
                (array_agg(ps.source ORDER BY GREATEST(ps.started_at, ps.last_heartbeat_at) DESC))[1]
                    AS last_activity_source,
                -- Episodes are titled like "Episode 1", which is meaningless on
                -- its own — prefix the series title. The series is the episode's
                -- grandparent via the parent_id chain (episode → season → series);
                -- fall back to the direct parent for episodes without a season row.
                (array_agg(
                    CASE
                        WHEN mi.media_type = 'episode' AND COALESCE(gp.title, p.title) IS NOT NULL
                            THEN COALESCE(gp.title, p.title) || ' – ' || mi.title
                        ELSE mi.title
                    END
                    ORDER BY GREATEST(ps.started_at, ps.last_heartbeat_at) DESC
                ))[1] AS last_watched_title
            FROM play_sessions ps
            LEFT JOIN media_items mi ON mi.id = ps.media_id
            LEFT JOIN media_items p ON p.id = mi.parent_id
            LEFT JOIN media_items gp ON gp.id = p.parent_id
            WHERE ps.user_id = u.id
              AND NOT ps.is_preview AND ps.purpose = 'play'
        ) recent ON true
        ORDER BY u.last_seen_at DESC NULLS LAST, u.username ASC
    `;
}

/**
 * Search users by username prefix/substring (for invite autocomplete).
 * Escapes ILIKE wildcard characters in the query. Excludes the given username.
 */
/**
 * Escape ILIKE metacharacters so caller input is matched literally.
 *
 * Shared by both search variants below — they must not drift, because one of
 * them running unescaped is an injection of pattern semantics, not just a
 * cosmetic difference.
 */
function escapeIlike(query: string): string {
    return query.toLowerCase().replace(/[%_\\]/g, '\\$&');
}

/**
 * Full-directory user search — substring match, admin callers only.
 *
 * Backs the access-group member picker on `/admin/settings/access`, where the
 * operator legitimately needs to see every account. Substring rather than
 * prefix because an admin assembling a group is searching a directory they are
 * already entitled to enumerate (`GET /api/v1/users`, scope `users:admin`).
 *
 * Excludes soft-deleted rows. Disabled accounts are DELIBERATELY included:
 * an operator managing group membership needs to see and fix an account that
 * is disabled, which is exactly the case `searchUsersForInvite` must hide.
 */
export async function searchUsersForDirectory(
    sql: postgres.Sql,
    query: string,
    excludeUsername: string,
    limit: number = 10,
): Promise<Array<{ id: string; username: string }>> {
    const escaped = escapeIlike(query);
    return sql<Array<{ id: string; username: string }>>`
        SELECT id, username
        FROM users
        WHERE username ILIKE ${'%' + escaped + '%'}
          AND LOWER(username) != ${excludeUsername.toLowerCase()}
          AND deleted_at IS NULL
        ORDER BY last_seen_at DESC NULLS LAST, username ASC
        LIMIT ${limit}
    `;
}

/**
 * Peer-facing user search for invite autocomplete — "unlisted phone number".
 *
 * Two rules, and the second is the whole point:
 *
 * 1. **Prefix** match returns only users who have NOT set `hide_streams`.
 * 2. An **exact** username match resolves regardless of `hide_streams`.
 *
 * Rule 2 exists because a plain `hide_streams` filter would make those users
 * permanently un-invitable — a functional regression dressed as a privacy fix.
 * `hide_streams` means "do not surface me to people browsing"; it has never
 * meant "nobody may add me to their playlist when they already know my name".
 * Someone typing a username in full already knows the account exists.
 *
 * Prefix rather than substring is the deliberate narrowing versus
 * `searchUsersForDirectory`: it still serves autocomplete (you type the start
 * of a name you know) while not answering "who here has 'an' in their name".
 * It is friction, not a boundary — see `docs/architecture/social-sharing.md`,
 * "The user directory is searchable", which states the accepted residual risk
 * rather than pretending this is access control.
 *
 * Excludes soft-deleted AND disabled accounts, matching `getUsersByNames()`
 * above. Inviting a dead account can only produce an invitation nobody can
 * accept.
 */
export async function searchUsersForInvite(
    sql: postgres.Sql,
    query: string,
    excludeUsername: string,
    limit: number = 10,
): Promise<Array<{ id: string; username: string }>> {
    const escaped = escapeIlike(query);
    return sql<Array<{ id: string; username: string }>>`
        SELECT id, username
        FROM users
        WHERE LOWER(username) != ${excludeUsername.toLowerCase()}
          AND deleted_at IS NULL
          AND disabled_at IS NULL
          AND (
                (username ILIKE ${escaped + '%'} AND COALESCE(hide_streams, false) = false)
             OR LOWER(username) = ${query.toLowerCase()}
          )
        ORDER BY last_seen_at DESC NULLS LAST, username ASC
        LIMIT ${limit}
    `;
}

/**
 * Set is_admin for a user and pin the value (prevents IdP sync from overwriting).
 * Returns the updated row, or null if user not found.
 */
export async function setIsAdmin(
    sql: postgres.Sql,
    username: string,
    isAdmin: boolean,
): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        UPDATE users
        SET is_admin = ${isAdmin}, admin_pinned = true, updated_at = NOW()
        WHERE username = ${username}
        RETURNING id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at
    `;
    return rows[0] ?? null;
}

/**
 * Unpin admin status — clears the manual override so IdP groups control admin
 * status again. Touches only `admin_pinned`: `is_admin` keeps the pinned value
 * until something rewrites it. The one production caller
 * (`admin-user.service.ts`, the admin unpin) does that in the same operation,
 * under the last-admin guard lock, with `syncAdminFromGroups` and the
 * groups-only verdict; a new caller must do the same.
 * Returns the updated row, or null if user not found.
 */
export async function unpinAdmin(sql: postgres.Sql, username: string): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        UPDATE users
        SET admin_pinned = false, updated_at = NOW()
        WHERE username = ${username}
        RETURNING id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at
    `;
    return rows[0] ?? null;
}

/**
 * Set max_age_rating for a user and pin the value (prevents IdP sync from overwriting).
 * Returns the updated row, or null if user not found.
 */
export async function setMaxAgeRating(
    sql: postgres.Sql,
    username: string,
    maxAgeRating: number | null,
): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        UPDATE users
        SET max_age_rating = ${maxAgeRating}, age_rating_pinned = true, updated_at = NOW()
        WHERE username = ${username}
        RETURNING id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv,
                  display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at
    `;
    return rows[0] ?? null;
}

/**
 * Unpin age rating — clears the manual override so IdP groups control
 * max_age_rating again. The value will be updated on the user's next request.
 * Returns the updated row, or null if user not found.
 */
export async function unpinAgeRating(sql: postgres.Sql, username: string): Promise<UserRow | null> {
    const rows = await sql<UserRow[]>`
        UPDATE users
        SET age_rating_pinned = false, updated_at = NOW()
        WHERE username = ${username}
        RETURNING id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv,
                  display_name, email, hide_streams, groups, groups_updated_at, created_at, updated_at, last_seen_at
    `;
    return rows[0] ?? null;
}

/**
 * Sync is_admin from IdP-derived groups WITHOUT pinning. Used by the unpin flow to
 * immediately reflect the group-derived value after clearing the manual override
 * (the per-request sync would otherwise leave the stale pinned value until the
 * user's next request). Leaves admin_pinned untouched (already cleared by unpin).
 */
export async function syncAdminFromGroups(
    sql: postgres.Sql,
    username: string,
    isAdmin: boolean,
): Promise<void> {
    await sql`
        UPDATE users SET is_admin = ${isAdmin}, updated_at = NOW()
        WHERE username = ${username}
    `;
}

/**
 * Sync max_age_rating from IdP-derived groups WITHOUT pinning. Mirror of
 * {@link syncAdminFromGroups} for the age-rating unpin flow.
 */
export async function syncAgeRatingFromGroups(
    sql: postgres.Sql,
    username: string,
    maxAgeRating: number | null,
): Promise<void> {
    await sql`
        UPDATE users SET max_age_rating = ${maxAgeRating}, updated_at = NOW()
        WHERE username = ${username}
    `;
}

/** Which stored avatar `getUserAvatar` returned. */
export type StoredAvatarSource = 'upload' | 'idp';

/**
 * Get a user's stored avatar: the one they uploaded, else (when `includeIdp`)
 * the picture synced from the OIDC provider. Returns null when neither is set.
 * The upload always wins — the IdP copy is only a fallback.
 */
export async function getUserAvatar(
    sql: postgres.Sql,
    username: string,
    options: { includeIdp?: boolean } = {},
): Promise<{
    avatar_data: Buffer;
    avatar_content_type: string;
    source: StoredAvatarSource;
    /**
     * When the returned copy was last written (epoch ms, as text):
     * `avatar_updated_at` for an upload, `idp_avatar_updated_at` for an IdP
     * copy. Part of the disk-cache key: an upload, delete or sync invalidates
     * only its own replica's cache, so other replicas tell a new picture apart
     * by this. Null for an upload made before the column existed.
     */
    version: string | null;
} | null> {
    const includeIdp = options.includeIdp ?? false;
    const rows = await sql<
        {
            avatar_data: Buffer;
            avatar_content_type: string;
            source: StoredAvatarSource;
            version: string | null;
        }[]
    >`
        SELECT
            COALESCE(avatar_data, idp_avatar_data) AS avatar_data,
            CASE WHEN avatar_data IS NOT NULL
                 THEN avatar_content_type ELSE idp_avatar_content_type END AS avatar_content_type,
            CASE WHEN avatar_data IS NOT NULL THEN 'upload' ELSE 'idp' END AS source,
            (EXTRACT(EPOCH FROM CASE WHEN avatar_data IS NOT NULL
                 THEN avatar_updated_at ELSE idp_avatar_updated_at END) * 1000)::bigint::text AS version
        FROM users
        WHERE username = ${username}
          AND (avatar_data IS NOT NULL OR (${includeIdp} AND idp_avatar_data IS NOT NULL))
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Which stored avatar `getUserAvatar` would return, and its version, without
 * reading the image bytes. Lets the image proxy check its disk cache by the
 * current version on every request and fetch the bytea only on a miss.
 * Same selection rules as `getUserAvatar`.
 */
export async function getUserAvatarVersion(
    sql: postgres.Sql,
    username: string,
    options: { includeIdp?: boolean } = {},
): Promise<{ source: StoredAvatarSource; version: string | null } | null> {
    const includeIdp = options.includeIdp ?? false;
    const rows = await sql<{ source: StoredAvatarSource; version: string | null }[]>`
        SELECT
            CASE WHEN avatar_data IS NOT NULL THEN 'upload' ELSE 'idp' END AS source,
            (EXTRACT(EPOCH FROM CASE WHEN avatar_data IS NOT NULL
                 THEN avatar_updated_at ELSE idp_avatar_updated_at END) * 1000)::bigint::text AS version
        FROM users
        WHERE username = ${username}
          AND (avatar_data IS NOT NULL OR (${includeIdp} AND idp_avatar_data IS NOT NULL))
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/** What the IdP-avatar sync last recorded for a user. */
export interface IdpAvatarState {
    /** sha256 of the `picture` claim last processed; null = none recorded. */
    source: string | null;
    hasData: boolean;
    updatedAt: Date | null;
}

export async function getUserIdpAvatarState(
    sql: postgres.Sql,
    userId: string,
): Promise<IdpAvatarState | null> {
    const rows = await sql<
        {
            idp_avatar_source: string | null;
            has_data: boolean;
            idp_avatar_updated_at: Date | null;
        }[]
    >`
        SELECT idp_avatar_source,
               (idp_avatar_data IS NOT NULL) AS has_data,
               idp_avatar_updated_at
        FROM users
        WHERE id = ${userId}::uuid
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        source: row.idp_avatar_source,
        hasData: row.has_data,
        updatedAt: row.idp_avatar_updated_at,
    };
}

/**
 * Record the outcome of an IdP-avatar sync. `data` null with a `source` marks a
 * picture that was rejected (so it is not refetched until the claim changes);
 * both null clears everything (the IdP stopped sending a picture).
 * Never touches the uploaded avatar.
 *
 * Compare-and-set: writes only while `idp_avatar_source` still equals
 * `expectedSource` (what the caller read), so a slow sync cannot overwrite a
 * newer one that finished first. Returns whether the row was written.
 */
export async function setUserIdpAvatar(
    sql: postgres.Sql,
    userId: string,
    expectedSource: string | null,
    value: { data: Buffer | null; contentType: string | null; source: string | null },
): Promise<boolean> {
    const rows = await sql`
        UPDATE users
        SET idp_avatar_data = ${value.data},
            idp_avatar_content_type = ${value.contentType},
            idp_avatar_source = ${value.source},
            idp_avatar_updated_at = CASE WHEN ${value.source}::text IS NULL THEN NULL ELSE NOW() END
        WHERE id = ${userId}::uuid
          AND idp_avatar_source IS NOT DISTINCT FROM ${expectedSource}::text
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Restart the refresh window for the stored IdP avatar without changing it
 * (its picture failed this time but the stored copy is still the right one).
 */
export async function touchUserIdpAvatar(
    sql: postgres.Sql,
    userId: string,
    source: string,
): Promise<void> {
    await sql`
        UPDATE users
        SET idp_avatar_updated_at = NOW()
        WHERE id = ${userId}::uuid AND idp_avatar_source = ${source}
    `;
}

/**
 * Save a user's custom avatar (processed WebP buffer).
 * Returns true if a row was updated, false if user was deleted between check and write.
 */
export async function setUserAvatar(
    sql: postgres.Sql,
    username: string,
    avatarData: Buffer,
    contentType: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE users
        SET avatar_data = ${avatarData},
            avatar_content_type = ${contentType},
            avatar_updated_at = NOW(),
            updated_at = NOW()
        WHERE username = ${username}
        RETURNING username
    `;
    return rows.length > 0;
}

/**
 * Remove a user's custom avatar (revert to fallback chain).
 */
export async function deleteUserAvatar(sql: postgres.Sql, username: string): Promise<void> {
    await sql`
        UPDATE users
        SET avatar_data = NULL,
            avatar_content_type = NULL,
            avatar_updated_at = NOW(),
            updated_at = NOW()
        WHERE username = ${username}
    `;
}

// =============================================================================
// Native (built-in) login
// =============================================================================
// These back the AGPL-core username/password login. They are entirely separate
// from the proprietary `/j` jellyfin_client_passwords store — never cross-read.

/**
 * Whether ANY admin user exists yet. Drives the first-run onboarding guard: when
 * false, the app is in first-run state and the /setup wizard is reachable; once
 * an admin exists, /setup becomes inert.
 *
 * True if ANY user in the instance is or could be an admin, by the BROAD,
 * fail-closed `setupGateAdminExists()` check (below): the `is_admin` column,
 * OR in-app membership carrying the `admin` capability, OR a NAME match (the
 * live IdP-groups projection in `users.groups`, or an in-app access group's
 * name with at least one member) against `ADMIN_GROUPS` — evaluated with
 * Formula A's OWN `hasGroupPermission()` function, not a SQL re-implementation
 * (fix plan 6, C5 fix round 2 — see `setupGateAdminExists()`'s doc comment for
 * why two independent folds can never be proven to agree). This is NOT the
 * same predicate `countEffectiveAdmins()`/`countOtherEffectiveAdmins()`
 * (`access-groups.queries.ts`) use, and the two are DELIBERATELY allowed to
 * disagree: those two answer "how many admins can act right now" (active
 * rows only, pin-aware Formula A — a pinned non-admin never counts) for a
 * LAST-ADMIN guard, where over-counting would let the guard pass while zeroing out
 * real admins — a lock-out. This function answers "has an admin ever
 * existed" for a SETUP GATE, where over-counting is the safe direction
 * instead (see below). `setupGateAdminExists()` is shared verbatim only
 * with `createNativeAdmin()`'s in-lock re-check, so those two — which ARE
 * answering the same question — can never disagree with each other.
 *
 * SECURITY (security review 2026-09-23 final fix wave, fix round 3,
 * CRITICAL): this gates the PUBLIC, UNAUTHENTICATED first-run surfaces —
 * `POST /api/auth/native/setup` (`completeNativeSetup`), `/setup`, the OIDC
 * first-run check, and the `/setup` redirect on `/login` — as "has an admin
 * already been created". It used to check ONLY the `is_admin` COLUMN. Fix
 * round 2's own Important-1 fix made `setUserAdmin()`'s unpin branch write
 * the CORRECT groups-only value to that column — which means unpinning the
 * ONLY column-admin who is ALSO an in-app admin (with no admin-conferring
 * IdP groups) now correctly writes `is_admin=false`. If `adminExists()`
 * still only read that column, the LAST row satisfying it would vanish even
 * though a real, currently-effective admin still exists (via the in-app
 * group) — reopening the public unauthenticated setup wizard to let anyone
 * mint a brand-new admin account. Broadening the predicate here closes that
 * reopening without touching `setUserAdmin()`'s (now-correct) column write.
 *
 * Deliberately NOT pin-aware and NOT excluding a target for whom `others`
 * would be zero (unlike `countOtherEffectiveAdmins()`'s SELF-exclusion) —
 * this only ever answers "does ANY admin exist", so over-counting (treating
 * an unpinned in-app admin as sufficient to keep setup closed, even one
 * `countEffectiveAdmins()` might discount by some other axis) is the SAFE
 * direction: a false "admin exists" keeps a closed install closed; a false
 * "no admin exists" would hand out the setup wizard.
 *
 * NO LIFECYCLE FILTER (fix round 4, CRITICAL correction): earlier versions
 * of this query — mirroring `countEffectiveAdmins()` — restricted to
 * `disabled_at IS NULL AND deleted_at IS NULL`. That is correct for a COUNT
 * ("how many admins can act right now") but wrong for a SETUP GATE ("has an
 * admin ever been created"): a disabled/deleted admin row still PROVES
 * setup was completed, and disabling is reversible (an operator can
 * re-enable, or two admins can each disable the other in a race) — a filter
 * that drops such rows on the floor makes the gate fail OPEN the moment
 * every admin happens to be disabled, reopening the public setup wizard
 * (and, via `POST /api/setup/oidc-config`, letting an anonymous caller
 * repoint OIDC at an arbitrary issuer before the OIDC-callback first-run
 * check grants admin to whatever that issuer asserts). This function
 * therefore counts ANY row that is or could be an effective admin,
 * active or not — over-counting is still the safe direction for a setup
 * gate, same reasoning as the pin/self-exclusion notes above. Do NOT add
 * `disabled_at`/`deleted_at` back here; that filter belongs on the COUNT
 * queries (which answer a different question) and NOT on this GATE.
 *
 * SETUP LOCK (security review 6, ruling S-C5c-2): also true whenever the
 * single-row `setup_lock` table holds its row, i.e. once first-run setup has
 * completed, even if no admin can be found any more. An IdP-side demotion or
 * rename of the admin group (or an `ADMIN_GROUPS` typo) can leave zero
 * admins; before the lock that reopened these public setup surfaces to
 * anyone who reached them. Only the operator's `SETUP_UNLOCK` recovery
 * (`setup-lock.service.ts`) removes the row, and only while
 * `adminExistsIgnoringSetupLock()` is false.
 *
 * `adminGroupNames` is passed in (typically `config.ADMIN_GROUPS`) rather
 * than read from config here, keeping this a pure query module function —
 * mirrors `countEffectiveAdmins()`'s own signature.
 */
export async function adminExists(
    sql: postgres.Sql,
    adminGroupNames: readonly string[],
): Promise<boolean> {
    return setupGateAdminExists(sql, adminGroupNames);
}

/**
 * `adminExists()` WITHOUT the setup-lock term: whether any user is or could
 * be an admin by the broad setup-gate predicate alone. Decides whether the
 * operator's `SETUP_UNLOCK` recovery may clear the lock (only when this is
 * false) and whether `/setup` shows the "setup is locked" page (locked, and
 * this is false). Same single statement, same blank-`ADMIN_GROUPS` throw.
 */
export async function adminExistsIgnoringSetupLock(
    sql: postgres.Sql,
    adminGroupNames: readonly string[],
): Promise<boolean> {
    return setupGatePredicateHolds(await readSetupGate(sql), adminGroupNames);
}

/** Whether the `setup_lock` row exists (first-run setup has completed). */
export async function isSetupLocked(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ locked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM setup_lock) AS locked
    `;
    return rows[0]?.locked === true;
}

/**
 * Record that first-run setup has completed. Every admin-bootstrap path calls
 * this in the SAME transaction as its admin write, while holding
 * `FIRST_ADMIN_LOCK_KEY`, so the lock and the first admin commit together.
 * Idempotent: the first completion is kept. `byUserId` is the users.id of the
 * admin just created (the FK nulls it if that account is later erased).
 */
export async function markSetupCompleted(tx: postgres.Sql, byUserId: string | null): Promise<void> {
    await tx`
        INSERT INTO setup_lock (id, completed_by)
        VALUES (1, ${byUserId}::uuid)
        ON CONFLICT (id) DO NOTHING
    `;
}

/**
 * Remove the setup lock. Only the `SETUP_UNLOCK` recovery calls this, after
 * checking `adminExistsIgnoringSetupLock()` under `FIRST_ADMIN_LOCK_KEY`
 * (`setup-lock.service.ts`). Returns true when a row was removed.
 */
export async function clearSetupLock(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ id: number }[]>`
        DELETE FROM setup_lock WHERE id = 1 RETURNING id
    `;
    return rows.length > 0;
}

/**
 * THE one setup-gate admin-existence check. Shared verbatim by `adminExists()`
 * and `createNativeAdmin()`'s in-lock re-check (fix plan 6, S-C5b, carried
 * into C5 fix round 2) so the two can never diverge under concurrency (the
 * exact trap fix-plan-5 round 4's F2 closed for the pre-groups-term version
 * of this check).
 *
 * FIX ROUND 2 (controller ruling): fix round 1 folded the NAME axis (the
 * `users.groups` projection and in-app group names) in SQL via Postgres
 * `LOWER()` on both sides, reasoning that a SYMMETRIC fold (same function,
 * both sides) could only ever OVER-count relative to Formula A
 * (`hasGroupPermission()`, `auth.ts`, which folds via JS `toLowerCase()`).
 * That reasoning was WRONG: JS's `toLowerCase()` (full Unicode special
 * casing, V8's Unicode tables) and Postgres' `LOWER()` (this DB's glibc
 * `en_US.utf8` collation, simple per-character mapping from glibc's OWN,
 * independently-versioned tables) are TWO INDEPENDENT case-folding
 * implementations — nothing guarantees they agree, and round 1's own
 * reviewer reproduced concrete disagreements in BOTH directions (Greek final
 * sigma `ΟΔΟΣ`/`οδος` folding differently depending on which string is upper
 * vs lower; decomposed `İ`; codepoints newer than glibc's tables). A gate
 * that UNDER-counts relative to Formula A is the exact reopen this whole gate
 * exists to prevent — worse than the fix-round-1 regression it was meant to
 * close. Two independently-versioned fold tables can never be proven to
 * agree, so this function no longer folds the name axis in SQL AT ALL: it
 * reads the raw CANDIDATE names (unfolded) out of Postgres, then asks
 * Formula A's OWN `hasGroupPermission()` function whether any of them
 * matches `adminGroupNames` — the exact same JS call, on the exact same V8
 * Unicode tables, Formula A itself uses. There is no second fold to disagree
 * with.
 *
 * Three independent sources, ANY of which makes this return `true`:
 * 1. the `is_admin` COLUMN (pin-aware writes land here; see `upsertUser()`),
 * 2. in-app (`user_access_groups`) membership carrying the `admin`
 *    CAPABILITY (name-conferred in-app admin is folded into source 3, not
 *    checked here — capability membership needs no name comparison at all,
 *    so it stays in SQL),
 * 3. a NAME match against `adminGroupNames`, evaluated by
 *    `hasGroupPermission()` over the UNION of: the raw, forward-auth-synced
 *    `users.groups` projection (every user, `unnest()`ed, NULLs skipped) and
 *    the DISTINCT names of in-app access groups that have at least one
 *    member (an empty group can't confer admin to anyone, so it isn't a
 *    candidate).
 *
 * Deliberately NOT pin-aware (a pinned-demoted row with a stale admin-group
 * entry in `users.groups` still counts — Formula A says non-admin, this gate
 * disagrees ON PURPOSE) and NO lifecycle filter (a disabled/deleted admin
 * row still counts). Over-counting is the SAFE direction for a SETUP GATE: a
 * false "admin exists" keeps a closed install closed; a false "no admin
 * exists" hands out the unauthenticated setup wizard (fix-plan-5 ledger
 * rounds 3/4). `access-control.service.integration.test.ts` documents the
 * pin over-count with a dedicated fixture.
 *
 * BLANK `ADMIN_GROUPS` (fix round 3 ruling, order corrected in fix round 4):
 * an empty or all-whitespace `adminGroupNames` returns `true` when the
 * column/capability axis finds an admin (exact: a blank config's name axis is
 * empty) and THROWS only when it finds none (see the function body's comment)
 * — so an installed instance with a blank config keeps `/login` and OIDC
 * working, while an admin-less one surfaces the misconfiguration. Every
 * caller treats a thrown rejection as closed.
 * `access-control.service.integration.test.ts` covers `[]`, `['']`, and
 * whitespace-only entries for all three states, from both `adminExists()` and
 * `createNativeAdmin()`.
 *
 * `sql` must be the SAME handle the check runs on (pass `tx` inside a
 * transaction, on the SAME pinned connection the advisory lock was taken
 * on). WHAT IS ATOMIC (fix round 3 — corrected from fix round 2's
 * overclaim): the check itself is now ONE statement, ONE READ COMMITTED
 * snapshot (see the function body's own comment) — no concurrent commit can
 * be interleaved WITHIN the check. What is NOT atomic: this function's
 * result and `createNativeAdmin()`'s later INSERT are still two separate
 * statements, so a non-bootstrap writer (an admin-user.service.ts edit, an
 * in-app membership change, a forward-auth/OIDC sync — none of which take
 * the advisory lock) could commit between them. The advisory lock only
 * serializes concurrent BOOTSTRAP callers (`createNativeAdmin()`,
 * `completeForwardAuthSetup()`) against EACH OTHER — the property it
 * actually protects (no two anonymous first-run submissions both succeed)
 * holds regardless of that narrower gap.
 *
 * Do NOT reuse this in `countEffectiveAdmins()` / `countOtherEffectiveAdmins()`
 * (`access-groups.queries.ts`) — those answer "how many admins can act right
 * now" for a LAST-ADMIN guard, where over-counting is a LOCK-OUT (it lets the
 * guard pass while zeroing out real admins), not a safe direction. See the
 * corrected comment at `admin-user.service.ts` near `groupsOnlyIsAdmin`.
 * (They evaluate names with the same `hasGroupPermission()` as this gate
 * since the deferred-items pass — no SQL fold — but keep their own pin and
 * lifecycle rules.)
 */
async function setupGateAdminExists(
    sql: postgres.Sql,
    adminGroupNames: readonly string[],
): Promise<boolean> {
    const row = await readSetupGate(sql);
    // SETUP LOCK (S-C5c-2): read in the same statement as the admin terms and
    // checked BEFORE the blank-ADMIN_GROUPS throw, so a completed install
    // answers "set up" even with a blank config and no admin left.
    if (row.locked) return true;
    return setupGatePredicateHolds(row, adminGroupNames);
}

interface SetupGateRow {
    locked: boolean;
    cap: boolean;
    gnames: string[];
    inapp: string[];
}

/** The setup gate's one statement: the lock row and every admin term. */
async function readSetupGate(sql: postgres.Sql): Promise<SetupGateRow> {
    // ONE STATEMENT (fix round 3, controller ruling — closes a NEW Important
    // the round-2 shape introduced): round 2 split this into three separate
    // queries (a capability/column EXISTS check, then two candidate-name
    // queries via `Promise.all`) — three independent READ COMMITTED
    // snapshots. The advisory lock in `createNativeAdmin()` (the only
    // in-transaction caller) serializes concurrent BOOTSTRAP callers against
    // EACH OTHER, but nothing here serializes against non-bootstrap writers
    // (an admin-user.service.ts edit, an in-app access-group membership
    // change, a forward-auth/OIDC per-request group sync) — those never take
    // this lock. A single commit from one of those, landing BETWEEN this
    // function's three separate statements, that moves the instance's ONLY
    // admin from one axis to another (e.g. an in-app admin-group membership
    // removed in the SAME commit that pins `is_admin=true` on that same
    // user) is invisible to all three: the capability query's snapshot
    // (taken before the commit) doesn't see the new `is_admin=true` yet, and
    // the name-query snapshots (taken after) no longer see the removed
    // membership. Reproduced on a scratch DB (holding an ACCESS EXCLUSIVE
    // lock on `access_groups` from a second connection to pause this
    // function deterministically between statements, then committing that
    // exact move): `createNativeAdmin()` returned a new admin id instead of
    // `null`, alongside the pre-existing admin — two admins where the
    // pre-C5 single-statement `INSERT ... WHERE NOT EXISTS` shape (same
    // schedule) correctly returned `null`. Fixed by collapsing the capability
    // check and both candidate-name reads into ONE `SELECT`: `EXISTS(...)`
    // and the two `ARRAY(SELECT ...)` subqueries are all evaluated against
    // the SAME statement snapshot (Postgres takes one snapshot per
    // STATEMENT under READ COMMITTED, not per sub-expression), so a
    // concurrent commit is either entirely before or entirely after this
    // read — never straddling it. This closes the READ's own internal
    // inconsistency; it does NOT make the read serialize against concurrent
    // non-bootstrap writers landing in the (unavoidable, since the name
    // axis needs a JS round trip through `hasGroupPermission()`) gap between
    // THIS statement's commit-visible snapshot and the later INSERT
    // statement in `createNativeAdmin()` — that gap is bounded by, and only
    // matters relative to, the SAME class of writer, and the advisory lock's
    // actual job (preventing two ANONYMOUS first-run submissions from both
    // succeeding) is unaffected by it.
    const rows = await sql<SetupGateRow[]>`
        SELECT
            EXISTS (SELECT 1 FROM setup_lock) AS locked,
            EXISTS (
                SELECT 1
                FROM users u
                WHERE u.is_admin = true
                   OR EXISTS (
                        SELECT 1
                        FROM user_access_groups uag
                        JOIN access_group_capabilities admcap
                            ON admcap.group_id = uag.group_id AND admcap.capability = 'admin'
                        WHERE uag.user_id = u.id
                   )
            ) AS cap,
            ARRAY(
                SELECT DISTINCT g
                FROM users u, unnest(u.groups) AS g
                WHERE g IS NOT NULL
            ) AS gnames,
            ARRAY(
                SELECT DISTINCT ag.name
                FROM access_groups ag
                WHERE EXISTS (
                    SELECT 1 FROM user_access_groups uag WHERE uag.group_id = ag.id
                )
            ) AS inapp
    `;
    return rows[0];
}

/**
 * The broad admin predicate over one `readSetupGate()` row, without the lock
 * term. Throws on a blank `adminGroupNames` when no column/capability admin
 * exists (see the comment below).
 */
function setupGatePredicateHolds(row: SetupGateRow, adminGroupNames: readonly string[]): boolean {
    if (row.cap) return true;

    // FAIL-CLOSED ON BLANK ADMIN_GROUPS (fix round 3 ruling, ORDER corrected
    // in fix round 4). Round 2 returned `true` for a blank config. That
    // silently changed observable, non-setup-gate behaviour relative to the
    // pre-C5 NUL-byte-sentinel throw: `isFreshUnconfiguredInstall()`
    // (`onboarding.queries.ts`) would see "admin exists" and let the TMDB
    // background sync run on a genuinely admin-less install; a plugin
    // auth-provider sign-in would provision a user before any admin exists;
    // the OIDC callback's `firstRun` would read `false` and skip
    // first-user-admin provisioning; `completeNativeSetup()` would answer a
    // generic 409 with nothing logged. Throwing surfaces the misconfiguration
    // and every caller treats a rejection as closed.
    //
    // WHY THE THROW SITS AFTER THE READ (fix round 4, controller ruling):
    // round 3 threw BEFORE reading the database, so it also fired on an
    // INSTALLED instance whose admin is a column admin or an in-app
    // `admin`-capability admin. Reachable by an admin saving ADMIN_GROUPS as
    // "" in settings (parses to `[]`) or env `ADMIN_GROUPS=,`; `/login`'s
    // load and the OIDC callback call `adminExists()` outside any try, so
    // that became a 500 for every anonymous visitor and a failed OIDC
    // sign-in for everyone — an outage the admin could not undo from the UI.
    // With a blank config Formula A's name axis is EMPTY (no name can match),
    // so `cap === true` above is the exact answer. Only when `cap` is false
    // does the verdict hinge on the config — that is the case the round-3
    // ruling surfaces by throwing.
    if (adminGroupNames.every((g) => g.trim().length === 0)) {
        throw new Error('ADMIN_GROUPS is empty; the first-run setup gate cannot be evaluated');
    }

    const candidateNames = [...row.gnames, ...row.inapp];
    if (candidateNames.length === 0) return false;

    return hasGroupPermission(candidateNames, [...adminGroupNames]);
}

export interface NativeLoginRecord {
    id: string;
    username: string;
    password_hash: string | null;
    groups: string[] | null;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
    allow_live_tv?: boolean | null;
    disabled_at: Date | null;
}

/**
 * Fetch the fields needed to authenticate a native login by username (lowercased
 * for case-insensitive match). Returns null if the user doesn't exist. A null
 * password_hash means the account has no native password (forward-auth / IdP
 * managed) and cannot log in via the native form.
 */
export async function getNativeLoginRecord(
    sql: postgres.Sql,
    username: string,
): Promise<NativeLoginRecord | null> {
    const rows = await sql<NativeLoginRecord[]>`
        SELECT id, username, password_hash, groups, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv, disabled_at
        FROM users
        WHERE LOWER(username) = LOWER(${username})
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Advisory-lock key shared by every first-run admin-bootstrap path (native
 * setup here, and forward-auth setup in native-auth.service.ts's
 * completeForwardAuthSetup) so they serialize against EACH OTHER, not just
 * against themselves. */
export const FIRST_ADMIN_LOCK_KEY = 'lumastra:setup:first-admin';

/**
 * Create the first native admin account. Sets the password hash, marks the user
 * admin with admin_pinned=true (so IdP/group sync can't silently demote them),
 * and writes the admin group into `groups`.
 *
 * Guarded against a race: only inserts when NO admin exists yet. Returns the new
 * user's id, or null if an admin already exists (insert skipped). The caller must
 * treat null as "first-run already completed". On success it also writes the
 * setup lock (`markSetupCompleted()`) in the same transaction.
 */
export async function createNativeAdmin(
    sql: postgres.Sql,
    params: {
        username: string;
        passwordHash: string;
        groups: string[];
        adminGroupNames: readonly string[];
    },
): Promise<string | null> {
    const sharing = defaultActivitySharing();
    // SECURITY: under READ COMMITTED, INSERT ... SELECT WHERE NOT EXISTS is NOT
    // enough on its own — two concurrent setup submissions with DIFFERENT
    // usernames can each evaluate "no admin yet" as true (neither sees the
    // other's uncommitted row) and both insert, producing two admins. Wrap the
    // check-and-insert in a transaction-scoped advisory lock keyed on a fixed
    // string. `pg_advisory_xact_lock` BLOCKS until free (unlike a try-lock), so
    // a second submission waits for the first to commit and only then
    // re-evaluates WHERE NOT EXISTS against the now-current state — it
    // correctly finds the admin and inserts nothing. The lock is acquired and
    // the insert run on the SAME transaction-pinned connection (`tx`), and is
    // released automatically when the transaction ends.
    //
    // Use withTx (not raw sql.begin): callers may pass a top-level Sql, a
    // TransactionSql, or a ReservedSql, and postgres.js only attaches `.begin`
    // to the top-level variant — calling `sql.begin` on a transaction/reserved
    // handle throws `TypeError: sql.begin is not a function`. withTx dispatches
    // to begin/savepoint/manual-BEGIN by runtime feature detection, keeping the
    // lock + insert on one pinned connection in every case.
    //
    // FIX (fix round 4): the atomic in-lock re-check below used to be the bare
    // column check `SELECT 1 FROM users WHERE is_admin = true` — narrower than
    // `adminExists()`'s own predicate after fix round 3 broadened THAT to also
    // count in-app admin-conferring membership. An in-app-only admin (no
    // `is_admin` column set anywhere) would pass `adminExists()`'s OUTER check
    // as "admin exists" (refusing the request before it ever reaches here) in
    // the common case, but a concurrent submission racing the advisory lock
    // would still find this NOT EXISTS true and mint a SECOND admin. The
    // re-check now mirrors `adminExists()`'s exact (no-lifecycle-filter)
    // predicate — see that function's doc comment for why disabled/deleted
    // rows still count for a setup GATE.
    //
    // C5 FIX (fix plan 6, S-C5b, reworked in C5 fix round 2, corrected in fix
    // round 3): the re-check calls the SAME `setupGateAdminExists()` check
    // `adminExists()` uses, built from `tx` — the pinned in-transaction
    // connection, not the outer `sql` — so both callers can never diverge
    // (previously the in-lock copy was a byte-identical HAND COPY, then fix
    // round 1's SQL-only fragment, then fix round 2's 3-statement version;
    // see `setupGateAdminExists()`'s own doc comment for the full history,
    // including fix round 3's single-statement fix for the 3-statement
    // version's own internal inconsistency). It is a CHECK-THEN-ACT
    // (`setupGateAdminExists()` needs a JS round trip for the name axis, so
    // it can't be embedded as a nested subquery inside one atomic
    // `INSERT ... WHERE NOT EXISTS` statement) rather than a single
    // statement. WHAT THE ADVISORY LOCK ACTUALLY GUARANTEES (corrected, fix
    // round 3 — this comment previously overclaimed "fully atomic... no
    // other caller can create an admin between this check and the INSERT"):
    // it serializes concurrent BOOTSTRAP callers — OTHER `createNativeAdmin()`
    // / `completeForwardAuthSetup()` invocations — against EACH OTHER, which
    // is the property that matters (no two anonymous first-run submissions
    // both succeed). It does NOT serialize against a non-bootstrap writer
    // (an admin-user.service.ts edit, an in-app membership change, a
    // forward-auth/OIDC per-request sync) committing in the gap between the
    // check above and the INSERT below — none of those take this lock. See
    // `setupGateAdminExists()`'s own doc comment for the full reasoning.
    return withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;

        if (await setupGateAdminExists(tx, params.adminGroupNames)) {
            return null;
        }

        // ON CONFLICT DO UPDATE (rather than DO NOTHING): if a same-named NON-admin
        // row already exists (no admin in the system yet — just confirmed above),
        // promote it to the admin with the chosen password instead of dead-ending
        // the wizard with a spurious "setup already completed".
        const rows = await tx<{ id: string }[]>`
            INSERT INTO users (allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity, username, is_admin, admin_pinned, groups, groups_updated_at, password_hash, password_updated_at, last_seen_at, updated_at)
            VALUES (
                ${null}, ${!sharing}, ${sharing}, ${sharing},
                ${params.username.toLowerCase()},
                true,
                true,
                ${params.groups},
                NOW(),
                ${params.passwordHash},
                NOW(),
                NOW(),
                NOW()
            )
            ON CONFLICT (username) DO UPDATE SET
                is_admin            = true,
                admin_pinned        = true,
                groups              = EXCLUDED.groups,
                groups_updated_at   = NOW(),
                password_hash       = EXCLUDED.password_hash,
                password_updated_at = NOW(),
                updated_at          = NOW()
            RETURNING id
        `;
        const id = rows[0]?.id ?? null;
        if (id) await markSetupCompleted(tx, id);
        return id;
    });
}

/**
 * Set (or change) a user's native password by user id, stamping
 * password_updated_at. Returns true if a row was updated.
 */
export async function setUserPassword(
    sql: postgres.Sql,
    userId: string,
    passwordHash: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE users
        SET password_hash = ${passwordHash},
            password_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id
    `;
    return rows.length > 0;
}

/** Upgrade only the password hash that was actually verified; never replace a reset. */
export async function rehashUserPassword(
    sql: postgres.Sql,
    userId: string,
    verifiedHash: string,
    upgradedHash: string,
): Promise<boolean> {
    const rows = await sql`
        UPDATE users
        SET password_hash = ${upgradedHash}, updated_at = NOW()
        WHERE id = ${userId} AND password_hash = ${verifiedHash}
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Return the is_admin flag for the given username, or null if the user does not exist.
 */
export async function getUserAdminStatus(
    sql: postgres.Sql,
    username: string,
): Promise<boolean | null> {
    const rows = await sql<Array<{ is_admin: boolean }>>`
        SELECT is_admin FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1
    `;
    return rows.length > 0 ? rows[0].is_admin : null;
}

/**
 * Admin-create a user (native password account). Unlike createNativeAdmin (which
 * is first-run-only and self-promotes to admin), this creates an ordinary account
 * with an explicit admin flag and group set, with NO first-run guard. An admin-set
 * account is pinned (admin_pinned=true) so a later IdP/group sync can't silently
 * flip its admin status. Returns the new user id, or null if the username already
 * exists (ON CONFLICT DO NOTHING — the caller surfaces a 409).
 */
export async function adminCreateUser(
    sql: postgres.Sql,
    params: {
        username: string;
        passwordHash: string;
        isAdmin: boolean;
        groups: string[];
        email?: string;
    },
): Promise<string | null> {
    const email = params.email?.trim().toLowerCase() || '';
    try {
        return await withTx(sql, (tx) => insertAdminUser(tx, { ...params, email }));
    } catch (error) {
        if (isUserEmailConflict(error)) throw new Error('user_email_conflict', { cause: error });
        throw error;
    }
}

function isUserEmailConflict(error: unknown): boolean {
    const pg = error as { code?: string; constraint_name?: string } | null;
    return pg?.code === '23505' && pg.constraint_name === 'users_email_normalized_unique_idx';
}

/** Admin-only call sites attest the email for verified-email SSO linking. */
export async function adminSetUserEmail(
    sql: postgres.Sql,
    userId: string,
    email: string,
): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    try {
        return await withTx(sql, async (tx) => {
            const rows = await tx`
                UPDATE users SET email = ${normalized || null},
                    email_set_by_admin_at = ${normalized ? tx`NOW()` : tx`NULL`},
                    updated_at = NOW()
                WHERE id = ${userId} RETURNING id
            `;
            return rows.length > 0;
        });
    } catch (error) {
        if (isUserEmailConflict(error)) throw new Error('user_email_conflict', { cause: error });
        throw error;
    }
}

async function insertAdminUser(
    sql: postgres.Sql,
    params: {
        username: string;
        passwordHash: string;
        isAdmin: boolean;
        groups: string[];
        email?: string;
    },
): Promise<string | null> {
    const sharing = defaultActivitySharing();
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity, username, is_admin, admin_pinned, groups, groups_updated_at, password_hash, password_updated_at, email, email_set_by_admin_at, updated_at)
        VALUES (
            ${buildUserPermissions(params.groups, { isAdminOverride: params.isAdmin }).isAgeRestricted ? false : null}, ${!sharing}, ${sharing}, ${sharing},
            ${params.username.toLowerCase()},
            ${params.isAdmin},
            true,
            ${params.groups},
            NOW(),
            ${params.passwordHash},
            NOW(),
            ${params.email || null},
            ${params.email ? sql`NOW()` : sql`NULL`},
            NOW()
        )
        ON CONFLICT (username) DO NOTHING
        RETURNING id
    `;
    return rows[0]?.id ?? null;
}

/**
 * Suspend or reactivate a user by id. Disabling sets disabled_at=NOW() (a local
 * kill-switch checked by every auth path); reactivating clears it. Returns true if
 * a row was updated. Per-request forward-auth upsert never touches disabled_at, so
 * a disabled IdP user is NOT resurrected on their next request.
 */
export async function setUserDisabled(
    sql: postgres.Sql,
    userId: string,
    disabled: boolean,
): Promise<boolean> {
    const rows = await sql`
        UPDATE users
        SET disabled_at = ${disabled ? sql`NOW()` : sql`NULL`},
            updated_at = NOW()
        WHERE id = ${userId}
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Hard-delete a user by id. user_sessions cascade via ON DELETE CASCADE; other
 * user-scoped rows are keyed by username/user_id and removed by their own cascades
 * or left as orphaned history. Returns true if a row was deleted.
 */
export async function deleteUser(sql: postgres.Sql, userId: string): Promise<boolean> {
    const rows = await sql`
        DELETE FROM users WHERE id = ${userId} RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Fetch minimal display info for a user by their internal UUID.
 * Returns username + display_name (display_name may be null).
 * Used where only a display label is needed without loading the full UserRow.
 */
export async function getUserDisplayInfoById(
    sql: postgres.Sql,
    id: string,
): Promise<{ username: string; display_name: string | null } | null> {
    const rows = await sql<{ username: string; display_name: string | null }[]>`
        SELECT username, display_name FROM users WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ?? null;
}

/** Batch public display info, deliberately excluding login usernames. */
export async function getUserDisplayInfoByIds(
    sql: postgres.Sql,
    ids: string[],
): Promise<{ id: string; display_name: string | null }[]> {
    if (ids.length === 0) return [];
    return sql<{ id: string; display_name: string | null }[]>`
        SELECT id, display_name FROM users WHERE id = ANY(${ids}::uuid[])
    `;
}

/** Admin-only switch; NULL is the historical allowed default. Always read fresh. */
export async function getUserLiveTvAllowed(
    sql: postgres.Sql,
    username: string,
    options: { ageLimited?: boolean } = {},
): Promise<boolean> {
    const rows = await sql<{ allow_live_tv: boolean | null; default_denied: boolean }[]>`
        -- The auth upsert of a rating-created stub can still be in flight. Apply
        -- its child creation default synchronously, without changing returning users.
        SELECT allow_live_tv, (${options.ageLimited === true}::boolean AND allow_live_tv IS NULL
            AND last_seen_at IS NULL AND groups_updated_at IS NULL AND password_hash IS NULL
            AND max_age_rating IS NULL AND NOT age_rating_pinned) AS default_denied
        FROM users WHERE username = ${username.toLowerCase()}
            AND disabled_at IS NULL AND deleted_at IS NULL
    `;
    return rows.length > 0 && rows[0].allow_live_tv !== false && !rows[0].default_denied;
}

export async function setUserLiveTvAllowed(
    sql: postgres.Sql,
    username: string,
    allowed: boolean,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE users SET allow_live_tv = ${allowed}, updated_at = NOW()
        WHERE username = ${username.toLowerCase()} RETURNING id
    `;
    return rows.length > 0;
}
