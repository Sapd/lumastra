// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * service-tokens/ — service-token management collection.
 *
 * GET    /service-tokens           list all service tokens (admin grant)
 * POST   /service-tokens           create a new service token (admin grant)
 *
 * Feature-gated: requires FEATURE_DEVICE_AUTH (same gate as the existing endpoint).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import {
    getServiceTokenService,
    MintingTokenRevokedError,
} from '$lib/server/oauth/service-token.service.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import { features } from '$lib/server/config.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { denyUnlessMayMint, MAX_TOKEN_LIFETIME_DAYS } from '$lib/server/api/token-minting.js';
import { principalBeforeDelegation } from '$lib/server/api/delegate.js';
import { mintEnvelopeViolation } from '$lib/server/api/service-token-mint-envelope.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    INTEGRATIONS_GRANT,
    INTEGRATIONS_GRANT_PATHS,
    isIntegrationsGrantPath,
} from '$lib/server/auth/integration-token.js';
import {
    DEBUG_REPORT_PATH,
    DIAGNOSTICS_GRANT,
    DIAGNOSTICS_GRANT_MAX_DAYS,
} from '$lib/server/auth/diagnostics-grant.js';
import {
    serviceTokenScopeSchema,
    serviceTokenPathPrefixSchema,
    serviceTokenMethodSchema,
} from '$lib/schemas/admin.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { ServiceTokenSchema } from '$lib/schemas/credentials.js';

/**
 * Declared shape of one listed service token.
 *
 * This DECLARATION was wrong, not the handler: prod logged
 * "RESPONSE CONFORMANCE — body failed its declared schema" on every GET, and
 * `mount()` passed the body through unstripped, so clients were fine while the
 * server told itself it was broken on each request.
 *
 * Five fields disagreed with what `ServiceTokenService.listAll()` returns:
 * `id` is the `service_tokens` serial (a NUMBER, declared string), and
 * `description` / `allowedIps` / `allowedPathPrefixes` / `allowedMethods`
 * come back as NULL from their nullable columns — `.optional()` accepts
 * `undefined`, never `null`.
 *
 * The client-side twin (`ServiceTokenInfoSchema` in schemas/api-admin-
 * responses.ts) has had `z.number()` and `.nullish()` on exactly these fields
 * all along, which is how the UI kept working. Matching it here changes no
 * bytes on the wire; it only stops the server failing its own contract.
 *
 * `.nullish()` rather than `.optional()` is correct under the repo's
 * nullability rule: these columns genuinely return null.
 */
const ServiceTokenItemSchema = ServiceTokenSchema;

const ServiceTokensListResponseSchema = z.object({
    items: z.array(ServiceTokenItemSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
    }),
});

/**
 * `scopes` is REQUIRED and drawn from the service-token enum. It used to be an
 * optional free-form string array whose absence the service turned into
 * `['admin']` — omitting the field minted a full-admin token (security review
 * 2026-09-12, C3).
 */
const ServiceTokenScopesSchema = z.array(serviceTokenScopeSchema).min(1).meta({
    description:
        'Token grants — required; read, write, admin, integrations:read or diagnostics:read. integrations:read and diagnostics:read must each be the only grant.',
});

/**
 * Source-IP allowlist: exact IPv4/IPv6 literals (the matcher compares
 * literally, no CIDR). Anything else would never match, so the token would
 * silently never work.
 */
const AllowedIpsSchema = z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(32, 'At most 32 IP addresses allowed')
    .optional()
    .meta({
        description:
            'Source IPs allowed to use the token: exact IPv4 or IPv6 addresses, no CIDR ranges. Max 32 entries. Empty = any source IP.',
    });

/**
 * Mint-time rules of the `integrations:read` grant (API package 15): it is the
 * token's only grant, it acts as nobody (`actAsUserId`) and cannot be
 * sandboxed (`forceNonAdmin`, it confers no admin to strip), stored path
 * prefixes may only name its three endpoints, and stored methods may only be
 * GET/HEAD (the endpoints are read-only).
 */
function integrationsGrantViolations(data: {
    scopes: readonly string[];
    actAsUserId?: string;
    forceNonAdmin?: boolean;
    allowedPathPrefixes?: readonly string[];
    allowedMethods?: readonly string[];
}): Array<{ field: string; message: string }> {
    if (!data.scopes.includes(INTEGRATIONS_GRANT)) return [];
    const errors: Array<{ field: string; message: string }> = [];
    if (data.scopes.some((s) => s !== INTEGRATIONS_GRANT)) {
        errors.push({
            field: 'scopes',
            message: `${INTEGRATIONS_GRANT} must be the token's only grant`,
        });
    }
    if (data.actAsUserId) {
        errors.push({
            field: 'actAsUserId',
            message: `${INTEGRATIONS_GRANT} tokens cannot act as a user`,
        });
    }
    if (data.forceNonAdmin === true) {
        errors.push({
            field: 'forceNonAdmin',
            message: `${INTEGRATIONS_GRANT} tokens cannot set forceNonAdmin`,
        });
    }
    const outside = (data.allowedPathPrefixes ?? []).filter((p) => !isIntegrationsGrantPath(p));
    if (outside.length > 0) {
        errors.push({
            field: 'allowedPathPrefixes',
            message: `${INTEGRATIONS_GRANT} path prefixes must each be one of ${INTEGRATIONS_GRANT_PATHS.join(', ')} (${outside.join(', ')})`,
        });
    }
    const writes = (data.allowedMethods ?? []).filter(
        (m) => m.toUpperCase() !== 'GET' && m.toUpperCase() !== 'HEAD',
    );
    if (writes.length > 0) {
        errors.push({
            field: 'allowedMethods',
            message: `${INTEGRATIONS_GRANT} tokens allow only GET and HEAD (${writes.join(', ')})`,
        });
    }
    return errors;
}

/**
 * Mint-time rules of the `diagnostics:read` grant (debug report, spec
 * 2026-10-21 §6): the token's only grant, acting as nobody, not sandboxed,
 * an expiry that is REQUIRED and at most {@link DIAGNOSTICS_GRANT_MAX_DAYS}
 * days, stored path prefixes inside the report (`DEBUG_REPORT_PATH`), and
 * stored methods GET/HEAD only.
 */
function diagnosticsGrantViolations(data: {
    scopes: readonly string[];
    actAsUserId?: string;
    forceNonAdmin?: boolean;
    expiresInDays?: number | null;
    allowedPathPrefixes?: readonly string[];
    allowedMethods?: readonly string[];
}): Array<{ field: string; message: string }> {
    if (!data.scopes.includes(DIAGNOSTICS_GRANT)) return [];
    const errors: Array<{ field: string; message: string }> = [];
    if (data.scopes.some((s) => s !== DIAGNOSTICS_GRANT)) {
        errors.push({
            field: 'scopes',
            message: `${DIAGNOSTICS_GRANT} must be the token's only grant`,
        });
    }
    if (data.actAsUserId) {
        errors.push({
            field: 'actAsUserId',
            message: `${DIAGNOSTICS_GRANT} tokens cannot act as a user`,
        });
    }
    if (data.forceNonAdmin === true) {
        errors.push({
            field: 'forceNonAdmin',
            message: `${DIAGNOSTICS_GRANT} tokens cannot set forceNonAdmin`,
        });
    }
    if (data.expiresInDays == null) {
        errors.push({
            field: 'expiresInDays',
            message: `${DIAGNOSTICS_GRANT} tokens must expire: set expiresInDays (1 to ${DIAGNOSTICS_GRANT_MAX_DAYS})`,
        });
    } else if (data.expiresInDays > DIAGNOSTICS_GRANT_MAX_DAYS) {
        errors.push({
            field: 'expiresInDays',
            message: `${DIAGNOSTICS_GRANT} tokens expire within ${DIAGNOSTICS_GRANT_MAX_DAYS} days`,
        });
    }
    const outside = (data.allowedPathPrefixes ?? []).filter((p) => {
        if (p.includes('..') || p.includes('%') || p.includes('//') || p.split('/').includes('.')) {
            return true;
        }
        if (p === DEBUG_REPORT_PATH) return false;
        if (!p.startsWith(`${DEBUG_REPORT_PATH}/`)) return true;
        const child = p.slice(DEBUG_REPORT_PATH.length + 1).split('/')[0];
        return !['health', 'runs', 'client-diagnostics', 'cluster'].includes(child ?? '');
    });
    if (outside.length > 0) {
        errors.push({
            field: 'allowedPathPrefixes',
            message: `${DIAGNOSTICS_GRANT} path prefixes must be ${DEBUG_REPORT_PATH} or below it (${outside.join(', ')})`,
        });
    }
    const writes = (data.allowedMethods ?? []).filter(
        (m) => m.toUpperCase() !== 'GET' && m.toUpperCase() !== 'HEAD',
    );
    if (writes.length > 0) {
        errors.push({
            field: 'allowedMethods',
            message: `${DIAGNOSTICS_GRANT} tokens allow only GET and HEAD (${writes.join(', ')})`,
        });
    }
    return errors;
}

/**
 * Per-token route/method envelope (fix-plan-5 Task 4, security review 5 §9
 * hardening item 3): `''`, `..` and any prefix not starting with `/api/v1/`
 * (including a well-formed `/api/admin/...` prefix) are rejected at mint
 * time — see `serviceTokenPathPrefixSchema`'s doc in `schemas/admin.ts` for
 * the full rationale. Shared between the docs-only body (below) and the
 * runtime-validated `CreateTokenBody` so the published OpenAPI contract
 * matches what `mount()` actually enforces.
 */
const AllowedPathPrefixesSchema = z
    .array(serviceTokenPathPrefixSchema)
    .max(32, 'At most 32 path prefixes allowed')
    .optional()
    .meta({
        description:
            'Path prefixes the token can access, e.g. ["/api/v1/health"]. Each must start with /api/v1/. Max 32 entries. Empty = every /api/v1 endpoint the token’s scopes allow.',
    });

/**
 * Normalizes each entry to uppercase BEFORE validating against the enum
 * (fix-plan-5 Task 4 review, fix round 1, Minor d): the envelope is enforced
 * case-insensitively at request time (`token-identity.ts`'s
 * `tokenEnvelopeDenial()` uppercases both the request method and every
 * stored entry before comparing), so mint-time validation must not 422 a
 * lowercase `['get']` a client submits — that would reject input the
 * envelope treats as perfectly valid the moment the token is actually used.
 */
const AllowedMethodsSchema = z
    .array(
        z
            .string()
            .transform((s) => s.toUpperCase())
            .pipe(serviceTokenMethodSchema),
    )
    .optional()
    .meta({ description: 'HTTP methods this token can use. Empty = all.' });

/**
 * Docs-only twin of `AllowedMethodsSchema` (fix-plan-5 Task 9, carried item C5):
 * `openapi:generate` renders a `.transform().pipe(enum)` item as a bare
 * `type: string` with no `enum`, because the transform's output type is what
 * the generator sees, not the enum it pipes through — that dropped the
 * documented GET/HEAD/POST/PUT/PATCH/DELETE values from the published spec
 * even though `mount()` still enforces exactly that set (case-insensitively).
 * This copy skips the transform so the docs-only body keeps the enum; the
 * runtime-validated `CreateTokenBody` below still uses the transforming
 * version so a lowercase `['get']` isn't rejected at mint time.
 */
const AllowedMethodsDocsSchema = z
    .array(serviceTokenMethodSchema)
    .optional()
    .meta({ description: 'HTTP methods this token can use. Empty = all.' });

const CreateServiceTokenBodySchema = z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    actAsUserId: z.string().uuid().optional().meta({ description: 'Impersonated user UUID' }),
    scopes: ServiceTokenScopesSchema,
    allowedIps: AllowedIpsSchema,
    allowedPathPrefixes: AllowedPathPrefixesSchema,
    allowedMethods: AllowedMethodsDocsSchema,
    forceNonAdmin: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).nullable().optional(),
});

// `id` is the `service_tokens` serial and has always gone out as a NUMBER;
// declaring it a string made every 201 fail its own contract (same defect the
// list schema above had).
const CreateServiceTokenResponseSchema = z.object({
    id: z.number().int(),
    token: z.string().meta({ description: 'Token value — shown once, store immediately' }),
});

const CreateTokenBody = z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    actAsUserId: z.string().uuid().optional(),
    scopes: ServiceTokenScopesSchema,
    allowedIps: AllowedIpsSchema,
    allowedPathPrefixes: AllowedPathPrefixesSchema,
    allowedMethods: AllowedMethodsSchema,
    forceNonAdmin: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).nullable().optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Service Tokens'],
            summary: 'List service tokens',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Lists all service tokens (`svc_` prefix). Requires the admin grant. ' +
                'Feature-gated: `FEATURE_DEVICE_AUTH` must be enabled.',
            responses: {
                200: {
                    schema: ServiceTokensListResponseSchema,
                    description: 'Service token list',
                },
                401: 'Authentication required',
                403: 'Insufficient grant (requires admin)',
                404: 'Feature not enabled',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Service Tokens'],
            summary: 'Create a service token',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Creates a new service token (`svc_` prefix) with optional path/method/IP restrictions. ' +
                'Requires the admin grant. The token value is returned once — copy it immediately. ' +
                'Grants: `read`, `write`, `admin`, `integrations:read` — the integration credential for ' +
                '`GET /api/v1/integrations/watch-history`, `/upcoming` and `/homepage` — or `diagnostics:read`, ' +
                'the read-only debug-report credential for `GET /api/v1/admin/debug-report` and its drill-downs. ' +
                '`integrations:read` and `diagnostics:read` must each be the only grant, only an administrator ' +
                'may mint them, and they reject `actAsUserId` and `forceNonAdmin: true`. `integrations:read` ' +
                'takes `allowedPathPrefixes` only from its three paths and `allowedMethods` only GET/HEAD; it ' +
                'works only on those three endpoints and only while its owner is an administrator. ' +
                '`diagnostics:read` requires `expiresInDays` (1 to 90), takes `allowedPathPrefixes` only at or ' +
                'below `/api/v1/admin/debug-report`, and `allowedMethods` only GET/HEAD; it works only on the ' +
                'debug report and its drill-downs, and only while its owner is an administrator. ' +
                '`allowedIps` entries are exact IPv4/IPv6 addresses (no CIDR). ' +
                'When the caller is itself a service token, it needs the `admin` grant, the new token is ' +
                'owned by the calling token’s owner (`owner`, with `createdVia` set), and it ' +
                'may not exceed the calling token: same or fewer grants, path prefixes, methods and IPs, ' +
                '`forceNonAdmin` carried down, no later expiry, and the same `actAsUserId` when the caller ' +
                'impersonates one. ' +
                'Feature-gated: `FEATURE_DEVICE_AUTH` must be enabled.',
            body: CreateServiceTokenBodySchema,
            responses: {
                201: {
                    schema: CreateServiceTokenResponseSchema,
                    description: 'Service token created — token shown once',
                },
                422: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient grant',
                404: 'Feature not enabled',
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
        body: CreateTokenBody,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            if (!features.deviceAuth) {
                return ApiProblem.notFound('Service tokens feature is not enabled');
            }
            const svc = getServiceTokenService();
            const tokens = await svc.listAll();
            const items = tokens.map((t) => ({
                ...t,
                createdAt: t.createdAt.toISOString(),
                expiresAt: t.expiresAt?.toISOString() ?? null,
                lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
            }));
            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },

        POST: async (event, ctx) => {
            if (!features.deviceAuth) {
                return ApiProblem.notFound('Service tokens feature is not enabled');
            }

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const data = ctx.input!.body;
            const actor = event.locals.principal?.username ?? event.locals.user?.username ?? 'api';
            if (data.expiresInDays != null && data.expiresInDays > MAX_TOKEN_LIFETIME_DAYS) {
                return ApiProblem.validationFailed([
                    {
                        field: 'expiresInDays',
                        message: `Must be at most ${MAX_TOKEN_LIFETIME_DAYS} days`,
                    },
                ]);
            }
            const grantErrors = [
                ...integrationsGrantViolations(data),
                ...diagnosticsGrantViolations(data),
            ];
            if (grantErrors.length > 0) return ApiProblem.validationFailed(grantErrors);

            // The public target is a UUID; the database FK and mint ceiling use that same identity.
            let actAsUserId: ReturnType<typeof toUserId> | undefined;
            let targetIsAdmin = false;
            if (data.actAsUserId) {
                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
                // The lookup
                // does not filter soft-deleted or disabled rows, so refuse those
                // here: a token must not act as an account that cannot sign in.
                const target = await getUserById(sql, data.actAsUserId);
                if (!target || target.deleted_at || target.disabled_at) {
                    return ApiProblem.validationFailed(
                        `actAsUserId "${data.actAsUserId}" not found`,
                    );
                }
                actAsUserId = toUserId(target.id);
                // FIX (security review 2026-09-23, C6, review §7 item 2):
                // `target.is_admin` is the RAW column, not a resolved
                // verdict — an unpinned target whose only admin grant is the
                // in-app `admin` capability has `is_admin:false` here, so a
                // raw read would let a tokens:admin caller mint a token
                // impersonating them despite them being admin on every other
                // surface. Use the same Formula-A resolver every other
                // Bearer-admin call site uses so the mint ceiling can't be
                // bypassed by an in-app-only admin target.
                targetIsAdmin =
                    (await resolveOwnerAdminStatus(sql, target.username))?.isAdmin === true;
            }

            // Authorization-of-authorization: a non-admin caller may not mint
            // admin scope, nor a token that impersonates an administrator, nor
            // scopes it does not hold itself (security review 2026-09-12, C3).
            const denied = await denyUnlessMayMint(event, { scopes: data.scopes, targetIsAdmin });
            if (denied) return denied;

            const svc = getServiceTokenService();

            // A service-token caller's username is `service:<name>`, which is
            // no user: stored as `created_by` it made the new token fail
            // validate()'s creator check on every request (prod 2026-10-02).
            // The new token belongs to the human behind the calling token, and
            // may not exceed that token.
            let createdBy = actor;
            let createdViaTokenId: number | undefined;
            let expiresAt: Date | null | undefined;
            const caller = principalBeforeDelegation(event) ?? event.locals.principal;
            const svcBearer = /^bearer[ \t]+svc_/i.test(
                event.request.headers.get('authorization') ?? '',
            );
            if (svcBearer && caller?.kind !== 'service_token') {
                // Fail closed: a svc_ caller must reach the envelope check.
                return ApiProblem.forbidden('The calling service token cannot mint tokens');
            }
            if (caller?.kind === 'service_token') {
                const minterId = Number(caller.credentialId);
                const minter = Number.isInteger(minterId)
                    ? await svc.getMinterEnvelope(minterId)
                    : null;
                if (!minter || !minter.ownerUserId || minter.createdBy.startsWith('service:')) {
                    return ApiProblem.forbidden('The calling service token cannot mint tokens');
                }
                expiresAt =
                    data.expiresInDays != null
                        ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
                        : null;
                const violation = mintEnvelopeViolation(minter, {
                    scopes: data.scopes,
                    actAsUserId,
                    allowedIps: data.allowedIps,
                    allowedPathPrefixes: data.allowedPathPrefixes,
                    allowedMethods: data.allowedMethods,
                    forceNonAdmin: data.forceNonAdmin,
                    expiresAt,
                });
                if (violation) return ApiProblem.forbidden(violation);
                createdBy = minter.createdBy;
                createdViaTokenId = minter.id;
            }

            // A minted token is owned by a user id (request time checks the
            // owner by id only); a token minted through another token inherits
            // that token's owner inside create().
            const ownerUserId = event.locals.principal?.userId ?? event.locals.user?.userId ?? null;
            if (createdViaTokenId === undefined && !ownerUserId) {
                return ApiProblem.forbidden('Cannot determine the token owner');
            }

            let result: Awaited<ReturnType<typeof svc.create>>;
            try {
                result = await svc.create({
                    name: data.name,
                    description: data.description,
                    createdBy,
                    ownerUserId,
                    createdViaTokenId,
                    scopes: data.scopes,
                    actAsUser: actAsUserId,
                    allowedIps: data.allowedIps,
                    allowedPathPrefixes: data.allowedPathPrefixes,
                    allowedMethods: data.allowedMethods,
                    forceNonAdmin: data.forceNonAdmin,
                    expiresInDays: data.expiresInDays ?? undefined,
                    // Set only on the service-token path: the instant checked above.
                    expiresAt,
                });
            } catch (err) {
                // The minting token was revoked while this request was in flight.
                if (err instanceof MintingTokenRevokedError) {
                    return ApiProblem.forbidden('The token used to mint was revoked');
                }
                throw err;
            }
            auditLog('service_token.create', String(result.id), auditActor(event), {
                name: data.name,
                createdBy,
                createdViaTokenId,
                scopes: data.scopes,
                actAsUser: actAsUserId ?? null,
                forceNonAdmin: data.forceNonAdmin ?? false,
            });

            return json(
                {
                    id: result.id,
                    // token shown once — client must store immediately
                    token: result.token,
                },
                { status: 201 },
            );
        },
    },
});
