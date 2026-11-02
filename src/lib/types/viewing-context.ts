// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ViewingContext — arrival-context discriminated union for the /watch/[itemId] route.
 *
 * The server resolves this from query params + library-type fallback and passes it
 * into page data. The page component renders the matching AGPL shell.
 *
 * Proprietary use cases (lesson, showcase) never reach /watch — they have their own
 * routes (/learn/[slug]/lesson/[moduleId] and /showcase/[id]).
 */

/**
 * VOD context — default for entertainment media (movies, TV episodes).
 * The full-bleed immersive WatchShell is used.
 */
export interface VodViewingContext {
    kind: 'vod';
}

/**
 * Minimal lesson entry for the LessonRail display in EducationalShell.
 * Serialised from NonEntertainmentEpisode by the watch-page server load.
 */
export interface LessonEntry {
    id: string;
    title: string;
    lessonNumber: number | null;
}

/**
 * Educational context — for educational library items.
 * Renders EducationalShell with lesson-list rail + next/prev auto-advance.
 * collectionId is the series UUID for the lesson rail.
 * nextId / prevId are pre-resolved by the server for auto-advance.
 */
export interface EducationalViewingContext {
    kind: 'educational';
    collectionId: string;
    position: number;
    returnPath: string;
    nextId: string | null;
    prevId: string | null;
    /** Ordered lesson IDs in the collection, for rail display */
    lessonIds: string[];
    /**
     * Full lesson list (id + title + lessonNumber) for the LessonRail.
     * Populated by the server so the rail has titles to display.
     * When empty, the rail is hidden — the server should always populate this.
     */
    lessons: LessonEntry[];
}

/**
 * Personal / home-video context — for home_video and personal library items.
 * Renders PersonalShell with event-context strip + next-clip auto-advance.
 */
export interface PersonalViewingContext {
    kind: 'personal';
    eventGroupId: string;
    position: number;
    returnPath: string;
    nextId: string | null;
    prevId: string | null;
    dateFiled: string | null;
    eventName: string | null;
}

export type ViewingContext = VodViewingContext | EducationalViewingContext | PersonalViewingContext;
