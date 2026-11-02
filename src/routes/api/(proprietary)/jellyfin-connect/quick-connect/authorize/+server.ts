// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Quick Connect Authorization API
 *
 * POST - Authorize a Quick Connect code displayed on a TV/client device.
 *
 * Rate limited: 10 code-submissions per minute per user to prevent 6-digit
 * code brute-force. The rate-limit wrapper runs OUTSIDE mount() so it fires
 * before auth/body parsing, keeping the fail-fast order intact.
 *
 * security review 2026-09-12, C13: keyed on the authenticated username (set
 * by forward-auth before this handler runs), falling back to the STRICT
 * (non-spoofable) client IP only when no username is available. The default
 * key builder's `ip` component uses `getClientIp`, which honors an
 * attacker-supplied `X-Forwarded-For` by implicit proxy trust when
 * `TRUSTED_PROXY_IPS` is unset — rotating that header would otherwise get a
 * fresh bucket per request and defeat the cap.
 */

// authz: user — auth enforced by the def (kind:'feature'+kind:'user'); mount() runs the guard before the handler
import { mount } from '$lib/server/api/mount.js';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { quickConnectAuthorizeRateLimitKey } from '$lib/server/proprietary/jellyfin-compat/quick-connect-authorize';
import { jellyfinQuickConnectAuthorizeDef } from '$lib/server/api/defs/integrations/jellyfin-quick-connect.js';

const { POST: mountedPost } = mount(jellyfinQuickConnectAuthorizeDef, {
    surface: 'internal',
});

// Apply rate limit (10/min per user) around the mounted handler.
export const POST = withValkeyRateLimit(10, 60, quickConnectAuthorizeRateLimitKey)(mountedPost!);
