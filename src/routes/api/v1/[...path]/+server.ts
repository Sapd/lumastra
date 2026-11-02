// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-all 404 for unmatched /api/v1/* paths.
//
// The auth middleware rejects most unauthenticated probes with 401 before
// they reach a route, but entity image endpoints (/api/v1/*/images/*) bypass
// auth via ?sig= HMAC and authenticated callers hitting an unknown endpoint
// would otherwise get SvelteKit's HTML error page, leaking the full app shell.
// A problem+json 404 (the /api/v1 error shape) closes that gap.

import type { RequestHandler } from './$types';
import { problem } from '$lib/server/api/problem.js';

export const fallback: RequestHandler = () =>
    // Same body as the sanitized error in hooks.server.ts, so probes learn nothing.
    problem('not_found');
