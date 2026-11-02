// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { parsePersonHandle } from '$lib/shared/person-handle.js';
import { personImageSet } from './resources.js';
import {
    getSelectedImageCandidate,
    registerPersonImageCandidate,
} from '$lib/server/database/queries/image-candidates.queries.js';
import { imageRevision } from './revision.js';

export async function resolvePersonImageSet(
    sql: postgres.Sql,
    surface: ApiSurface,
    handle: string,
    path?: string | null,
): Promise<ImageSet> {
    const person = parsePersonHandle(handle);
    if (!person.ok) return {};
    if (path)
        await registerPersonImageCandidate(sql, String(person.numericId), path);
    const candidate = await getSelectedImageCandidate(sql, person.handle, 'poster');
    if (!candidate) return {};
    const images = personImageSet(surface, person.handle, candidate.provider_ref);
    if (images.primary) {
        const revision = imageRevision({
            ownerId: candidate.id,
            role: 'profile',
            providerPath: candidate.provider_ref,
            localPath: candidate.file_path,
            customUrl: candidate.remote_url,
        });
        const version = (href: string): string => href.replace(/([?&]v=)[^&]+/, `$1${revision}`);
        images.primary.href = version(images.primary.href);
        images.primary.variants = Object.fromEntries(
            Object.entries(images.primary.variants ?? {}).map(([key, href]) => [
                key,
                version(href),
            ]),
        );
        images.primary.revision = revision;
        images.primary.provider = candidate.provider;
        images.primary.width = candidate.width ?? undefined;
        images.primary.height = candidate.height ?? undefined;
    }
    return images;
}
