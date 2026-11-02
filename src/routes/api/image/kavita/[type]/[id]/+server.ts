// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: authenticated — Kavita artwork proxy (rate-limited); no user-scoped data

import type { RequestHandler } from './$types';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { KAVITA_TYPE_CONFIG } from '$lib/server/services/image-proxy/types';
import { parseQualityParam } from '$lib/server/utils/image-proxy.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';

const logger = Logger.for('KavitaImageAPI');

export const GET: RequestHandler = withImageProxyRateLimit(
    withErrorHandler(async ({ params, url, request }) => {
        if (!features.kavita) {
            return new Response('Kavita not configured', { status: 503 });
        }

        const { type, id } = params as { type: string; id: string };

        if (!KAVITA_TYPE_CONFIG[type]) {
            logger.warn('Invalid Kavita image type requested', { type, id });
            return new Response('Invalid image type', { status: 400 });
        }

        const numericId = Number.parseInt(id, 10);
        if (Number.isNaN(numericId)) {
            return new Response('Invalid ID', { status: 400 });
        }

        const quality = parseQualityParam(url);
        const service = getImageProxyService();
        const result = await service.getKavitaImage(type, id, { quality });

        if (!result) return new Response('Image not found', { status: 404 });
        return imageResponse(result, request);
    }),
);
