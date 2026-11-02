// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for OAuth 2.0 Device Authorization Grant (RFC 8628)
 *
 * Provides validation for OAuth device flow endpoints.
 */

import { z } from 'zod';

// ============================================================================
// Device Code Request Schema
// ============================================================================

/**
 * Schema for device authorization request
 * POST /oauth/device
 */
export const deviceCodeRequestSchema = z.object({
    client_id: z.string().min(1).max(128),
    /**
     * Advisory only — the grant is server-fixed and never reads this back.
     * Bounded because POST /oauth/device is unauthenticated: without a cap any
     * caller can persist an arbitrarily large string that is later rendered on
     * the consent screen. 256 is far above any real OAuth scope list.
     */
    scope: z.string().max(256).optional(),
    device_name: z.string().max(64).optional(),
    device_id: z.string().optional(),
});

export type DeviceCodeRequestInput = z.infer<typeof deviceCodeRequestSchema>;

// ============================================================================
// Token Grant Schemas
// ============================================================================

/**
 * Schema for device code grant
 * POST /oauth/token with grant_type=urn:ietf:params:oauth:grant-type:device_code
 */
export const tokenDeviceCodeGrantSchema = z.object({
    grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    device_code: z.string().min(1),
    client_id: z.string().min(1),
});

export type TokenDeviceCodeGrantInput = z.infer<typeof tokenDeviceCodeGrantSchema>;

/**
 * Schema for refresh token grant
 * POST /oauth/token with grant_type=refresh_token
 *
 * client_id is optional for backward compatibility with clients that omit it.
 * Conforming clients (RFC 6749 §10.4) SHOULD send client_id so the server can
 * verify the token belongs to the presenting client.
 */
export const tokenRefreshGrantSchema = z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1).optional(),
});

export type TokenRefreshGrantInput = z.infer<typeof tokenRefreshGrantSchema>;

/** Native approval deliberately retains RFC 8628's user_code spelling. */
export const deviceApprovalQuerySchema = z.object({
    user_code: z
        .string()
        .regex(/^(?:[A-Za-z0-9]{8}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/)
        .describe('The code shown on the target device; case-insensitive, dash optional'),
});
export const deviceApprovalBodySchema = deviceApprovalQuerySchema.extend({
    approve: z
        .boolean()
        .describe('True only after the user confirms the matching code and device; false denies'),
});
export const deviceApprovalInfoSchema = z.object({
    clientId: z
        .string()
        .describe('Self-declared target client identifier, capped at 128 characters'),
    deviceName: z
        .string()
        .optional()
        .describe('Self-reported device name/model, capped at 64 characters plus ellipsis'),
});
export const deviceApprovalResultSchema = z.object({
    approved: z.boolean().describe('The recorded decision'),
});
