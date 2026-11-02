// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/pats.ts — GET /me/pats + POST /me/pats
 *
 * Auth: {kind:'user'} — self-scoped.
 * Feature-gated on FEATURE_USER_PATS.
 * Errors: problem+json.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { createTokenSchema, listTokenQuerySchema } from '$lib/schemas/user.js';
import { UserTokenListResponseSchema } from '$lib/schemas/api-user-responses';
import { denyUnlessInteractiveSession, denyUnlessMayMint } from '$lib/server/api/token-minting.js';

const CreateTokenBodySchema = createTokenSchema;

const CreateTokenResponseSchema = z.object({
    id: z.number().int(),
    token: z
        .string()
        .meta({ description: 'PAT value with `pat_` prefix — shown once, store immediately' }),
    message: z.string(),
});

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/** Optional scope filter for the self-service PAT list. */
const TokensQuerySchema = z.object({
    /** GET: filter PATs by scope (optional; derived from listTokenQuerySchema). */
    scope: z.string().optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: 'List personal access tokens (PATs)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Lists all active Personal Access Tokens (`pat_` prefix) for the authenticated user. ' +
                "Tokens are scoped to the creator's user account. " +
                '?scope= filter is available. Feature-gated: `FEATURE_USER_PATS` must be enabled.',
            query: z.object({
                scope: z.string().optional().meta({ description: 'Filter by scope' }),
            }),
            responses: {
                200: {
                    schema: UserTokenListResponseSchema,
                    description: 'PAT list',
                },
                422: 'Invalid query parameter',
                401: 'Authentication required',
                404: 'Feature not enabled',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['User'],
            summary: 'Create a personal access token (PAT)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Creates a new Personal Access Token (`pat_` prefix). ' +
                'The token value is returned once — copy it immediately. ' +
                'Maximum 10 tokens per user. Only admin users can request admin scope. ' +
                'Feature-gated: `FEATURE_USER_PATS` must be enabled.',
            body: CreateTokenBodySchema,
            responses: {
                201: {
                    schema: CreateTokenResponseSchema,
                    description: 'PAT created — token shown once',
                },
                422: 'Validation error',
                401: 'Authentication required',
                403: 'Session required: API tokens and device tokens cannot create tokens (reason session_required); admin scope requires an admin user',
                404: 'Feature not enabled',
                409: 'Maximum token limit reached',
                500: 'Internal server error',
            },
        },
    },

    // Feature-gate: FEATURE_USER_PATS (maps to config.features.userPats).
    auth: {
        kind: 'feature',
        flag: 'FEATURE_USER_PATS',
        then: { kind: 'user' },
    },
    request: {
        query: TokensQuerySchema,
        queryMethods: ['GET'],
        body: createTokenSchema,
    },
    handlers: {
        /**
         * GET /me/pats?scope=
         *
         * List all active PATs for the authenticated user.
         */
        GET: async (event, _ctx) => {
            const queryRaw = {
                scope: event.url.searchParams.get('scope') ?? undefined,
            };
            const parsed = listTokenQuerySchema.safeParse(queryRaw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const patService = getPatService();
            const { scope } = parsed.data;
            const tokens = await patService.listForUser(
                userId,
                scope ? { scopes: [scope] } : undefined,
            );

            return json(
                paginate(tokens, {
                    limit: tokens.length,
                    offset: 0,
                    hasMore: false,
                    total: tokens.length,
                }),
            );
        },

        /**
         * POST /me/pats
         *
         * Create a new PAT.
         * The token value is returned once — it cannot be retrieved later.
         */
        POST: async (event, _ctx) => {
            // Minting needs an interactive session: a bearer that merely HOLDS
            // `write` must not create a PAT that outlives its own revocation.
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;

            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = createTokenSchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const user = event.locals.user;
            const userId = event.locals.principal?.userId ?? user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const { name, description, expiresInDays } = parsed.data;
            const scopes = parsed.data.scopes ?? ['read'];

            // SECURITY: a new token may not exceed the credential that mints it.
            // Judged on the PRINCIPAL by the shared minting ceiling, never on
            // `locals.user`: for a device JWT, `locals.user.isAdmin` is the
            // owner's live admin status while the token carries no admin scope,
            // so reading it let an admin's device token mint an admin PAT, and a
            // read-only device token mint a write one. Every resolveAuth branch
            // sets a principal; without one, refuse rather than let the ceiling
            // fall back to `locals.user`.
            if (!event.locals.principal) {
                return ApiProblem.unauthorized();
            }
            const mintDenied = await denyUnlessMayMint(event, { scopes, targetIsAdmin: false });
            if (mintDenied) return mintDenied;

            try {
                const patService = getPatService();
                const result = await patService.create({
                    userId,
                    name,
                    description,
                    scopes,
                    groups: user?.userGroups ?? [],
                    expiresInDays: expiresInDays ?? null,
                });

                return json(
                    {
                        id: result.id,
                        token: result.token,
                        message:
                            'Token created successfully. Copy it now — you will not be able to see it again!',
                    },
                    { status: 201 },
                );
            } catch (err) {
                if (err instanceof Error && err.message.includes('Maximum')) {
                    return ApiProblem.conflict(err.message);
                }
                return ApiProblem.internalError('Failed to create token');
            }
        },
    },
});
