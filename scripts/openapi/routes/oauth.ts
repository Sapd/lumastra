// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI route definitions for OAuth Device Authorization endpoints.
 *
 * Implements RFC 8628 (OAuth 2.0 Device Authorization Grant).
 * These endpoints do NOT require authentication and use RFC 8628
 * error format ({ error, error_description }) instead of the
 * standard ApiResponse wrapper.
 */

import { z } from 'zod';
import { NO_AUTH, type PathsObject } from '../helpers';
import {
    deviceCodeRequestSchema,
    tokenDeviceCodeGrantSchema,
    tokenRefreshGrantSchema,
} from '../../../src/lib/schemas/oauth';

const tokenRequestBodySchema = z.union([tokenDeviceCodeGrantSchema, tokenRefreshGrantSchema]);

// ============================================================================
// Response Schemas
// ============================================================================

const deviceAuthorizationResponse = z.object({
    device_code: z.string().meta({ description: 'Device verification code' }),
    user_code: z.string().meta({
        description: 'User-facing code to enter on the verification page',
    }),
    verification_uri: z
        .string()
        .meta({ description: 'URL where the user should enter the user_code' }),
    expires_in: z.number().meta({ description: 'Lifetime of the device_code in seconds' }),
    interval: z.number().meta({ description: 'Minimum polling interval in seconds' }),
});

const tokenResponse = z.object({
    access_token: z.string().meta({ description: 'Bearer access token' }),
    token_type: z.literal('Bearer').meta({ description: 'Token type (always Bearer)' }),
    expires_in: z.number().meta({ description: 'Access token lifetime in seconds' }),
    refresh_token: z
        .string()
        .meta({ description: 'Refresh token for obtaining new access tokens' }),
    scope: z.string().meta({ description: 'Granted scopes (space-separated)' }),
});

const oauthErrorResponse = (errors: [string, ...string[]]): z.ZodType =>
    z.object({
        error: z.enum(errors),
        error_description: z.string(),
        code: z.string().optional().meta({ description: 'Application-specific error code' }),
    });

const invalidRequestErrorResponse = oauthErrorResponse(['invalid_request']);
const tokenErrorResponse = oauthErrorResponse([
    'authorization_pending',
    'slow_down',
    'expired_token',
    'access_denied',
    'invalid_grant',
    'invalid_request',
    'unsupported_grant_type',
]);
const rateLimitErrorResponse = oauthErrorResponse(['slow_down']);
const serverErrorResponse = oauthErrorResponse(['server_error']);

// ============================================================================
// Route Definitions
// ============================================================================

export const oauthRoutes: PathsObject = {
    '/oauth/device': {
        head: {
            operationId: 'checkDeviceAuthorization',
            tags: ['OAuth'],
            summary: 'Check whether device authorization is enabled',
            'x-stability': 'stable',
            security: NO_AUTH,
            responses: {
                '200': { description: 'Device authorization enabled' },
                '400': { description: 'Device authorization disabled' },
            },
        },
        post: {
            'x-stability': 'stable',
            operationId: 'requestDeviceAuthorization',
            tags: ['OAuth'],
            summary: 'Request device authorization code',
            description:
                'Initiates the OAuth 2.0 Device Authorization Grant flow (RFC 8628). Returns a device_code and user_code that the user must enter at the verification_uri to authorize the device.',
            security: NO_AUTH,
            requestBody: {
                required: true,
                content: {
                    'application/json': { schema: deviceCodeRequestSchema },
                    'application/x-www-form-urlencoded': { schema: deviceCodeRequestSchema },
                },
            },
            responses: {
                '200': {
                    description: 'Device authorization code issued',
                    content: {
                        'application/json': {
                            schema: deviceAuthorizationResponse,
                        },
                    },
                },
                '400': {
                    description: 'Device authorization disabled or invalid request',
                    content: {
                        'application/json': { schema: invalidRequestErrorResponse },
                    },
                },
                '429': {
                    description: 'Rate limit exceeded — too many authorization requests',
                    content: {
                        'application/json': { schema: rateLimitErrorResponse },
                    },
                },
                '413': {
                    description: 'Request body too large',
                    content: { 'application/json': { schema: invalidRequestErrorResponse } },
                },
                '500': {
                    description: 'Internal server error',
                    content: { 'application/json': { schema: serverErrorResponse } },
                },
            },
        },
    },

    '/oauth/token': {
        post: {
            'x-stability': 'stable',
            operationId: 'exchangeToken',
            tags: ['OAuth'],
            summary: 'Exchange device code or refresh token',
            description:
                'Exchanges a device_code for access and refresh tokens (after user approval), or exchanges a refresh_token for a new token pair. Follows RFC 8628 error semantics for pending/denied/expired states. An approved device code for a disabled account returns HTTP 400 with error=access_denied and error_description=account_disabled; stop polling and ask the server administrator.',
            security: NO_AUTH,
            requestBody: {
                required: true,
                content: {
                    'application/json': { schema: tokenRequestBodySchema },
                    'application/x-www-form-urlencoded': { schema: tokenRequestBodySchema },
                },
            },
            responses: {
                '200': {
                    description: 'Token issued successfully',
                    content: {
                        'application/json': { schema: tokenResponse },
                    },
                },
                '400': {
                    description:
                        'RFC 8628 error — authorization pending, slow down, expired, denied, or invalid grant',
                    content: {
                        'application/json': { schema: tokenErrorResponse },
                    },
                },
                '429': {
                    description: 'Rate limit exceeded',
                    content: { 'application/json': { schema: rateLimitErrorResponse } },
                },
                '413': {
                    description: 'Request body too large',
                    content: { 'application/json': { schema: invalidRequestErrorResponse } },
                },
                '500': {
                    description: 'Internal server error',
                    content: { 'application/json': { schema: serverErrorResponse } },
                },
            },
        },
    },
};
