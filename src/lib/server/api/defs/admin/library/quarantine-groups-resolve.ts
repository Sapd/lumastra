// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/quarantine-groups-resolve.ts
 *
 * POST /api/admin/library/quarantine-groups/resolve
 *
 * Review, recheck or explicitly dismiss warnings for one series group
 * (see quarantine-groups.ts for the grouping key: seriesId, falling back to
 * parentTmdbId). Actions:
 *
 *   - 'dismiss' — mark every unresolved row in the group resolved with
 *     resolution='dismissed', guarded by the exact listed group fingerprint.
 *   - 'restore' — show again only unchanged original receipt-batch members;
 *     paginated by warning id, never a media rollback.
 *   - 'recheck' — close only unchanged ordinary proposals already proven applied,
 *     without provider calls or media writes; bounded batches return continuation.
 *   - 'preview-current-match' / 'confirm-current-match' — show exact current
 *     positional matches, then close only explicitly selected warning revisions.
 *     This acknowledges metadata without claiming file-content identity.
 *   - 'preview-accept' / 'accept' — review an exact bounded warning page plus
 *     complete eligible dependency components before applying the displayed
 *     identity, title and provider values. Changed pages require a fresh preview;
 *     skipped/blocked warnings remain unresolved and continuation reaches later rows.
 *
 * `resolvedBy` is ALWAYS the authenticated admin's username, matching the
 * existing single-row POST /api/admin/quarantine/[id]/resolve convention.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { action, resolved, appliedExternalIds?, updatedTitles?, skipped? }
 * 422 validation_failed when neither seriesId nor parentTmdbId is given, or
 *     'accept' is requested without a resolvable seriesId.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    hideQuarantineGroup,
    showQuarantineWarningsAgain,
} from '$lib/server/services/quarantine-inspection.service.js';
import {
    acceptQuarantinedMatchesForSeries,
    recheckQuarantinedMatchesForSeries,
    confirmQuarantinedCurrentMatchesForSeries,
} from '$lib/server/services/episode-reconciliation.service.js';
import { quarantineGroupResolveBodySchema } from '$lib/schemas/api-admin-library-responses.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: quarantineGroupResolveBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const {
                seriesId,
                parentTmdbId,
                action,
                after,
                limit,
                reviewed,
                reviewedPage,
                groupKey,
                groupFingerprint,
                batchId,
            } = ctx.input!.body;
            if (!seriesId && !parentTmdbId && !groupKey && action !== 'restore') {
                return ApiProblem.validationFailed('seriesId or parentTmdbId is required');
            }
            // A non-UUID seriesId reached a `= $1::uuid` comparison and came
            // back as a 500 instead of a validation error.
            if (seriesId && !UUID_RE.test(seriesId)) {
                return ApiProblem.validationFailed('seriesId must be a UUID');
            }

            // resolvedBy is ALWAYS the authenticated admin's username — never from body.
            const resolvedBy = event.locals.principal?.username ?? event.locals.user?.username;
            if (!resolvedBy) return ApiProblem.unauthorized('Authenticated actor required');

            if (action === 'restore') {
                if (!batchId || seriesId || parentTmdbId || groupKey || limit || groupFingerprint)
                    return ApiProblem.validationFailed(
                        'Show again requires only a warning batch and optional continuation',
                    );
                const result = await showQuarantineWarningsAgain(sql, batchId, resolvedBy, after);
                return json({
                    action,
                    resolved: 0,
                    restored: result.restored,
                    changed: result.changed,
                    continuation: result.continuation,
                });
            }
            if (seriesId && parentTmdbId)
                return ApiProblem.validationFailed('Choose one group key');
            if (action === 'dismiss' && (after || limit))
                return ApiProblem.validationFailed('dismiss does not accept continuation');
            if (action === 'recheck') {
                if (!seriesId) return ApiProblem.validationFailed('recheck requires seriesId');
                const result = await recheckQuarantinedMatchesForSeries(sql, seriesId, resolvedBy, {
                    after,
                    limit,
                });
                return json({ action, ...result });
            }
            if (action === 'preview-current-match' || action === 'confirm-current-match') {
                if (!seriesId)
                    return ApiProblem.validationFailed('Current-match review requires seriesId');
                if (action === 'confirm-current-match' && (!reviewed || !reviewedPage))
                    return ApiProblem.validationFailed('Review and select current matches first');
                const result = await confirmQuarantinedCurrentMatchesForSeries(
                    sql,
                    seriesId,
                    resolvedBy,
                    {
                        after,
                        limit,
                        reviewed,
                        reviewedPage,
                        preview: action === 'preview-current-match',
                    },
                );
                const { review, ...totals } = result;
                return json({
                    action,
                    ...totals,
                    ...(review ? { currentMatchReview: review } : {}),
                });
            }

            if (action === 'dismiss') {
                if (!groupFingerprint)
                    return ApiProblem.validationFailed('Current group revision is required');
                const key = groupKey ?? seriesId ?? `tmdb:${parentTmdbId}`;
                if (
                    (groupKey && (seriesId || parentTmdbId)) ||
                    !(UUID_RE.test(key) || /^tmdb:.+/.test(key) || key === 'unknown')
                )
                    return ApiProblem.validationFailed('Choose one valid group key');
                const result = await hideQuarantineGroup(sql, key, groupFingerprint, resolvedBy);
                if (!result)
                    return ApiProblem.conflict(
                        'Warnings changed or are busy. Refresh before hiding.',
                    );
                return json({ action, ...result });
            }

            // action === 'accept'
            if (!seriesId) {
                return ApiProblem.validationFailed(
                    'accept requires a resolvable seriesId (parentTmdbId-only groups have no series to re-match)',
                );
            }
            if (action === 'accept' && (!reviewed || !reviewedPage))
                return ApiProblem.validationFailed(
                    'Review the proposed dependency batch before accepting',
                );
            const result = await acceptQuarantinedMatchesForSeries(sql, seriesId, resolvedBy, {
                after,
                limit,
                reviewed,
                reviewedPage,
                preview: action === 'preview-accept',
            });
            return json({
                action,
                resolved: result.accepted,
                appliedExternalIds: result.appliedExternalIds,
                updatedTitles: result.updatedTitles,
                skipped: result.skipped,
                review: result.review,
                inspectableEpisodeIds: result.inspectableEpisodeIds,
                reviewedPage: result.reviewedPage,
                pageChanged: result.pageChanged,
                blocked: result.blocked,
                blockedReview: result.blockedReview,
                examined: result.examined,
                continuation: result.continuation,
            });
        },
    },
});
