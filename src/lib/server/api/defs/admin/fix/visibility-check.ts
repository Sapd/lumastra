// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/visibility-check — "why can't user X see item Y?"
 *
 * GET /api/admin/fix/visibility-check?userId=…&mediaId=… → VisibilityCheck.
 * Auth: admin. Errors: problem+json.
 *
 * ## Why this exists at all
 *
 * Every gate involved is already a table, and `checkMediaAccess` already
 * combines them correctly. What no surface could do is say WHICH gate decided —
 * and that is the entire content of the support thread. "It's there, I can see
 * it, they can't" is answered by a denied library group id or an age ceiling,
 * and by nothing else.
 *
 * ## It re-implements the gate ORDER, and that is the risk
 *
 * This endpoint evaluates the same gates `checkMediaAccess` does, in the same
 * order, because it must report each one's verdict rather than a combined
 * boolean. That duplication is the hazard: an explainer that agreed on the
 * answer but disagreed on the reason would send an operator to fix the wrong
 * thing. So it mirrors the real implementation step for step —
 *
 *   1. item exists                    (a bad id must not read as "denied")
 *   2. admin bypass                   (`isMediaAccessible` returns true for admins)
 *   3. library access                 (denied groups vs the item's files)
 *   4. age rating                     (only when the user is age-restricted)
 *
 * — and `checkMediaAccess` is called at the end as the AUTHORITY for `visible`.
 * The per-gate detail explains; the real function decides. If they ever
 * disagree, the explanation is what is wrong, not the verdict.
 *
 * ## `has-files` is reported but is not an access gate
 *
 * A discovery-only row appears on discovery surfaces and never on `/browse`,
 * which is always library-local. No access check will ever mention it, and it
 * is a common reason one person sees a title and another does not, so it is
 * surfaced explicitly rather than left to be rediscovered.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import {
    getDeniedLibraryGroups,
    isMediaAccessible,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { buildFileBackedVideoItemFilter } from '$lib/server/database/queries/builders/file-backed-media.builder.js';
import { seriesOwnedAgeRatingExpression } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { config } from '$lib/server/config.js';
import { buildUserPermissions } from '$lib/server/auth.js';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service.js';
import {
    MOST_RESTRICTIVE_AGE_RATING,
    computeOwnerMaxAge,
    mergeMaxAge,
} from '$lib/server/auth/resolve-token-user-access.js';
import type { UserContext } from '$lib/server/types.js';
import type {
    VisibilityCheck,
    VisibilityGate,
} from '$lib/components/admin/fix/visibility-check.schema.js';

// `.uuid()` rather than `.min(1)`: both ids reach a `::uuid` cast, and the page
// feeds them from a free-text field. A pasted title or Jellyfin id would
// otherwise surface as a Postgres 22P02 → 500 instead of a 400 the operator can
// read and act on.
const QuerySchema = z.object({
    userId: z.string().uuid(),
    mediaId: z.string().uuid(),
});

/**
 * A gate's explanation: a stable `code` plus `params` the page renders in the
 * user's language, and the same sentence in English as `detail` (kept as a
 * fallback for one release, and for logs).
 */
function ex(
    code: string,
    params: Record<string, string | number>,
    detail: string,
): Pick<VisibilityGate, 'code' | 'params' | 'detail'> {
    return { code, params, detail };
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getAdminDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            const { userId, mediaId } = ctx.input!.query;

            const user = await getUserById(sql, userId);
            if (!user) {
                return ApiProblem.notFound('User not found');
            }

            const [item] = await sql<
                {
                    id: string;
                    title: string;
                    media_type: string;
                    has_files: boolean | null;
                    is_dismissed: boolean;
                    age_rating: number | null;
                    status: string;
                    browsable: boolean;
                }[]
            >`
                SELECT mi.id, mi.title, mi.media_type, mi.has_files, mi.is_dismissed,
                       ${seriesOwnedAgeRatingExpression(sql, 'mi')} AS age_rating, mi.status,
                       -- The rule Browse applies: active, and file-backed (a series
                       -- or season by its active, file-backed episodes, not by
                       -- its own roll-up flag). The builder emits its own AND.
                       (mi.status = 'active' ${buildFileBackedVideoItemFilter(sql, true)})
                           AS browsable
                  FROM media_items mi
                 WHERE mi.id = ${mediaId}::uuid
                 LIMIT 1
            `;

            const gates: VisibilityGate[] = [];

            if (!item) {
                // A missing item is NOT a denial, and reporting it as one would
                // send an operator to check permissions for something that does
                // not exist. Report it as its own outcome and evaluate nothing
                // further — every later gate would be a claim about a row that
                // is not there.
                gates.push({
                    gate: 'item-exists',
                    passed: false,
                    evaluated: true,
                    ...ex('item-missing', { mediaId }, `No media item with id ${mediaId}`),
                });
                const payload: VisibilityCheck = {
                    generatedAt: new Date().toISOString(),
                    userId: user.id,
                    username: user.username,
                    userIsAdmin: user.is_admin,
                    userMaxAgeRating: user.max_age_rating,
                    userGroups: user.groups ?? [],
                    mediaId,
                    mediaTitle: '—',
                    mediaType: '—',
                    visible: false,
                    browsable: false,
                    blockedBy: 'item-exists',
                    gates,
                };
                return json(payload);
            }

            gates.push({
                gate: 'item-exists',
                passed: true,
                evaluated: true,
                ...ex(
                    'item-found',
                    { title: item.title, type: item.media_type },
                    `${item.title} (${item.media_type})`,
                ),
            });

            // Not an access gate — reported because it explains a large share of
            // "they can't see it" with no permission involved at all.
            const isContainer = ['tv', 'series', 'season'].includes(item.media_type);
            gates.push({
                gate: 'has-files',
                passed: item.browsable,
                evaluated: true,
                ...(item.browsable
                    ? ex(
                          'files-present',
                          {},
                          'Has files on disk, so it appears on library surfaces',
                      )
                    : item.status !== 'active'
                      ? ex(
                            'files-status',
                            { status: item.status },
                            `The entry's status is "${item.status}", so no library surface shows it.`,
                        )
                      : item.is_dismissed
                        ? ex(
                              'files-dismissed',
                              {},
                              'Removed from the library (dismissed), so it appears on no ' +
                                  'library surface even though its files may still be on disk.',
                          )
                        : isContainer
                          ? ex(
                                'files-container-none',
                                {},
                                'None of its episodes is an active entry with a file on disk, so ' +
                                    'Browse does not show it.',
                            )
                          : ex(
                                'files-discovery-only',
                                {},
                                'No files on disk. This is a discovery-only entry: it appears on ' +
                                    'Trending/For You/Search when unavailable media is shown, and ' +
                                    'never in Browse, which is always library-local.',
                            )),
            });

            // ---------------------------------------------------------------
            // Resolve the SAME permission subject production resolves.
            //
            // Reading users.max_age_rating directly was wrong, and wrong in the
            // dangerous direction. The effective ceiling is derived from GROUPS
            // at request time (`resolveMaxAgeFromGroups` inside
            // `buildUserPermissions`), the login upsert never writes
            // `max_age_rating`, and the in-app cohort layer MIN-merges on top.
            // A user restricted purely by an `age-*` IdP group therefore has
            // NULL in that column — and the old code reported "no age ceiling",
            // fed `isAgeRestricted: false` into checkMediaAccess so even the
            // authoritative call skipped the age gate, and told the operator
            // the item was visible to someone who actually gets a 404.
            //
            // The two pins are applied exactly as `forward-auth.ts:348-349`
            // applies them: a pin overrides the derived value in both
            // directions; absent a pin, the derived value wins.
            // The error path reports the MOST restrictive age ceiling rather
            // than an empty capability set (security review 2026-09-17, C12 —
            // the same fix `forward-auth.ts`'s `resolveInAppAccess` and
            // `resolve-token-user-access.ts`'s `resolveInAppAccessSafe` carry,
            // importing the same constant so there is one number to keep in
            // sync). `max_age_rating` is MIN-merged, not additive, so
            // `capabilities: {}` does NOT degrade to "nothing extra" on the age
            // axis — it ERASES the ceiling, and this tool would then report the
            // age gate as "skipped — no age ceiling configured" for a user who
            // is in fact restricted. That is the same confident wrong answer
            // the comment above describes fixing once already.
            let accessFallback = false;
            const access = await resolveEffectiveAccess(sql, user.id, user.groups ?? []).catch(
                () => {
                    accessFallback = true;
                    return {
                        effectiveGroups: user.groups ?? [],
                        capabilities: { maxAgeRating: MOST_RESTRICTIVE_AGE_RATING },
                        inAppGroupNames: [] as string[],
                    };
                },
            );
            const derived = buildUserPermissions(access.effectiveGroups, {
                isAdminOverride: user.admin_pinned ? user.is_admin : undefined,
                extraCapabilities: access.capabilities,
            });
            const isAdmin = derived.ownerIsAdmin;
            // The pin does NOT simply replace the derived ceiling. Production
            // (`resolveTokenUserAccess`) composes the two:
            //
            //     mergeMaxAge(computeOwnerMaxAge(syncedGroups, pin, pinned),
            //                 <group+in-app MIN-merged ceiling>)
            //
            // i.e. the pin-or-derived owner ceiling is then MIN-merged against
            // the in-app-merged one. The previous
            // `age_rating_pinned ? pin : derived` dropped the second half for
            // every PINNED user: an account pinned at 18 that an in-app cohort
            // caps at 6 was reported with a ceiling of 18, so a 12-rated item
            // came back "visible" when production denies it — the same
            // permissive-wins direction `mergeMaxAge` exists to prevent, and
            // the same class of wrong answer the comment above describes
            // fixing once already. Both helpers are imported from the resolver
            // rather than re-derived, so there is one formula, not a fourth
            // copy.
            const ownerMaxAge = computeOwnerMaxAge(
                user.groups ?? [],
                user.max_age_rating,
                user.age_rating_pinned,
            );
            const effectiveMaxAge = isAdmin ? null : mergeMaxAge(ownerMaxAge, derived.maxAgeRating);

            // A disabled or deleted account cannot sign in, so it sees nothing,
            // whatever the gates below would allow.
            const accountActive = !user.disabled_at && !user.deleted_at;
            gates.push({
                gate: 'account',
                passed: accountActive,
                evaluated: true,
                ...(user.deleted_at
                    ? ex(
                          'account-deleted',
                          {},
                          'This account is deleted, so it cannot sign in at all',
                      )
                    : user.disabled_at
                      ? ex(
                            'account-disabled',
                            {},
                            'This account is disabled, so it cannot sign in at all',
                        )
                      : ex('account-active', {}, 'Active account')),
            });

            // Evaluated only for an administrator: for anyone else nothing was
            // bypassed, and a green tick on "Administrator bypass" would read as
            // if it had been.
            gates.push({
                gate: 'admin-bypass',
                passed: true,
                evaluated: isAdmin,
                ...(isAdmin
                    ? ex(
                          'admin-yes',
                          {},
                          'Administrator — the library and age gates are skipped entirely',
                      )
                    : ex('admin-no', {}, 'Not an administrator, so the gates below apply')),
            });

            // --- library access -------------------------------------------------
            const accessUser = { isAdmin, userGroups: access.effectiveGroups };
            let libraryPassed = true;
            let libraryDetail: ReturnType<typeof ex>;
            if (isAdmin) {
                libraryPassed = true;
                libraryDetail = ex(
                    'library-admin',
                    {},
                    'Skipped — administrators are never library-restricted',
                );
            } else {
                const denied = await getDeniedLibraryGroups(sql, accessUser);
                if (!denied) {
                    libraryDetail = ex(
                        'library-open',
                        {},
                        "No library group is withheld from this user's groups, so every " +
                            'library is reachable',
                    );
                } else {
                    libraryPassed = await isMediaAccessible(sql, item.id, accessUser);
                    libraryDetail = libraryPassed
                        ? ex(
                              'library-partly-withheld',
                              { count: denied.length },
                              `${denied.length} library group(s) are withheld from this user, but ` +
                                  'this item has at least one file outside them',
                          )
                        : ex(
                              'library-withheld',
                              { ids: denied.join(', ') },
                              `Every file of this item lives in a library group withheld from this ` +
                                  `user. Withheld group ids: ${denied.join(', ')}`,
                          );
                }
            }
            gates.push({
                gate: 'library-access',
                passed: libraryPassed,
                evaluated: !isAdmin,
                ...libraryDetail,
            });

            // --- age rating -----------------------------------------------------
            // Mirrors `checkAgeGate`: only runs for an age-restricted user, and
            // an unrated item is governed by UNRATED_CONTENT_VISIBLE rather than
            // by the ceiling.
            const isAgeRestricted = !isAdmin && effectiveMaxAge !== null;
            let agePassed = true;
            let ageDetail: ReturnType<typeof ex>;
            if (!isAgeRestricted) {
                ageDetail = isAdmin
                    ? ex('age-admin', {}, 'Skipped — administrators are not age-restricted')
                    : ex('age-none', {}, 'Skipped — this user has no age ceiling configured');
            } else {
                const max = effectiveMaxAge ?? 0;
                if (item.age_rating === null) {
                    agePassed = config.UNRATED_CONTENT_VISIBLE;
                    ageDetail = agePassed
                        ? ex(
                              'age-unrated-visible',
                              {},
                              'This item is unrated, and unrated content is configured as visible',
                          )
                        : ex(
                              'age-unrated-hidden',
                              {},
                              'This item is unrated, and unrated content is configured as hidden ' +
                                  'from age-restricted users (UNRATED_CONTENT_VISIBLE is off)',
                          );
                } else {
                    agePassed = item.age_rating <= max;
                    ageDetail = agePassed
                        ? ex(
                              'age-within',
                              { rating: item.age_rating, max },
                              `Item is rated ${item.age_rating}, at or below this user's ceiling of ${max}`,
                          )
                        : ex(
                              'age-above',
                              { rating: item.age_rating, max },
                              `Item is rated ${item.age_rating}, above this user's ceiling of ${max}`,
                          );
                }
            }
            if (accessFallback && isAgeRestricted) {
                // Without this, a lookup failure reads as "this user's ceiling is
                // 0" and the operator edits a ceiling that is not the problem.
                ageDetail = {
                    ...ageDetail,
                    params: { ...ageDetail.params, fallback: 1 },
                    detail:
                        ageDetail.detail +
                        '. The in-app group lookup failed, so the most restrictive ceiling ' +
                        'was assumed, as sign-in does on the same failure.',
                };
            }
            gates.push({
                gate: 'age-rating',
                passed: agePassed,
                evaluated: isAgeRestricted,
                ...ageDetail,
            });

            // The REAL function decides `visible`. The gates above explain; if the
            // two ever disagree, the explanation is what is broken, not the verdict.
            //
            // `checkMediaAccess` reads exactly four fields off the user, so only
            // those are supplied. The `satisfies` is the guard that makes the
            // cast safe to keep: rename or retype any of them on `UserContext`
            // and this stops compiling, instead of silently passing `undefined`
            // into a gate and reporting a confident wrong answer.
            const accessSubject = {
                ownerIsAdmin: isAdmin,
                userGroups: access.effectiveGroups,
                isAgeRestricted,
                maxAgeRating: effectiveMaxAge,
            } satisfies Pick<
                UserContext,
                'ownerIsAdmin' | 'userGroups' | 'isAgeRestricted' | 'maxAgeRating'
            >;
            const visible =
                accountActive &&
                (await checkMediaAccess(sql, item.id, accessSubject as unknown as UserContext));

            const firstBlocking = gates.find(
                (g) => g.evaluated && !g.passed && g.gate !== 'has-files',
            );

            const payload: VisibilityCheck = {
                generatedAt: new Date().toISOString(),
                userId: user.id,
                username: user.username,
                userIsAdmin: isAdmin,
                userMaxAgeRating: effectiveMaxAge,
                userGroups: access.effectiveGroups,
                mediaId: item.id,
                mediaTitle: item.title,
                mediaType: item.media_type,
                visible,
                browsable: item.browsable,
                blockedBy: visible ? null : (firstBlocking?.gate ?? 'unknown'),
                gates,
            };

            return json(payload);
        },
    },
});
