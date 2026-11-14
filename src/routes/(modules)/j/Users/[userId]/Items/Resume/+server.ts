// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleResumeRequest } from '$lib/server/jellyfin-compat/resume-handler';

/** Jellyfin ItemsController.GetResumeItems — `/UserItems/Resume` re-exports this. */
export const GET: RequestHandler = withJellyfinAuth((event) => handleResumeRequest(event));
