// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Localization/Options — static list, see jellyfin-compat/localization.ts.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getLocalizationOptions } from '$lib/server/proprietary/jellyfin-compat/localization';

export const GET: RequestHandler = withJellyfinAuth(() => json(getLocalizationOptions()));
