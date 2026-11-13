// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /Users/Configuration — stores the playback-preference part of an app's
// UserConfiguration; see jellyfin-compat/user-configuration.ts.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleUpdateUserConfiguration } from '$lib/server/proprietary/jellyfin-compat/user-configuration';

export const POST: RequestHandler = withJellyfinAuth(handleUpdateUserConfiguration, {
    pat: 'deny',
    mode: 'write',
});
