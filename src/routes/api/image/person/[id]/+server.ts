// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Accepts numeric aliases or tmdb:123; invalid handles return a 422 problem.
// authz: authenticated — external person artwork proxy (rate-limited); no user-scoped data

import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { personImageHandler } from '$lib/server/services/image-proxy/person-route-handler';

export const GET: RequestHandler = withImageProxyRateLimit(withErrorHandler(personImageHandler));
