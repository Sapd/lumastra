// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `create_request` tool — ask for ONE title that is not in the library yet.
 *
 * This is the only assistant write with an irreversible EXTERNAL side effect:
 * it files a real request with the server admin's request manager. It is therefore
 * the only one that is deliberately TWO-PHASE.
 *
 *  - `confirmed: false` resolves the title, checks everything that could refuse
 *    the request (permission, requestability, TMDB id, an existing request,
 *    quota) and submits NOTHING. It hands back the exact title it resolved so
 *    the model must show it and get a yes.
 *  - `confirmed: true` submits.
 *
 * The gate is soft — a model can call twice in a row — so it is backed by two
 * hard ones: the tool is not registered at all for a caller without
 * `hasRequestPermission`, and a per-(user, title) Valkey key makes a duplicate
 * submission inside one round a no-op. The dispatch loop runs a round's tool
 * calls in PARALLEL, so two identical calls genuinely can race here.
 *
 * Everything below the resolution step is `requestManager.createRequest` — the
 * SAME sequence `POST /api/v1/requests` runs (permission → rate limit → TMDB
 * resolve → quota pre-check → create → clear dismissal). A second copy of that
 * sequence is how the `hasRequestPermission` P0 happened once already.
 *
 * @module server/proprietary/assistant-tools/create-request.tool
 */

import {
    createRequestArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type CreateRequestArgs,
} from '../../../schemas/assistant-tools.js';
import { requestManager } from '$lib/server/services/request-manager.service.js';
import { getExternalIdsByMediaId } from '../../database/queries/media-lookup.queries.js';
import { checkRateLimit, peekRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { resolveTitleForWrite } from './resolve-title.js';
import { markPendingConfirmation, isConfirmedFromEarlierInvocation } from './confirm-gate.js';
import {
    mediaRef,
    mediaYear,
    refuseAmbiguous,
    refuseFailed,
    refuseNotFound,
    publicMediaType,
    refuseWritesDisabled,
    writeOk,
} from './write-result.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

const NOTHING_HAPPENED = 'NOTHING was requested.';

/** Providers `providerResolutionService.resolveToTmdb` can actually resolve. */
const RESOLVABLE_PROVIDERS = ['tmdb', 'imdb', 'tvdb'] as const;

/** Only one submission per user+title per minute, across parallel tool calls. */
const DUPLICATE_WINDOW_SECONDS = 60;

function refuse(reason: string, note: string): AssistantToolExecuteResult {
    return { summaryForModel: JSON.stringify({ ok: false, reason, note }) };
}

export const createRequestTool: AssistantTool<CreateRequestArgs> = {
    name: ASSISTANT_TOOL_NAMES.CREATE_REQUEST,
    description:
        'Request ONE movie or TV show that is NOT in the library yet, asking the server admin to add it. TWO STEPS, always: call it first with confirmed:false to see which exact title it resolved and whether it can be requested at all, tell the user that title, and only call again with confirmed:true after they say yes. A request is a message to the admin, not playback — a requested title is NOT watchable yet. One title per call.',
    argsSchema: createRequestArgsSchema,

    async execute(
        args: CreateRequestArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.writesAllowed) return refuseWritesDisabled(NOTHING_HAPPENED);
        // Belt-and-braces: `buildAssistantTools` does not register this tool for
        // a caller without the permission, so the model should never see it.
        if (!requestManager.canRequest(ctx.user)) {
            return refuse(
                'not_permitted',
                `This user may not submit requests. ${NOTHING_HAPPENED}`,
            );
        }

        const resolved = await resolveTitleForWrite(ctx, args);
        if (resolved.kind === 'not_found') return refuseNotFound(args, NOTHING_HAPPENED);
        if (resolved.kind === 'ambiguous') {
            return refuseAmbiguous(resolved.candidates, NOTHING_HAPPENED);
        }

        const row = resolved.row;
        const mediaType = row.media_type;
        const target = {
            title: row.title,
            year: mediaYear(row),
            ref: mediaRef(row),
            mediaType: publicMediaType(row),
        };

        if (row.is_available) {
            return refuse(
                'already_available',
                `"${row.title}" is already in the library and can be watched now — no request needed. ${NOTHING_HAPPENED}`,
            );
        }
        if (!row.can_request) {
            return refuse(
                'not_requestable',
                `"${row.title}" cannot be requested on this server. ${NOTHING_HAPPENED}`,
            );
        }

        // Jellyseerr keys everything off TMDB. Roughly 4% of active rows carry no
        // TMDB primary id at all, so this is a real outcome, not a defensive branch.
        const externalIds = await readResolvableExternalIds(ctx, row.media_id);
        if (!externalIds) {
            return refuse(
                'no_tmdb_id',
                `"${row.title}" has no TMDB id on record, so it cannot be requested. ${NOTHING_HAPPENED}`,
            );
        }

        const tmdbId = Number(getExternalIdFor(externalIds, 'tmdb'));
        if (Number.isFinite(tmdbId) && tmdbId > 0) {
            const existing = await requestManager.findExistingRequest(
                ctx.user.username,
                tmdbId,
                mediaType,
            );
            if (existing) {
                return writeOk({
                    action: 'noop',
                    alreadyRequested: true,
                    status: existing.status,
                    ...target,
                    note: `"${row.title}" has already been requested (status: ${existing.status}). It was NOT requested again. It is still not watchable until the admin has added it.`,
                });
            }
        }

        if (!args.confirmed) {
            const quota = await requestManager.getRemainingQuota(ctx.user.username, mediaType);
            // P5 hard gate: record that THIS invocation is the one that showed
            // the title. A later confirmed:true call is only honoured when it
            // comes from a DIFFERENT invocation (confirm-gate.ts) — closing the
            // soft-gate hole where confirmed:false then confirmed:true could
            // both happen inside one dispatch-loop invocation.
            await markPendingConfirmation(ctx.userId, row.media_id, ctx.invocationId);
            return {
                summaryForModel: JSON.stringify({
                    ok: false,
                    reason: 'confirmation_required',
                    ...target,
                    quota,
                    note: `${NOTHING_HAPPENED} This is the title that WOULD be requested. Show it to the user — title and year — and ask them to confirm. Only if they say yes, call create_request again with confirmed: true. Do not confirm on their behalf.`,
                }),
            };
        }

        // P5 hard gate: confirmed:true is only honoured when a confirmed:false
        // call for this exact title was recorded by an EARLIER invocation (a
        // genuinely later user turn), never by this same one. Without this, a
        // model steered by an injected instruction (or simply choosing to)
        // could call confirmed:false then confirmed:true back to back and the
        // user would never see — let alone approve — the title before it
        // submitted. See confirm-gate.ts.
        if (!(await isConfirmedFromEarlierInvocation(ctx.userId, row.media_id, ctx.invocationId))) {
            return refuse(
                'confirmation_required',
                `${NOTHING_HAPPENED} "${row.title}" was not confirmed by the user in an earlier message. Show them the title and year, ask them to confirm, and only call create_request again with confirmed: true after they say yes in their NEXT message — not in this same turn.`,
            );
        }

        // Two identical calls in one round would otherwise both submit; the
        // rate limit (20/60 s) does not deduplicate.
        //
        // PEEK, do not consume. checkRateLimit increments, so consuming here
        // burned the token on every outcome — including the ones where nothing
        // was submitted. Jellyseerr unreachable meant the tool correctly said
        // "NOTHING was requested", and the user's immediate "try again" then hit
        // `duplicate_call`, whose note tells the model to say it is already on
        // its way. The model would truthfully relay a false statement — the one
        // payload in this batch whose prose asserts an action that did not
        // happen. The token is consumed below, only once something was.
        const dedupeKey = `assistant-create-request:${ctx.userId}:${row.media_id}`;
        const dedupe = await peekRateLimit(dedupeKey, 1, DUPLICATE_WINDOW_SECONDS);
        if (!dedupe.allowed) {
            return refuse(
                'duplicate_call',
                `A request for "${row.title}" was already submitted moments ago, so it was not submitted a second time. Tell the user it is already on its way — do not retry.`,
            );
        }

        const outcome = await requestManager.createRequest({
            user: ctx.user,
            effectiveUsername: ctx.user.username,
            // No client request here; a fixed scope keeps the caller bounded
            // per username without inventing an IP.
            rateLimitScope: 'assistant',
            externalIds,
            mediaType,
        });

        switch (outcome.kind) {
            case 'created':
                // Consume the dedupe token ONLY now that something was actually
                // submitted, so a failed attempt stays retryable.
                await checkRateLimit(dedupeKey, 1, DUPLICATE_WINDOW_SECONDS);
                return writeOk({
                    action: 'requested',
                    ...target,
                    requestId: outcome.requestId,
                    note: `Submitted. "${row.title}" is NOT available yet — the admin has to add it first. Say it was requested and the admin will handle it; never imply it can be watched now.`,
                });
            case 'not_permitted':
                return refuse(
                    'not_permitted',
                    `This user may not submit requests. ${NOTHING_HAPPENED}`,
                );
            case 'rate_limited':
                return refuse(
                    'rate_limited',
                    `Too many requests have been submitted in a short time. ${NOTHING_HAPPENED} Ask the user to try again in a minute.`,
                );
            case 'quota_exceeded':
                return {
                    summaryForModel: JSON.stringify({
                        ok: false,
                        reason: 'quota_exceeded',
                        bucket: outcome.bucket,
                        limit: outcome.limit,
                        used: outcome.used,
                        resetsInDays: outcome.days,
                        note: `The ${outcome.bucket} request quota is used up (${outcome.used} of ${outcome.limit}, resets in ${outcome.days} day(s)). ${NOTHING_HAPPENED}`,
                    }),
                };
            case 'dependency_unavailable':
                return refuse(
                    'unavailable',
                    `Request management is not reachable right now. ${NOTHING_HAPPENED}`,
                );
            case 'unresolvable':
                return refuse(
                    'no_tmdb_id',
                    `"${row.title}" could not be matched to a TMDB entry, so it cannot be requested. ${NOTHING_HAPPENED}`,
                );
            case 'create_failed':
                ctx.logger?.warn('create_request rejected by Jellyseerr', {
                    title: row.title,
                    error: outcome.error,
                });
                return refuseFailed(NOTHING_HAPPENED);
        }
    },
};

/**
 * External IDs for an already access-gated UUID, narrowed to the providers
 * `resolveToTmdb` understands.
 *
 * Read from the row rather than taken from `primary_ext_id`: the primary
 * provider is configurable and is not necessarily TMDB, and it is emphatically
 * not the model's to supply. Returns null when nothing resolvable is on file.
 */
async function readResolvableExternalIds(
    ctx: AssistantToolContext,
    mediaId: string,
): Promise<ExternalIds | null> {
    const rows = await getExternalIdsByMediaId(ctx.sql, mediaId);
    const ids: ExternalIds = {};
    for (const provider of RESOLVABLE_PROVIDERS) {
        const match = rows.find((r) => r.provider === provider);
        if (match?.external_id) ids[provider] = match.external_id;
    }
    return Object.keys(ids).length > 0 ? ids : null;
}
