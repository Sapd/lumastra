// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * service-tokens/{id} — per-service-token management.
 *
 * GET    /service-tokens/{id}   read one service token   (admin grant)
 * DELETE /service-tokens/{id}   revoke a service token   (admin grant)
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { features } from '$lib/server/config.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { ServiceTokenSchema } from '$lib/schemas/credentials.js';

const ServiceTokenDetailSchema = ServiceTokenSchema;

const ServiceTokenIdParams = z.object({ id: z.coerce.number().int().positive() });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Service Tokens'],
            summary: 'Get a service token',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns details for a single service token by its numeric ID. ' +
                'Requires the admin grant. Feature-gated: `FEATURE_DEVICE_AUTH` must be enabled.',
            responses: {
                200: {
                    schema: ServiceTokenDetailSchema,
                    description: 'Service token details',
                },
                422: 'Invalid token ID',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Service token not found or feature not enabled',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Service Tokens'],
            summary: 'Revoke a service token',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Revokes (deletes) a service token by its numeric ID. ' +
                'Requires the admin grant. Feature-gated: `FEATURE_DEVICE_AUTH` must be enabled.',
            responses: {
                204: 'Service token revoked',
                422: 'Invalid token ID',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Service token not found or feature not enabled',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_DEVICE_AUTH',
        then: { kind: 'scope', anyOf: ['tokens:admin'] },
    },
    request: {
        params: ServiceTokenIdParams,
    },
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.deviceAuth)
                return ApiProblem.notFound('Service tokens feature is not enabled');

            const rawId = event.params.id ?? '';
            // Strict: parseInt would read `12abc` as 12 and act on another token.
            const id = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : NaN;
            if (!Number.isSafeInteger(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Token ID must be a positive integer' },
                ]);
            }

            const svc = getServiceTokenService();
            const token = await svc.getById(id);
            if (!token) return ApiProblem.notFound('Service token not found');

            return json({
                ...token,
                createdAt: token.createdAt.toISOString(),
                expiresAt: token.expiresAt?.toISOString() ?? null,
                lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
            });
        },

        DELETE: async (event, _ctx) => {
            if (!features.deviceAuth)
                return ApiProblem.notFound('Service tokens feature is not enabled');

            const rawId = event.params.id ?? '';
            // Strict: parseInt would read `12abc` as 12 and act on another token.
            const id = /^[1-9][0-9]{0,15}$/.test(rawId) ? Number(rawId) : NaN;
            if (!Number.isSafeInteger(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Token ID must be a positive integer' },
                ]);
            }

            const svc = getServiceTokenService();
            const revoked = await svc.revoke(id);
            if (!revoked) return ApiProblem.notFound('Service token not found');
            auditLog('service_token.revoke', String(id), auditActor(event));

            return new Response(null, { status: 204 });
        },
    },
});
