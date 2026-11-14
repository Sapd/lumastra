// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /Users/Password — refused; see jellyfin-compat/user-password.ts for why.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleUpdatePassword } from '$lib/server/jellyfin-compat/user-password';

export const POST: RequestHandler = withJellyfinAuth(handleUpdatePassword, { mode: 'write' });
