// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleSimilarItems } from '$lib/server/jellyfin-compat/similar-items-handler';

export const GET: RequestHandler = withJellyfinAuth(handleSimilarItems);
