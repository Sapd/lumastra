// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { config } from '$lib/server/config';
import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
import { appPath } from '$lib/shared/api-urls.js';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublicSystemInfo } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

export const GET: RequestHandler = async ({ url }) => {
    const baseUrl = normalizePublicBaseUrl(config.PUBLIC_BASE_URL) || `${url.origin}${appPath('')}`;
    return json(getPublicSystemInfo(baseUrl));
};
