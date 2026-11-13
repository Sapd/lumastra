// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PersonsController: GET /Persons (people-studios-handlers.ts).

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handlePersonsList } from '$lib/server/proprietary/jellyfin-compat/people-studios-handlers';

export const GET: RequestHandler = withJellyfinAuth(handlePersonsList);
