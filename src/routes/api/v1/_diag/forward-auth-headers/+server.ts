// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Forward-Auth Header Reflection Endpoint
 *
 * GET /api/v1/_diag/forward-auth-headers
 *
 * Auth: Bearer / PAT / service token (via handlePublicApiAuth middleware).
 * Returns ONLY the NAMES of forward-auth headers present on the inbound
 * request, from a fixed allowlist:
 *   - config.USERHEADER (lowercased)
 *   - config.GROUPHEADER (lowercased)
 *   - any header whose lowercased name starts with "x-authentik-"
 *
 * Values are NEVER returned — only names, so the probe can confirm whether the
 * reverse-proxy edge stripped the headers before they reached the app.
 *
 * Used by the security self-check edge probe (edge-probes.ts):
 *   1. The probe sends a request through the public edge with a forged
 *      x-authentik-username header AND a valid ephemeral Bearer token.
 *   2. received:[] means the edge stripped the header → PASS.
 *   3. received:["x-authentik-username"] means the edge forwarded it → FAIL.
 *
 * Security notes:
 * - Auth is enforced by the handlePublicApiAuth middleware (Bearer/PAT/svc).
 *   The route checks `locals.user?.username` as a defense-in-depth backstop.
 * - Read-only; no side effects.
 * - NEVER returns header values.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { problem } from '$lib/server/api/problem.js';
import {
    buildForwardAuthAllowlist,
    collectForwardAuthHeaderNames,
    type ForwardAuthHeadersResponse,
} from './headers-util.js';

export const GET: RequestHandler = async ({ locals, request }) => {
    // Defense-in-depth: handlePublicApiAuth already ran. Reject if the
    // middleware did not populate a user identity (should not happen in
    // production, but guards against bypass attempts or middleware gaps).
    const user = locals.user;
    if (!user?.username) {
        return problem('unauthorized');
    }

    const allowlist = buildForwardAuthAllowlist();
    const received = collectForwardAuthHeaderNames(request.headers, allowlist);

    return json({ received } satisfies ForwardAuthHeadersResponse);
};
