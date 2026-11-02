// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { checkRateLimit } from './valkey-rate-limit.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';

interface CredentialResolvers {
    bearer: (event: RequestEvent) => Promise<Response | undefined>;
}

/** Public discovery accepts only bearer credentials; rejected credentials are anonymous. */
export async function resolveOptionalServerCredential(
    event: RequestEvent,
    resolvers: CredentialResolvers,
): Promise<Response | undefined> {
    (event.locals as Partial<App.Locals>).user = undefined;
    event.locals.principal = undefined;
    event.locals.authMethod = undefined;
    try {
        const ip = getClientIpStrict(event);
        const limit = await checkRateLimit(`public-api:server:${ip ?? 'unknown'}`, 120, 60);
        if (!limit.allowed) return ApiResponses.rateLimited(limit.resetAt * 1000);
    } catch {
        // Discovery remains available when the rate-limit backend is unavailable.
    }
    if (/^bearer\s+/i.test(event.request.headers.get('authorization') ?? '')) {
        const denied = await resolvers.bearer(event);
        if (!denied && event.locals.principal) return undefined;
        (event.locals as Partial<App.Locals>).user = undefined;
        event.locals.principal = undefined;
        event.locals.authMethod = undefined;
    }
    return undefined;
}
