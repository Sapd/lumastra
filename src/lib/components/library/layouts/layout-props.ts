// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LibraryTypeTemplate } from '$lib/shared/library-type-templates';
import type { SvelteSet } from 'svelte/reactivity';
import type { BrowseItem } from '$lib/shared/browse-layout-utils';

export type { BrowseItem };

/**
 * Props shared by all four browse layout sub-components.
 * NonEntertainmentBrowse.svelte computes these and passes them to whichever
 * layout component matches template.browseConfig.layout.
 */
export interface BrowseLayoutProps {
    libraryType: string;
    template: LibraryTypeTemplate;
    /** The primary group key (from browseConfig.groupBy[0]) used for inline edits. */
    groupKey: string;
    /** Pre-filtered and sorted items, keyed by primary group value. */
    groupedItems: Map<string, BrowseItem[]>;
    /** Card click navigation callback. */
    onNavigate: (item: BrowseItem) => void;
    /** Starts the inline quick-edit for the group key field. */
    onEditStart: (item: BrowseItem) => void;
    editingItemId: string | null;
    editCategoryValue: string;
    onEditSave: (itemId: string) => void;
    onEditCancel: () => void;
    savingCategory: boolean;
    failedPosters: SvelteSet<string>;
    onPosterError: (itemId: string) => void;
    progressMeaning: 'watch_progress' | 'completion';
    isAdmin: boolean;
    bulkModeActive: boolean;
    selectedIds: SvelteSet<string>;
    onToggleSelect: (id: string) => void;
    onOpenDrawer: (item: BrowseItem) => void;
}
