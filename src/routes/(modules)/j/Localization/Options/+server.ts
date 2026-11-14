// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Localization/Options — static list, see jellyfin-compat/localization.ts.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getLocalizationOptions } from '$lib/server/jellyfin-compat/localization';

export const GET: RequestHandler = withJellyfinAuth(() => json(getLocalizationOptions()));
