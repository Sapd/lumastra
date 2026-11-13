// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// ImageController by name: GET /Persons/{name}/Images/{imageType}[/{imageIndex}]
// (people-studios-handlers.ts).

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handlePersonImageByName } from '$lib/server/proprietary/jellyfin-compat/people-studios-handlers';

export const GET: RequestHandler = withJellyfinAuth(handlePersonImageByName);
