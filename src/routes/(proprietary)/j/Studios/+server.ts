// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// StudiosController: GET /Studios (people-studios-handlers.ts).

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleStudiosList } from '$lib/server/proprietary/jellyfin-compat/people-studios-handlers';

export const GET: RequestHandler = withJellyfinAuth(handleStudiosList);
