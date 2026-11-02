// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MediaInspector's item prop shape, split out of the component into its own
 * module. A type re-exported from a `.svelte` file's `<script module>` block
 * is invisible to tsgo, which skips `.svelte` entirely — a plain `.ts`
 * consumer (like this component's test file) importing that type back out of
 * the component fails typecheck even though svelte-check and Vite both
 * resolve it fine. Keeping the type here avoids the round-trip.
 */

import type { MediaIssue } from '$lib/shared/media-issues.js';
export interface MediaInspectorItem {
    id: string;
    title: string;
    mediaType: string;
    /** Cache-busting key alongside `id` — already on every browser row. */
    updatedAt: string;
    hasFiles: boolean;
    childCount: number;
    metadataLocked: boolean;
    isUnidentifiedDomain: boolean;
    supportsProviderIdentity: boolean;
    /**
     * Row-level ancestry (plan 1, see `+page.server.ts` ~line 275). Generic
     * across every hierarchy the browser rows already resolve — series →
     * season, artist → album, or a plain parent for anything else — and
     * preferred over the preview fetch's `parentTitle`/`grandparentTitle`
     * (episode/track only) when present. All optional: an item type with
     * none of these must still render, just without an ancestry line.
     */
    artistTitle?: string;
    albumTitle?: string;
    seriesTitle?: string;
    seasonTitle?: string;
    genericParentTitle?: string;
    /**
     * The row's issues (`deriveMediaIssues`, computed server-side for the list).
     * Row-derived like the ancestry above, so the Issues section renders
     * without waiting on the preview fetch.
     */
    issues?: MediaIssue[];
}
