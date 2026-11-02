// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { audiobookSortParams } from '$lib/api/audiobooks';
import { apiGet } from '$lib/api/client';
import { AudiobookBrowseResponseSchema } from '$lib/schemas/api-audiobooks-responses';
import type { AudiobookSortValue } from '$lib/schemas/api-audiobooks-responses';

export interface LibraryScope {
    group: string | null;
    language: string | null;
    series: string | null;
    author: string | null;
    narrator: string | null;
    letter: string | null;
    sort: AudiobookSortValue;
}

/** One scope for browse, search and every subsequent page. */
export function libraryParams(scope: LibraryScope): Record<string, string | undefined> {
    return {
        libraryGroupId: scope.group ?? undefined,
        lang: scope.language ?? undefined,
        seriesId: scope.series ?? undefined,
        authorId: scope.author ?? undefined,
        narratorId: scope.narrator ?? undefined,
        letter: scope.letter ?? undefined,
        ...audiobookSortParams(scope.sort),
        collapse: scope.series ? undefined : 'series',
    };
}

export function requestLibrary(
    scope: LibraryScope,
    offset: number,
    limit: number,
    signal: AbortSignal,
    query?: string,
): ReturnType<typeof apiGet<typeof AudiobookBrowseResponseSchema>> {
    return apiGet('/api/audiobooks', AudiobookBrowseResponseSchema, {
        signal,
        params: { ...libraryParams(scope), offset, limit, q: query },
    });
}

/** Invalidates immediately, including during a replacement query's debounce. */
export class LatestRequest {
    private controller: AbortController | undefined;

    cancel(): void {
        this.controller?.abort();
        this.controller = undefined;
    }

    start(): { signal: AbortSignal; current: () => boolean } {
        this.cancel();
        const controller = new AbortController();
        this.controller = controller;
        return {
            signal: controller.signal,
            current: () => this.controller === controller && !controller.signal.aborted,
        };
    }
}
