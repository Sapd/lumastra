// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /oauth/device - Request a device authorization code
// This is a public endpoint (no authentication required)
// Rate limited to prevent abuse

import { pendingIpKey } from './pending-ip-key';
import { readBoundedBodyText, BODY_TOO_LARGE } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeviceCodeService, isDeviceAuthEnabled } from '$lib/server/oauth';
import { Logger } from '$lib/server/utils/logger';
import { deviceCodeRequestSchema } from '$lib/schemas/oauth.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip';
import { getTcpPeer } from '$lib/server/utils/tcp-peer';
import { verifyAccessToken } from '$lib/server/oauth/jwt.js';
import { config } from '$lib/server/config';
import { requestScheme } from '$lib/server/auth/cookie-transport.js';

const logger = Logger.for('OAuth:DeviceEndpoint');

// Per-IP rate limiting: 10 requests per minute (distributed via Valkey)
const IP_RATE_LIMIT_MAX_REQUESTS = 10;
const IP_RATE_LIMIT_WINDOW_SECONDS = 60;

// Maximum pending device codes per client_id before rejecting new requests.
// Prevents a single client from flooding the pending-codes table.
const MAX_PENDING_PER_CLIENT = 300;
const MAX_PENDING_PER_IP_CLIENT = 12;

// RFC 6749 §5.1 / §5.2: token/auth responses MUST carry Cache-Control: no-store
const NO_STORE = { 'Cache-Control': 'no-store' };

// ============================================================================
// Body parsing — RFC 8628 §3.1 requires form-urlencoded; accept both
// ============================================================================

/**
 * A device-authorization request body is a handful of short opaque strings —
 * never legitimately large. Matches mount.ts's DEFAULT_MAX_BODY_BYTES so this
 * unauthenticated, bypass-auth surface (C15) is bounded the same as every def
 * on the v1 surface.
 */
const MAX_OAUTH_BODY_BYTES = 256 * 1024;

/** Thrown by parseOAuthBody() when the body exceeds MAX_OAUTH_BODY_BYTES. */
class OAuthBodyTooLargeError extends Error {}

/**
 * Parse the request body as either application/x-www-form-urlencoded or
 * application/json. Returns a plain object or throws on malformed input.
 *
 * SIZE CAP (C15): a declared `Content-Length` over the cap is rejected before
 * any read; an honest-but-lying (or chunked, no Content-Length) body is caught
 * after buffering by checking the actual decoded length before parsing.
 */
async function parseOAuthBody(request: Request): Promise<unknown> {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_OAUTH_BODY_BYTES) {
        throw new OAuthBodyTooLargeError();
    }

    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await readBoundedBodyText(request, MAX_OAUTH_BODY_BYTES);
        if (text === BODY_TOO_LARGE) throw new OAuthBodyTooLargeError();
        const params = new URLSearchParams(text);
        const obj: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
            obj[key] = value;
        }
        return obj;
    }

    const text = await readBoundedBodyText(request, MAX_OAUTH_BODY_BYTES);
    if (text === BODY_TOO_LARGE) throw new OAuthBodyTooLargeError();
    return JSON.parse(text);
}

// ============================================================================
// Endpoint Handlers
// ============================================================================

/**
 * HEAD /oauth/device - Check if device authorization is available
 * Used by clients to verify the endpoint exists and is enabled before starting the flow
 */
export const HEAD: RequestHandler = async () => {
    if (!isDeviceAuthEnabled()) {
        return new Response(null, { status: 400 });
    }
    return new Response(null, { status: 200 });
};

export const POST: RequestHandler = async (event) => {
    const { request, url } = event;
    // Check if device auth is enabled.
    // RFC 8628: use invalid_request (not unsupported_grant_type — that is for /token)
    if (!isDeviceAuthEnabled()) {
        return json(
            {
                error: 'invalid_request',
                error_description: 'Device authorization is not enabled',
            },
            { status: 400, headers: NO_STORE },
        );
    }

    // Get client IP for rate limiting
    const clientIp = getClientIpStrictFromRequest(request, () => getTcpPeer(event));

    // Distributed rate limit via Valkey (with in-memory fallback)
    const rateResult = await checkRateLimit(
        `oauth:device:${clientIp}`,
        IP_RATE_LIMIT_MAX_REQUESTS,
        IP_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rateResult.allowed) {
        logger.warn('IP rate limit exceeded', { ip: clientIp });
        return json(
            {
                error: 'slow_down',
                error_description: 'Too many requests. Please wait before trying again.',
            },
            { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } },
        );
    }

    try {
        const body: unknown = await parseOAuthBody(request);
        const result = deviceCodeRequestSchema.safeParse(body);

        if (!result.success) {
            return json(
                {
                    error: 'invalid_request',
                    error_description: 'Invalid request parameters',
                },
                { status: 400, headers: NO_STORE },
            );
        }

        const { client_id, scope, device_name, device_id } = result.data;

        const deviceCodeService = getDeviceCodeService();

        // Bound one caller's share before spending the public client-id budget.
        const pendingBudget = await checkRateLimit(
            `oauth:device:pending:${pendingIpKey(clientIp)}:${client_id}`,
            MAX_PENDING_PER_IP_CLIENT,
            config.DEVICE_CODE_TTL_SECONDS,
        );
        if (!pendingBudget.allowed) {
            return json(
                {
                    error: 'slow_down',
                    error_description: 'Too many pending authorizations. Please wait.',
                },
                {
                    status: 429,
                    headers: {
                        ...NO_STORE,
                        'Retry-After': String(
                            Math.max(1, pendingBudget.resetAt - Math.floor(Date.now() / 1000)),
                        ),
                    },
                },
            );
        }

        // Cap pending codes per client_id to prevent flooding the table.
        const pendingCount = await deviceCodeService.countPendingForClient(client_id);
        if (pendingCount >= MAX_PENDING_PER_CLIENT) {
            logger.warn('Too many pending device codes for client', {
                clientId: client_id,
                pendingCount,
            });
            return json(
                {
                    error: 'slow_down',
                    error_description:
                        'Too many pending authorizations for this client. Wait for existing codes to expire or be used.',
                },
                { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } },
            );
        }

        // Prefer an explicit public base (including any proxy path), then the
        // adapter's canonical ORIGIN. For an inferred origin use the same
        // trusted forwarded-protocol handling as the app's session cookies.
        const canonicalBase = config.DEVICE_VERIFICATION_BASE_URL.trim();
        const origin = (process.env.ORIGIN ?? '').trim();
        const requestBase = origin
            ? new URL(origin).origin
            : `${requestScheme(event) ?? url.protocol.slice(0, -1)}://${url.host}`;
        let baseUrl = requestBase;
        if (canonicalBase) {
            try {
                const parsed = new URL(canonicalBase);
                if (!/^https?:$/.test(parsed.protocol) || !/^https?:\/\//.test(canonicalBase)) {
                    throw new Error('Expected an absolute HTTP(S) URL');
                }
                baseUrl = parsed.href.replace(/\/+$/, '');
            } catch {
                // Do not log the configured value: URLs can contain credentials.
                logger.warn(
                    'Invalid DEVICE_VERIFICATION_BASE_URL; falling back to the trusted request origin',
                    {
                        reason: 'Expected a valid absolute HTTP(S) URL',
                    },
                );
            }
        }

        // The public request may carry a signed bearer. Retain its session for
        // self-approval refusal; this grants no authority to create/approve codes.
        const bearer = /^bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
        const creator = bearer && bearer.length <= 1000 ? await verifyAccessToken(bearer) : null;
        // Create device code - pass device_id if provided for session reuse
        const response = await deviceCodeService.createDeviceCode(
            {
                clientId: client_id,
                scope,
                deviceName: device_name,
                deviceId: device_id,
                createdByDeviceSessionId:
                    creator?.deviceSessionId &&
                    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(creator.deviceSessionId)
                        ? creator.deviceSessionId
                        : undefined,
            },
            baseUrl,
        );

        logger.info('Device code issued', {
            clientId: client_id,
            deviceName: device_name,
            hasDeviceId: !!device_id,
        });

        // Return response per RFC 8628
        return json(response, { status: 200, headers: NO_STORE });
    } catch (error) {
        if (error instanceof OAuthBodyTooLargeError) {
            return json(
                {
                    error: 'invalid_request',
                    error_description: 'Request body is too large',
                },
                { status: 413, headers: NO_STORE },
            );
        }
        logger.error('Failed to create device code', error instanceof Error ? error : undefined);
        return json(
            {
                error: 'server_error',
                error_description: 'Failed to create device code',
            },
            { status: 500, headers: NO_STORE },
        );
    }
};
