// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { advertisedBaseUrl } from '$lib/server/jellyfin-compat/advertised-base-url';
import type { RequestHandler } from './$types';
import { getPublicSystemInfo } from '$lib/server/jellyfin-compat/serializers/system';

export const GET: RequestHandler = async ({ url }) => {
    return json(getPublicSystemInfo(advertisedBaseUrl(url)));
};
