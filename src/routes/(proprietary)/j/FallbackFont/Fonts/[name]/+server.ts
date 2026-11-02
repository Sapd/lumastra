// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /FallbackFont/Fonts/{name} — no fallback fonts are configured (see the
// list route), so every name is unknown.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';

export const GET: RequestHandler = withJellyfinAuth(() => ApiResponses.notFound('Font not found'));
