// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import { advertisedBaseUrl } from '$lib/server/proprietary/jellyfin-compat/advertised-base-url';
import type { RequestHandler } from './$types';
import { getPublicSystemInfo } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

export const GET: RequestHandler = async ({ url }) => {
    return json(getPublicSystemInfo(advertisedBaseUrl(url)));
};
