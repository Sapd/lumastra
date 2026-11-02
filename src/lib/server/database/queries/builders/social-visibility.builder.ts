// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Social Listening Visibility Builder
 *
 * THE one shared predicate for "may the viewer see this person's listening
 * position?" (design doc `2026-07-28-audiobook-social-design.md` §3). Every
 * social surface — modal in-progress rows, shared-listen detection, player
 * scrubber markers, the coarse activity rail — calls this and nothing else, so a
 * future refinement (per-dimension sharing, per-person exceptions) lands in one
 * file instead of four query modules.
 *
 * ## What it enforces
 *
 * 1. `hide_streams = false` on the subject — the existing private tier, already
 *    load-bearing in `social.queries.ts`, `social-activity.queries.ts`,
 *    `active-sessions-view.service.ts` and the per-user stats gate. Not
 *    reinvented here.
 * 2. The subject is not the viewer, and is a LIVE account — neither soft-deleted
 *    (`deleted_at`) nor deactivated (`disabled_at`).
 *
 *    This clause narrows both modes but was added for `household`. Under `groups`
 *    a dead account only leaked if an admin had explicitly put it in the trust
 *    circle; `household` puts every row in `users` in the audience, so without
 *    this a deactivated or soft-deleted person keeps broadcasting their reading
 *    position indefinitely. `admin-stats.queries.ts` already treats
 *    `deleted_at IS NULL` as what "a user" means; this matches. It can only ever
 *    REMOVE rows, so it cannot leak.
 * 3. The audience test, which depends on `SOCIAL_DEFAULT_AUDIENCE`:
 *    - `household` — no group test at all; every user on the instance qualifies.
 *    - `groups` — subject and viewer SHARE a designated trust group
 *      (`SOCIAL_TRUST_GROUPS`).
 *    - `auto` (default) — `groups` when any are configured, else `household`.
 * 4. No `user_media_share_opt_out` row for (subject, book).
 * 5. On audiobook surfaces, the subject has enabled the audiobook-wide sharing
 *    switch (`users.share_audiobook_activity`).
 * 6. For the `'activity'` tier only: both sides have sharing enabled
 *    (`users.share_listening_activity`), so nobody reads behavioural data
 *    without exposing their own. Audiobook activity also requires the viewer's
 *    audiobook-wide switch, preventing a globally hidden viewer from lurking.
 *
 * ## Why "share a designated group", not the three separate clauses
 *
 * The design doc writes the circle test as three conditions — subject in a
 * designated group, viewer in a designated group, and *some* group in common.
 * That combination is weaker than it reads, for the reason the same section
 * gives when it rejects using all of `users.groups`: broad IdP groups. With two
 * designated circles `family` and `friends`, and everyone also carrying a broad
 * `users` group from the IdP, a `family` member and a `friends` member both pass
 * the designated checks and then satisfy "some group in common" via `users` — the
 * circles collapse into one, which is the exact failure the designation exists to
 * prevent.
 *
 * The predicate implemented here requires the shared group to itself be
 * designated. That implies all three of the doc's clauses (you cannot share a
 * designated group without both being in one) and drops the leak. It is strictly
 * stronger, never weaker, so no row visible under the doc's wording but hidden
 * here was ever inside a deliberately-drawn circle.
 *
 * ## Why effective groups are recomputed in SQL for BOTH sides
 *
 * `users.groups` has several writers — forward-auth's per-request sync, the
 * device-authorize route, the OIDC login sync, OIDC/auth-plugin provisioning
 * (`user-identity.service.ts`), and the native-admin / admin-create paths
 * (`users.queries.ts`, which write `ADMIN_GROUPS` or `[]`) — and none of them
 * writes in-app access-group names into it (`forward-auth.ts`: "Persist the
 * IdP/pin-derived projection only — NOT the in-app access merge"). The read-time merge (`resolveInAppAccess`) is
 * request-scoped and exists only for the *viewer*. So:
 *
 * - a predicate on `users.groups` alone returns nothing on a standalone install
 *   (nobody has IdP groups) — the feature would go silently dark;
 * - passing the viewer's request-scoped `locals.user.userGroups` in and reading
 *   `users.groups` for the subject gives ASYMMETRIC visibility on a mixed
 *   install: A sees B but B does not see A.
 *
 * Both sides are therefore computed identically, in SQL, as the union of
 * `users.groups` and `user_access_groups -> access_groups.name`. That also fixes
 * the doc's §6 "stale users.groups" hazard for half the input: in-app group
 * membership is read live from the DB and cannot go stale on a TV client that
 * never hits the forward-auth sync path.
 *
 * NOTE the column name: the join is `user_access_groups.group_id`, not
 * `access_group_id` as the design doc's pseudo-SQL writes it.
 *
 * ## Case
 *
 * `upsertUserGroups` stores IdP group names VERBATIM (only the username is
 * lowercased), `access_groups` enforces uniqueness on `lower(name)` but stores
 * the operator's casing, and Postgres `&&` is case-sensitive. `hashGroups`
 * lowercases, so the throttle can consider `['Household']` and `['household']`
 * identical while `&&` does not. Every name on every side — including the
 * configured allowlist — is therefore folded and trimmed, and empties are
 * dropped.
 *
 * **The fold happens in exactly one place: Postgres `lower()`.** It used to
 * happen twice — `String.prototype.toLowerCase()` on the configured list in JS,
 * `lower()` on the two group columns in SQL — and those are not the same function.
 * `lower()` is collation-dependent: under a `C`-locale database it folds ASCII
 * only, so a circle named `Família` became `família` on the JS side and stayed
 * `FAMÍLIA`→`famÍlia` on the SQL side, `= ANY(...)` matched nothing, and an
 * entire configured circle went dark with no error — the silent-mismatch shape
 * this codebase keeps getting bitten by. {@link getDesignatedTrustGroups}
 * therefore trims but does NOT lowercase, and the SQL folds both sides itself.
 *
 * ## Catalogue dismissal hides a book from the circle too
 *
 * `media_items.is_dismissed` is a CATALOGUE-level withdrawal (operator/scanner —
 * `dismissMediaItemWithChildren`, cleared by `undismissMediaItem`), not a per-user
 * preference; per-user recommendation dismissal is a separate ephemeral mechanism
 * in `dismiss.service.ts` and does not touch this column. A dismissed row is
 * filtered out of every browse read, so broadcasting someone's position in it
 * would advertise a title nobody in the circle can open.
 *
 * The design doc leaves this open ("this spec assumes orthogonal"). It is decided
 * here, deliberately, in the fail-closed direction: dismissed means not shared.
 * That can only ever REMOVE rows, so it cannot leak, and it keeps this predicate
 * consistent with `audiobook-browse.queries.ts`, which already hides dismissed
 * books from the person who owns the position. If a future product decision wants
 * them shared again, change it HERE — the point of this module is that there is
 * one place to change.
 *
 * ## Unconfigured means DARK — in group mode only
 *
 * With `groups` mode and no designated group the builder emits `AND false`: the
 * fail-closed direction, so an operator who names no circle never broadcasts
 * anyone's reading position.
 *
 * That rule does NOT extend to `household`, where having no groups is the normal
 * state rather than a misconfiguration — it is the whole reason the mode exists.
 * `auto` keeps the old behaviour for anyone who already named groups and gives a
 * fresh install a working default instead of a silently dark feature.
 *
 * Callers that want to *explain* the state to an admin should ask
 * {@link isSocialSharingConfigured} rather than inferring it from an empty result.
 *
 * @module builders/social-visibility
 */

import type postgres from 'postgres';
import { config } from '../../../config.js';

/**
 * Sharing tier being read.
 *
 * - `'ambient'` — the default tier: ratings, reviews, progress, chapter,
 *   finished. Available to anyone in the circle who has not set `hide_streams`.
 * - `'activity'` — the coarse-grained rail. Reciprocal: the subject must
 *   have `share_listening_activity = true` AND so must the viewer.
 */
export type SocialSharingTier = 'ambient' | 'activity';

/**
 * How the predicate finds the media row for the per-book opt-out check.
 *
 * A bare string is a literal media UUID (single-item surfaces: the modal). The
 * object form names a column in the surrounding query (list surfaces: the rail),
 * e.g. `{ alias: 'uwh', column: 'media_id' }`.
 */
export type SocialShareMediaRef = string | { alias: string; column?: string };

export interface SocialVisibilityOptions {
    /** `users.id` of the person doing the looking. */
    viewerId: string;
    /** The media item whose opt-out is checked. */
    media: SocialShareMediaRef;
    /**
     * Alias of the joined `users` row for the SUBJECT in the surrounding query.
     * Defaults to `u_priv`, matching `social-activity.queries.ts`.
     */
    subjectAlias?: string;
    /** Defaults to `'ambient'`. */
    tier?: SocialSharingTier;
    /**
     * Designated trust groups, for tests and for callers that already resolved
     * them. Defaults to `config.SOCIAL_TRUST_GROUPS`.
     */
    trustGroups?: readonly string[];
    /**
     * Audience mode override for tests and callers that already resolved it.
     * Accepts the raw setting value including `'auto'`. Defaults to
     * `config.SOCIAL_DEFAULT_AUDIENCE`.
     */
    audienceMode?: string;
    /** Apply the audiobook-only global sharing switch for audiobook surfaces. */
    audiobook?: boolean;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Canonical UUID text form, any version. `buildMediaRef` checks a literal media id
 * against this before casting so a malformed value fails with a message naming the
 * builder instead of a raw Postgres `22P02`.
 */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The designated trust circle(s), trimmed, de-duplicated and with empties dropped
 * — the form the SQL compares against.
 *
 * **Case is deliberately preserved.** The comparison is case-insensitive, but the
 * fold is Postgres `lower()` applied to this array and to both group columns, so
 * all three sides go through the SAME collation. Pre-folding here in JS made the
 * two sides disagree under a `C`-locale database (see the module doc). De-dup is
 * therefore on the exact trimmed string: two entries differing only in case are
 * both kept, and the SQL collapses them.
 *
 * Exported so the admin surface can report the configured circle (and its
 * absence) — in the operator's own spelling — without re-implementing this.
 */
export function getDesignatedTrustGroups(source?: readonly string[]): string[] {
    const raw = source ?? config.SOCIAL_TRUST_GROUPS;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const name of raw) {
        const trimmed = name.trim();
        if (trimmed === '' || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

/**
 * The audience the predicate should apply.
 *
 * - `'household'` — every live user on the instance is in the audience. No group test.
 * - `'groups'` — only users sharing a designated `SOCIAL_TRUST_GROUPS` entry.
 */
export type SocialAudienceMode = 'household' | 'groups';

/**
 * Resolve the configured mode, collapsing `'auto'`.
 *
 * `'auto'` means "Household unless the operator narrowed it": no configured groups
 * is a fresh install that should just work, whereas naming groups is a deliberate
 * narrowing that an upgrade must not silently undo. An unrecognised value resolves
 * to `'groups'` — the historical behaviour and the narrower of the two, so a typo
 * in settings.json can only ever under-share.
 */
export function resolveSocialAudienceMode(
    mode?: string,
    trustGroups?: readonly string[],
): SocialAudienceMode {
    // `String(...)` is load-bearing, not defensive noise. `getConfig` returns a
    // settings.json value with `return val as string | boolean | number` — a CAST,
    // not a coercion — so `"SOCIAL_DEFAULT_AUDIENCE": false` in a hand-edited
    // settings.json reaches here as a boolean despite the `string` type. Calling
    // `.trim()` on it would throw inside the visibility builder, which every social
    // surface funnels through, turning one bad character into a 500 on all of them.
    // Coerced instead: a nonsense value falls through to `'groups'`, the narrow mode.
    const raw = String(mode ?? config.SOCIAL_DEFAULT_AUDIENCE ?? 'auto')
        .trim()
        .toLowerCase();
    if (raw === 'household') return 'household';
    if (raw === 'auto') {
        return getDesignatedTrustGroups(trustGroups).length > 0 ? 'groups' : 'household';
    }
    return 'groups';
}

/**
 * False when no trust circle is configured, i.e. the listening-social feature is
 * dark. Admin surfaces must say so explicitly instead of rendering an empty
 * section that looks like "nobody is listening".
 */
export function isSocialSharingConfigured(source?: readonly string[], mode?: string): boolean {
    // Household needs no groups to be "configured" — that is the entire point of it.
    if (resolveSocialAudienceMode(mode, source) === 'household') return true;
    return getDesignatedTrustGroups(source).length > 0;
}

/** Live audience members who opted in to the relevant reciprocal sharing tier. */
export function buildSocialAudienceReach(
    sql: postgres.Sql,
    subjectAlias: string,
    audience: SocialAudienceMode,
    designated: string[],
    medium: 'audiobook' | 'listening' = 'audiobook',
): postgres.PendingQuery<postgres.Row[]> {
    assertIdentifier(subjectAlias, 'subjectAlias');
    if (audience === 'groups' && designated.length === 0) return sql`false`;
    const groups =
        audience === 'household'
            ? sql``
            : sql`AND ${effectiveDesignatedGroups(sql, { kind: 'joined', alias: subjectAlias }, designated)}
                && ${effectiveDesignatedGroups(sql, { kind: 'joined', alias: 'audience_user' }, designated)}`;
    return sql`EXISTS (
        SELECT 1 FROM users audience_user
        WHERE audience_user.id <> ${sql(subjectAlias)}.id
          AND audience_user.deleted_at IS NULL
          AND audience_user.disabled_at IS NULL
          AND ${medium === 'audiobook' ? sql`audience_user.share_audiobook_activity = true` : sql`audience_user.share_listening_activity = true`}
          ${groups}
    )`;
}

/**
 * Build the shared visibility predicate.
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param options - see {@link SocialVisibilityOptions}
 * @returns SQL fragment to append after existing WHERE conditions (includes a
 *          leading `AND`), or `AND false` when the feature is unconfigured
 */
export function buildSocialVisibilityFilter(
    sql: postgres.Sql,
    options: SocialVisibilityOptions,
): postgres.PendingQuery<postgres.Row[]> {
    const designated = getDesignatedTrustGroups(options.trustGroups);
    const mode = resolveSocialAudienceMode(options.audienceMode, options.trustGroups);
    // Unconfigured -> dark, but ONLY in group mode. Household needs no groups, so
    // reaching this with an empty list is correct there rather than misconfigured.
    // Emitted before any identifier validation so a bad instance fails closed
    // rather than throwing.
    if (mode === 'groups' && designated.length === 0) return sql`AND false`;

    const subjectAlias = options.subjectAlias ?? 'u_priv';
    assertIdentifier(subjectAlias, 'subjectAlias');
    const viewerId = options.viewerId;

    const mediaRef = buildMediaRef(sql, options.media);

    const tierFilter = buildTierFilter(sql, options.tier ?? 'ambient', subjectAlias, viewerId);
    // Reciprocal on BOTH tiers, not just `'activity'`.
    //
    // The viewer's own switch used to be checked only on the coarse activity rail,
    // so a user who turned audiobook sharing off stopped broadcasting but kept
    // receiving — and the ambient tier they kept receiving carries the FINER data
    // (exact resume position and chapter) while the reciprocal one carries rounded
    // durations and day-level dates. The stated principle here is "nobody reads
    // behavioural data without exposing their own"; it applies at least as strongly
    // to the tier that exposes more.
    //
    // This narrows only, so it cannot leak. It does mean a user who opts out loses
    // the scrubber markers and shared-listen indicator — which is the point: those
    // are other people's positions.
    const audiobookFilter = options.audiobook
        ? sql`
            AND ${sql(subjectAlias)}.share_audiobook_activity = true
            AND EXISTS (
                SELECT 1 FROM users vu_audiobook
                WHERE vu_audiobook.id = ${viewerId}::uuid
                  AND vu_audiobook.share_audiobook_activity = true
            )
        `
        : sql``;

    // The catalogue-dismissal clause. `media_items` is read for `is_dismissed`
    // ONLY, and only to REMOVE rows — see the module doc for why dismissal is
    // decided here rather than left implicit. Access to the item itself is the
    // caller's gate (the routes run `checkMediaAccess` first), per the three-tier
    // rule that queries never gate and routes do.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- is_dismissed lookup only; narrows, never widens; caller gates
    const notDismissed = sql`
        AND NOT EXISTS (
            SELECT 1 FROM media_items mi_share
            WHERE mi_share.id = ${mediaRef}
              AND mi_share.is_dismissed = true
        )
    `;

    // In household mode the audience IS the instance, so there is no group test at
    // all — not an overlap against "every group", which would still exclude a user
    // carrying no groups (the normal state on a native-auth install, and precisely
    // the install household mode exists for).
    const audienceFilter =
        mode === 'household'
            ? sql``
            : sql`
        AND ${effectiveDesignatedGroups(sql, { kind: 'joined', alias: subjectAlias }, designated)}
            && ${effectiveDesignatedGroups(sql, { kind: 'byId', userId: viewerId }, designated)}
    `;

    return sql`
        AND (${sql(subjectAlias)}.hide_streams IS NULL OR ${sql(subjectAlias)}.hide_streams = false)
        AND ${sql(subjectAlias)}.id <> ${viewerId}::uuid
        AND ${sql(subjectAlias)}.deleted_at IS NULL
        AND ${sql(subjectAlias)}.disabled_at IS NULL
        ${audiobookFilter}
        ${tierFilter}
        ${audienceFilter}
        AND NOT EXISTS (
            SELECT 1 FROM user_media_share_opt_out umso
            WHERE umso.user_id = ${sql(subjectAlias)}.id
              AND umso.media_id = ${mediaRef}
        )
        ${notDismissed}
    `;
}

/**
 * The per-tier extra conditions.
 *
 * Reciprocity for the coarse activity rail is deliberately part of THIS predicate and not
 * left to the calling surface: the doc makes the activity tier reciprocal
 * ("nobody consumes behavioural data without exposing their own"), and a guard a
 * caller has to remember is a guard a caller will forget.
 *
 * Written as an exhaustive switch rather than `tier === 'activity' ? … : …`. The
 * ternary form treated every value that was not `'activity'` as the weaker
 * `'ambient'` behaviour, so adding a third tier to {@link SocialSharingTier}
 * would have silently downgraded it here instead of failing. The `never` default
 * makes the compiler point at this function instead.
 */
function buildTierFilter(
    sql: postgres.Sql,
    tier: SocialSharingTier,
    subjectAlias: string,
    viewerId: string,
): postgres.PendingQuery<postgres.Row[]> {
    switch (tier) {
        case 'ambient':
            return sql``;
        case 'activity':
            return sql`
                AND ${sql(subjectAlias)}.share_listening_activity = true
                AND EXISTS (
                    SELECT 1 FROM users vu_tier
                    WHERE vu_tier.id = ${viewerId}::uuid
                      AND vu_tier.share_listening_activity = true
                )
            `;
        default: {
            const unhandled: never = tier;
            throw new Error(
                `buildSocialVisibilityFilter: unhandled sharing tier ${String(unhandled)}`,
            );
        }
    }
}

/**
 * Which person's groups to collect: a `users` row already joined into the
 * surrounding query under `alias` (the subject), or one looked up by id (the
 * viewer, who is not joined).
 */
type GroupSubject = { kind: 'joined'; alias: string } | { kind: 'byId'; userId: string };

/**
 * `ARRAY(...)` of the designated groups one person belongs to, unioned across
 * both group sources and normalised to lower case.
 *
 * Filtering to the designated set INSIDE the array is what makes the outer `&&`
 * mean "shares a designated group" rather than "shares any group at all" (see
 * the module doc). It also keeps both arrays tiny — at most one element per
 * configured circle — so the overlap test never depends on how many broad IdP
 * groups an install hands out.
 *
 * `designated` arrives with the operator's own casing and is folded HERE, by the
 * same `lower()` that folds the group columns — one collation for all three sides.
 */
function effectiveDesignatedGroups(
    sql: postgres.Sql,
    subject: GroupSubject,
    designated: string[],
): postgres.PendingQuery<postgres.Row[]> {
    // Folded by Postgres, not by JS, so the configured list and the stored group
    // names can never disagree about what "same name, different case" means.
    //
    // Built per use rather than shared: a postgres.js fragment carries its own
    // parameter slots, and interpolating one object into two places in the same
    // template is not a documented reuse.
    const designatedFolded = (): postgres.PendingQuery<postgres.Row[]> => sql`ARRAY(
        SELECT lower(btrim(d.name)) FROM unnest(${designated}::text[]) AS d(name)
    )`;

    // The IdP half. For a joined row the array comes straight off the alias; for
    // a bare id the row has to be brought in, which is why the two branches are
    // not one expression.
    const idpGroups =
        subject.kind === 'joined'
            ? sql`
            SELECT lower(btrim(g.name)) AS name
            FROM unnest(COALESCE(${sql(subject.alias)}.groups, ARRAY[]::text[])) AS g(name)
            WHERE lower(btrim(g.name)) = ANY(${designatedFolded()})
        `
            : sql`
            SELECT lower(btrim(g.name)) AS name
            FROM users vu_groups, unnest(COALESCE(vu_groups.groups, ARRAY[]::text[])) AS g(name)
            WHERE vu_groups.id = ${subject.userId}::uuid
              AND lower(btrim(g.name)) = ANY(${designatedFolded()})
        `;

    // The in-app half — identical for both branches apart from how the user is
    // named. This is the half `users.groups` alone would miss entirely.
    const inAppGroups =
        subject.kind === 'joined'
            ? sql`uag.user_id = ${sql(subject.alias)}.id`
            : sql`uag.user_id = ${subject.userId}::uuid`;

    return sql`ARRAY(
        ${idpGroups}
        UNION
        SELECT lower(btrim(ag.name)) AS name
        FROM user_access_groups uag
        JOIN access_groups ag ON ag.id = uag.group_id
        WHERE ${inAppGroups}
          AND lower(btrim(ag.name)) = ANY(${designatedFolded()})
    )`;
}

/**
 * Resolve the opt-out media reference to a bound parameter or a column ref.
 *
 * The literal form is shape-checked before the `::uuid` cast. Today's callers all
 * pass an already-resolved internal UUID, but this module is documented as THE
 * entry point future surfaces call directly, and an unchecked cast turns a bad id
 * into a raw Postgres `22P02` from deep inside a builder rather than an error that
 * names where it came from.
 */
function buildMediaRef(
    sql: postgres.Sql,
    media: SocialShareMediaRef,
): postgres.PendingQuery<postgres.Row[]> {
    if (typeof media === 'string') {
        if (!UUID_TEXT.test(media)) {
            throw new Error(`buildSocialVisibilityFilter: invalid media id "${media}"`);
        }
        return sql`${media}::uuid`;
    }
    assertIdentifier(media.alias, 'media.alias');
    const column = media.column ?? 'media_id';
    assertIdentifier(column, 'media.column');
    return sql`${sql(media.alias)}.${sql(column)}`;
}

function assertIdentifier(value: string, label: string): void {
    if (!SAFE_IDENTIFIER.test(value)) {
        throw new Error(`buildSocialVisibilityFilter: invalid ${label} "${value}"`);
    }
}
