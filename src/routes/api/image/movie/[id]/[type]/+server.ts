// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: authenticated — 307 redirect to the Sonarr artwork proxy; returns no data

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appPath } from '$lib/shared/api-urls.js';

export const GET: RequestHandler = async ({ params, url }) => {
    throw redirect(
        307,
        appPath(
            `/api/image/sonarr/${encodeURIComponent(params.id)}/${encodeURIComponent(params.type)}${url.search}`,
        ),
    );
};
