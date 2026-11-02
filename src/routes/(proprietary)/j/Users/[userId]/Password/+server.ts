// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// POST /Users/[userId]/Password — refused; see jellyfin-compat/user-password.ts for why.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleUpdatePassword } from '$lib/server/proprietary/jellyfin-compat/user-password';

export const POST: RequestHandler = withJellyfinAuth(handleUpdatePassword, { mode: 'write' });
