// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBrandingOptions } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

export const GET: RequestHandler = async () => {
    return json(getBrandingOptions());
};
