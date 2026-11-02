// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error, type RequestEvent } from '@sveltejs/kit';
import { ContributorDetailSchema } from '$lib/schemas/api-audiobook';
import { AudiobookPageSchema, SeriesDetailSchema } from '$lib/schemas/api-audiobook-preview';
import type { AudiobookResource } from '$lib/api/audiobooks';
import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
import type { PageBlock } from '$lib/schemas/pagination';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    getCatalogResource,
    listCatalogBooks,
} from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { resourceBooksQuery } from '$lib/server/api/defs/audiobooks/catalog-input.js';

export type AudiobookResourceData = {
    kind: AudiobookResource;
    detail: {
        id: string;
        name: string;
        bookCount: number;
        durationMs: number;
        nextUp?: AudiobookPreview | null;
    };
    books: { items: AudiobookPreview[]; page: PageBlock };
};

const RESOURCE_OF = { authors: 'author', narrators: 'narrator', series: 'series' } as const;

/**
 * Loads an author, narrator or series page from the same query functions the
 * `/api/audiobooks/{kind}/{id}` handlers call, in-process.
 *
 * Not through `event.fetch`: a sub-request forwards only the cookie and
 * authorization headers, not the proxy identity of a forward-auth deployment,
 * so the API answered 401 and every one of these pages was a 401 for those
 * users (found by the route sweep, 2026-11-02). `/audiobooks` reads in-process
 * for the same reason.
 */
export async function loadAudiobookResource(
    event: Pick<RequestEvent, 'params' | 'locals'>,
    kind: AudiobookResource,
): Promise<AudiobookResourceData> {
    const id = event.params.id ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) error(404);
    const user = event.locals.user;
    if (!user) error(401);
    const sql = getDb();
    if (!sql) error(503);

    const resource = RESOURCE_OF[kind];
    const access = searchAccessBoundary(await buildSearchAccessContext(sql, user));
    const viewer = { access, viewerId: user.userId, surface: 'internal' as const };
    const detailRaw = await getCatalogResource(sql, { ...viewer, resource, id });
    // Unknown, or not visible to this viewer: indistinguishable, like the API's 404.
    if (!detailRaw) error(404);
    // Same defaults and bounds as the endpoint's query schema (limit 60, offset 0).
    const input = resourceBooksQuery.parse({ limit: 60, offset: 0 });
    const booksRaw = await listCatalogBooks(sql, {
        ...input,
        groupId: input.libraryGroupId,
        ...viewer,
        ...(resource === 'author' ? { authorId: id } : {}),
        ...(resource === 'narrator' ? { narratorId: id } : {}),
        ...(resource === 'series'
            ? { seriesId: id, sort: 'series' as const, order: 'asc' as const }
            : {}),
        collapse: undefined,
    });
    const detail =
        kind === 'series'
            ? SeriesDetailSchema.parse(detailRaw)
            : ContributorDetailSchema.parse(detailRaw);
    const books = AudiobookPageSchema.parse(booksRaw);
    return { kind, detail, books };
}
