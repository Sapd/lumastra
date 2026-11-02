// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types';
import type { ViewingContext } from '$lib/types/viewing-context.js';
import { isEducational, isHomeVideo, isPersonal } from '$lib/server/utils/media-types.js';
import { getAccessibleSeriesWithEpisodes } from '$lib/server/utils/non-entertainment-series-access.js';

export interface ViewingContextInput {
    url: URL;
    internalId: string;
    mediaType: string;
    seriesId: string | null;
    user: UserContext | undefined;
}

/**
 * A `returnPath` the shells may `goto()`: an absolute path on this origin.
 * Parsed the way a browser would, so `//host`, `/\host` and `/<TAB>/host`
 * (browsers drop tab/CR/LF) are all refused.
 */
export function isSameOriginPath(value: string): boolean {
    if (!value.startsWith('/')) return false;
    const origin = 'http://same.invalid';
    try {
        return new URL(value, origin).origin === origin;
    } catch {
        return false;
    }
}

/**
 * The /watch arrival context (educational / personal shell or plain VOD).
 *
 * `?col=` / `?event=` name a series the viewer chose, so its lesson or clip list
 * is loaded through the access-checked helper: a series they may not see yields
 * an empty list, never its titles and ids (2026-10-07 entry-point review).
 */
export async function resolveViewingContext(
    sql: postgres.Sql,
    input: ViewingContextInput,
): Promise<ViewingContext> {
    let viewingContext: ViewingContext = { kind: 'vod' };

    const ctxParam = input.url.searchParams.get('ctx');
    const colParam = input.url.searchParams.get('col'); // series/collection UUID
    const eventParam = input.url.searchParams.get('event'); // event group UUID
    // Validate returnPath to prevent open redirects: only accept absolute-path values
    // (starting with '/') so an attacker cannot supply https://evil.com via a crafted link.
    // goto(resolve(returnPath)) in the shells would otherwise navigate externally.
    const rawReturnPath = input.url.searchParams.get('returnPath') ?? '/browse';
    const returnPathParam = isSameOriginPath(rawReturnPath) ? rawReturnPath : '/browse';

    const needsEducational =
        ctxParam === 'educational' || (!ctxParam && isEducational(input.mediaType));

    const needsPersonal =
        ctxParam === 'personal' ||
        (!ctxParam && (isHomeVideo(input.mediaType) || isPersonal(input.mediaType)));

    if (needsEducational) {
        // Resolve the collection: colParam is the series UUID,
        // or fall back to the item's own parent series if it is an episode.
        const collectionId = colParam ?? input.seriesId;

        if (collectionId) {
            const { episodes: lessonItems } = await getAccessibleSeriesWithEpisodes(
                sql,
                collectionId,
                input.user,
                {
                    mediaType: 'educational',
                },
            ).catch(() => ({ series: null, episodes: [] }));

            const lessonIds = lessonItems.map((l) => l.id);
            const pos = lessonIds.indexOf(input.internalId);

            viewingContext = {
                kind: 'educational',
                collectionId,
                position: pos >= 0 ? pos : 0,
                returnPath: returnPathParam,
                nextId: pos >= 0 && pos + 1 < lessonIds.length ? lessonIds[pos + 1] : null,
                prevId: pos > 0 ? lessonIds[pos - 1] : null,
                lessonIds,
                // Full lesson list for LessonRail display (titles + lesson numbers).
                // Without this the rail is hidden ({#if lessons.length > 0} guard
                // in EducationalShell) and the breadcrumb position counter is blank.
                lessons: lessonItems.map((l, i) => ({
                    id: l.id,
                    title: l.title,
                    lessonNumber: l.episode_number ?? i + 1,
                })),
            };
        }
    } else if (needsPersonal) {
        // For home_video: event group is the series parent (event folder)
        // colParam or eventParam is the series UUID.
        const groupId = eventParam ?? colParam ?? input.seriesId;

        if (groupId) {
            const { episodes: clipItems } = await getAccessibleSeriesWithEpisodes(
                sql,
                groupId,
                input.user,
                {
                    mediaType: input.mediaType,
                },
            ).catch(() => ({ series: null, episodes: [] }));

            const clipIds = clipItems.map((c) => c.id);
            const pos = clipIds.indexOf(input.internalId);

            // Attempt to read event metadata from the item's own custom_metadata —
            // we don't have it here from getMediaItemForWatch, so we expose null and
            // the shell will not show the metadata strip (acceptable for v1).
            viewingContext = {
                kind: 'personal',
                eventGroupId: groupId,
                position: pos >= 0 ? pos : 0,
                returnPath: returnPathParam,
                nextId: pos >= 0 && pos + 1 < clipIds.length ? clipIds[pos + 1] : null,
                prevId: pos > 0 ? clipIds[pos - 1] : null,
                dateFiled: null,
                eventName: null,
            };
        }
    }

    return viewingContext;
}
