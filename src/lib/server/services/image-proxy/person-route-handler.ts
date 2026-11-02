// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared person-image route handler.
 *
 * Used by `/api/image/person/[id]` (internal proxy). Keeping the body here
 * allows shared validation/access logic for any future person-image proxy variant.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getImageProxyService,
    imageResponse,
    PersonRateLimitError,
} from '$lib/server/services/image-proxy';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { parsePersonHandle } from '$lib/shared/person-handle.js';

export async function personImageHandler({
    params,
    url,
    request,
    locals,
}: RequestEvent): Promise<Response> {
    if (!locals.user) return ApiResponses.unauthorized();
    const { id } = params;

    const parsed = parsePersonHandle(id ?? '');
    if (!parsed.ok)
        return ApiProblem.validationFailed([{ field: 'id', message: 'Invalid person handle' }]);
    const personId = String(parsed.numericId);

    const service = getImageProxyService();
    const requestedSize = url.searchParams.get('size') || 'w185';
    const size =
        ({ thumb: 'w45', card: 'w185', full: 'original' } as Record<string, string>)[
            requestedSize
        ] ?? requestedSize;
    const quality = parseQualityParam(url);

    try {
        const result = await service.getPersonImage(personId, {
            rawSize: size,
            quality,
        });
        if (!result) return new Response('Person image not found', { status: 404 });
        return imageResponse(result, request, {
            scope: 'private',
            bounded: ['w45', 'w185', 'h632'].includes(size),
        });
    } catch (error) {
        if (error instanceof PersonRateLimitError) {
            return new Response('Rate limited', { status: 429 });
        }
        throw error;
    }
}
