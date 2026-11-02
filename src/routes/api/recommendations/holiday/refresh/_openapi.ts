// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { route as readRoute } from '../_openapi.js';
import type { RouteMetadata } from '$lib/server/openapi';
export const route: RouteMetadata = {
    POST: {
        ...readRoute.GET!,
        summary: 'Refresh recommendations/holiday',
        body: readRoute.GET!.query,
        query: undefined,
    },
};
