// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { isDelegatedAdmin } from '$lib/server/api/delegate.js';
import { isAdminClassScope } from '$lib/server/api/principal.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getDeviceApprover } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { getDeviceCodeService, normalizeUserCode } from '$lib/server/oauth/device-code.service.js';
import { isDeviceAuthEnabled } from '$lib/server/oauth/jwt.js';
import { getJellyfinPermissionsService } from '$lib/server/oauth/jellyfin-permissions.service.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkDeviceApprovalRateLimit } from '$lib/server/oauth/device-approval-rate-limit.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { features } from '$lib/server/config.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import {
    deviceApprovalQuerySchema,
    deviceApprovalBodySchema,
    deviceApprovalInfoSchema,
    deviceApprovalResultSchema,
} from '$lib/schemas/oauth.js';

const description =
    'Requires a full user OAuth access bearer token (write authority). PATs, service tokens, ' +
    'read-only device tokens, stream tokens, cookie/proxy identities and delegated requests are refused. ' +
    'A live independent device session is required; bearer-approved sessions cannot approve further devices. ' +
    'The new session is revoked with its approver; self-approval by session, device or client is refused. ' +
    'Client IDs and device names are self-reported recognition aids, never proof of client identity. ' +
    'Lookup and decisions share limits of 10 requests per user and 10 per user/normalized-code pair per minute. ' +
    'Unknown, expired and already decided/consumed codes all return 404. Responses are not cached.';

/** Narrower than a user/scope gate: approving a sign-in hands out a new credential. */
async function gate(event: RequestEvent): Promise<Response | null> {
    if (!isDeviceAuthEnabled()) return ApiProblem.notFound();
    const p = event.locals.principal;
    if (!p) return ApiProblem.unauthorized();
    if (
        p.kind !== 'bearer' ||
        !p.credentialId ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(p.credentialId) ||
        !p.scopes.includes('write') ||
        p.isAdmin ||
        p.scopes.some(isAdminClassScope) ||
        isDelegatedAdmin(event) ||
        !/^bearer\s+\S+\s*$/i.test(event.request.headers.get('authorization') ?? '')
    ) {
        return ApiProblem.forbidden('A full user OAuth access token is required');
    }
    const sql = getDb();
    if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
    // Fresh kill-switch check: cached authentication must not authorize a new grant
    // for an account disabled/deleted since its last media request.
    try {
        const user = await getUserById(sql, p.userId);
        if (!user || user.disabled_at || user.deleted_at) return ApiProblem.unauthorized();
        if (!(await getDeviceApprover(sql, p.userId, p.credentialId!)))
            return ApiProblem.forbidden('An independently signed-in device session is required');
    } catch {
        return ApiProblem.dependencyUnavailable('Account check unavailable');
    }
    return null;
}

/** Client IDs are only a conservative refusal signal, never a client allowlist. */
async function isSelfApproval(
    event: RequestEvent,
    target: {
        client_id: string;
        device_session_id: string;
        created_by_device_session_id: string | null;
        device_id: string | null;
    },
): Promise<boolean> {
    const p = event.locals.principal!;
    const approver = await getDeviceApprover(getDb()!, p.userId, p.credentialId!);
    return (
        !approver ||
        target.device_session_id === p.credentialId ||
        target.created_by_device_session_id === p.credentialId ||
        target.client_id === approver.client_id ||
        target.client_id === p.clientId ||
        Boolean(target.device_id && target.device_id === approver.device_id)
    );
}

export const def = defineEndpoint({
    // Full device grants expand to media:write; the handler additionally enforces
    // the credential kind and coarse write authority, including on GET.
    auth: { kind: 'scope', anyOf: ['media:write'] },
    request: {
        query: deviceApprovalQuerySchema,
        queryMethods: ['GET', 'HEAD'],
        body: deviceApprovalBodySchema,
        bodyMethods: ['POST'],
        maxBodyBytes: 1024,
    },
    docs: {
        GET: {
            tags: ['Authentication'],
            summary: 'Look up a pending device sign-in',
            stability: 'stable',
            auth: 'bearer',
            description,
            responses: {
                200: {
                    schema: deviceApprovalInfoSchema,
                    description: 'Pending device display information only',
                },
                401: 'Authentication required or account disabled',
                403: 'Credential cannot approve devices',
                404: 'Code unavailable or feature disabled',
                422: 'Invalid user code',
                429: 'Too many lookups or decisions',
                503: 'Database unavailable',
            },
        },
        POST: {
            tags: ['Authentication'],
            summary: 'Approve or deny a device sign-in',
            stability: 'stable',
            auth: 'bearer',
            description:
                description +
                ' The approving token user becomes the grant owner. Current account age and library restrictions ' +
                'apply through the ordinary device-token exchange and authorization path. Requires explicit user confirmation.',
            responses: {
                200: { schema: deviceApprovalResultSchema, description: 'Decision recorded' },
                401: 'Authentication required or account disabled',
                403: 'Credential cannot approve devices',
                404: 'Code unavailable or feature disabled',
                413: 'Body too large',
                422: 'Invalid body',
                429: 'Too many lookups or decisions',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const denied = await gate(event);
            if (denied) return denied;
            const code = normalizeUserCode(ctx.input!.query.user_code);
            const limited = await checkDeviceApprovalRateLimit(
                event.locals.principal!.userId,
                code,
                getClientIpStrict(event),
            );
            if (limited) return limited;
            const record = await getDeviceCodeService().getByUserCode(code);
            if (!record || record.status !== 'pending' || record.expires_at <= new Date()) {
                return ApiProblem.notFound('Invalid or expired device code');
            }
            if (await isSelfApproval(event, record))
                return ApiProblem.forbidden('A device cannot approve itself');
            const name = record.device_name?.trim();
            return typedJson(
                deviceApprovalInfoSchema,
                {
                    clientId: record.client_id.slice(0, 128),
                    ...(name
                        ? { deviceName: name.length > 64 ? `${name.slice(0, 64)}…` : name }
                        : {}),
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },
        POST: async (event, ctx) => {
            const denied = await gate(event);
            if (denied) return denied;
            const p = event.locals.principal!;
            const { user_code, approve } = ctx.input!.body;
            const code = normalizeUserCode(user_code);
            const limited = await checkDeviceApprovalRateLimit(
                p.userId,
                code,
                getClientIpStrict(event),
            );
            if (limited) return limited;
            const service = getDeviceCodeService();
            const record = await service.getByUserCode(code);
            if (!record || record.status !== 'pending' || record.expires_at <= new Date()) {
                return ApiProblem.notFound('Invalid or expired device code');
            }
            if (await isSelfApproval(event, record))
                return ApiProblem.forbidden('A device cannot approve itself');
            // Same optional provider permission refresh as browser approval. Never
            // write merged token groups to users.groups: the stored IdP projection
            // and in-app membership remain authoritative.
            if (approve && operationMode.isJellyfinEnabled && features.jellyfinSync) {
                await getJellyfinPermissionsService().fetchAndCachePermissions(p.username);
            }
            const changed = approve
                ? await service.authorize(code, p.userId, p.credentialId)
                : await service.deny(code, p.userId);
            if (!changed) return ApiProblem.notFound('Invalid or expired device code');
            auditLog(
                approve ? 'oauth.device.approve' : 'oauth.device.deny',
                record.device_session_id,
                auditActor(event),
                {
                    approverUserId: p.userId,
                    clientId: record.client_id.slice(0, 128),
                    deviceName: record.device_name?.slice(0, 64) ?? null,
                    approvingClientId: p.clientId?.slice(0, 128),
                },
            );
            return typedJson(
                deviceApprovalResultSchema,
                { approved: approve },
                {
                    headers: { 'Cache-Control': 'no-store' },
                },
            );
        },
    },
});
