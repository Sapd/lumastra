// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Device Authorization Page - Server Load Function
// This page is behind forward auth - user is already authenticated via Authentik

import type { PageServerLoad } from './$types';
import {
    getDeviceCodeService,
    getDeviceGrantCapabilities,
    isDeviceAuthEnabled,
} from '$lib/server/oauth';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkDeviceApprovalRateLimit } from '$lib/server/oauth/device-approval-rate-limit';
import { normalizeUserCode } from '$lib/server/oauth/device-code.service';
import { deviceApprovalQuerySchema } from '$lib/schemas/oauth';
import { error, redirect } from '@sveltejs/kit';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

/**
 * Display cap for the device-supplied name. `oauth_device_codes.device_name`
 * is unbounded text posted to an UNAUTHENTICATED endpoint, so its length is
 * caller-controlled — bound it before it reaches the consent card.
 */
const MAX_DEVICE_NAME_DISPLAY_LENGTH = 64;

function displayDeviceName(name: string | null): string | null {
    const trimmed = name?.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_DEVICE_NAME_DISPLAY_LENGTH
        ? `${trimmed.slice(0, MAX_DEVICE_NAME_DISPLAY_LENGTH)}…`
        : trimmed;
}

export const load: PageServerLoad = async (event) => {
    const { url, locals } = event;
    // Check if device auth is enabled
    if (!isDeviceAuthEnabled()) {
        throw redirect(302, appPath('/'));
    }

    // Get user from forward auth
    const username = locals.user?.username;
    // Only used to decide whether the "no administrative access" reassurance is
    // worth showing: it answers a question only an admin has ("does approving
    // this hand my TV my admin rights?"). The guarantee itself is unconditional.
    const isAdmin = localsIsAdmin(locals);
    if (!username) {
        // This shouldn't happen if forward auth is properly configured
        // But we handle it gracefully
        return {
            enabled: true,
            username: null,
            isAdmin: false,
            error: 'Not authenticated. Please ensure you are logged in.',
            deviceCode: null,
        };
    }

    // Check if code was provided in URL
    const codeParam = url.searchParams.get('code');

    if (!codeParam) {
        // No code provided - show input form
        return {
            enabled: true,
            username,
            isAdmin,
            error: null,
            deviceCode: null,
        };
    }

    const invalidCode = {
        enabled: true,
        username,
        isAdmin,
        error: 'Invalid or expired device code',
        deviceCode: null,
        providedCode: codeParam.slice(0, 9),
    };
    const parsed = deviceApprovalQuerySchema.safeParse({ user_code: codeParam });
    if (!parsed.success) return invalidCode;
    const normalizedCode = normalizeUserCode(parsed.data.user_code);
    const limited = await checkDeviceApprovalRateLimit(
        locals.user.userId,
        normalizedCode,
        getClientIpStrict(event),
    );
    if (limited) error(limited.status, 'Too many approval attempts. Please wait.');
    const record = await getDeviceCodeService().getByUserCode(normalizedCode);
    if (!record || record.status !== 'pending') return invalidCode;

    // Valid pending code
    return {
        enabled: true,
        username,
        isAdmin,
        error: null,
        deviceCode: {
            userCode: record.user_code,
            clientId: record.client_id,
            // Self-reported by the device ("Living Room Apple TV"), so it is a
            // recognition aid next to client_id, never an identity claim.
            deviceName: displayDeviceName(record.device_name),
            scope: record.scope,
            expiresAt: record.expires_at.toISOString(),
            // What the issued token will ACTUALLY carry. Derived from the same
            // buildPrincipal() the bearer auth path runs, so the consent screen
            // cannot promise more (or less) than the server enforces.
            capabilities: getDeviceGrantCapabilities(record.scope),
            // Server-resolved by client_id at code-creation time (see
            // device-client-redirects.ts) — never client-supplied. The success
            // state below redirects here if set; null for any client_id that
            // isn't a known first-party client.
            redirectUri: record.redirect_uri,
        },
    };
};
