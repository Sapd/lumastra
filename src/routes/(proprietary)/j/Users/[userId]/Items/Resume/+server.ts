// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleResumeRequest } from '$lib/server/proprietary/jellyfin-compat/resume-handler';

/** Jellyfin ItemsController.GetResumeItems — `/UserItems/Resume` re-exports this. */
export const GET: RequestHandler = withJellyfinAuth((event) => handleResumeRequest(event));
