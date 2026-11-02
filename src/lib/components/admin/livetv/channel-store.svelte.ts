// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ChannelStore — the single source of truth for the Live TV channels admin surface.
 *
 * All mutable channel/category state, every optimistic mutator, and the debounced
 * reorder persistence live here (lifted out of ChannelTable.svelte). One instance is
 * constructed by ChannelTable and shared with one-or-two <ChannelPane> children via
 * Svelte context, so split view renders the SAME data through two filtered viewports
 * with zero sync code — a cross-pane drop mutates `categories` and both panes re-render.
 *
 * Pane-local concerns (search text, expand state, scroll position) deliberately stay in
 * the pane, NOT here.
 */

import { getContext, setContext } from 'svelte';
import { buildChannelIndex, compareGroupFeeds } from './channel-viewer-status.js';
import { SvelteSet } from 'svelte/reactivity';
import { SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
import type { AdminChannelCategory, AdminChannel } from '$lib/schemas/livetv.js';
import {
    ChannelUpdatedResponseSchema,
    ChannelsReorderedResponseSchema,
    BulkChannelUpdateResponseSchema,
    CategoryUpdateResponseSchema,
    LiveTvAckResponseSchema,
    CreateCategoryResponseSchema,
    MergeCategoryResponseSchema,
    ChannelNumberResponseSchema,
} from '$lib/schemas/livetv.js';
import { LiveTvChannelHealthSchema } from '$lib/schemas/livetv-failures.js';
import { apiPut, apiPost, apiDelete } from '$lib/api/client.js';
import { toasts } from '$lib/stores/toast.store.js';
import {
    reconcileCategoryChannels,
    normalizeFilter,
    changedChannelUpdates,
    withFullChannels,
    withHiddenFollowers,
    channelMatches,
    planCategoryMove,
    orderCategoriesByIds,
    type CategoryMove,
    type PaneFilter,
    planGroupMove,
    planMoveToCategory,
    planMoveToOwnEdge,
} from './channel-reconcile.js';
import * as m from '$lib/paraglide/messages.js';

export interface ContextMenuState {
    channelId: string;
    x: number;
    y: number;
}

export type BulkAction = 'hide' | 'show' | 'setQuality' | 'moveToCategory';

/**
 * svelte-dnd-action zone types. ALL channel zones (every category, in every pane) share
 * ONE type so a channel can be dragged between any categories and across panes. The
 * category-reorder zone uses a DIFFERENT type so channels can't land in the category strip
 * and categories can't drop into a channel list.
 */
export const CHANNEL_DND_TYPE = 'livetv-channel';
export const CATEGORY_DND_TYPE = 'livetv-category';

/** UI-only sentinel id for the "uncategorized" pseudo-category (channels with category_id NULL). */
export const UNCATEGORIZED_ID = 'uncategorized';

interface UndoState {
    message: string;
    reverseAction: () => Promise<void>;
    timeout: ReturnType<typeof setTimeout>;
}

/** Deep-ish clone of the category list (category objects + channel arrays + channel objects). */
function cloneCategories(categories: AdminChannelCategory[]): AdminChannelCategory[] {
    return categories.map((cat) => ({ ...cat, channels: cat.channels.map((ch) => ({ ...ch })) }));
}

/**
 * The order a successful reorder save stored: each channel's sortOrder is its
 * index. The baseline for the next save's "what changed" diff.
 */
function storedOrder(categories: AdminChannelCategory[]): AdminChannelCategory[] {
    return categories.map((cat) => ({
        ...cat,
        channels: cat.channels.map((ch, index) => ({ ...ch, sortOrder: index })),
    }));
}

const SHOW_HIDDEN_KEY = 'livetv:admin:show-hidden';

export class ChannelStore {
    /** The ONE canonical category list. Replaces ChannelTable.dndCategories. */
    categories = $state<AdminChannelCategory[]>([]);

    /**
     * Whole-install lookup for viewer-visibility badges. Derived here rather than
     * per CategoryGroup: a backup group's primary can live in any category, so
     * every group would otherwise rebuild the same ~600-entry index — once per
     * category, per pane, on every edit.
     */
    channelIndex = $derived(buildChannelIndex(this.categories));

    /** Selection (reactive set; mutate via add/delete/clear — never reassign). */
    selectedIds = new SvelteSet<string>();
    isSelectionMode = $state(false);
    bulkActionInFlight = $state(false);

    /**
     * Show channels marked hidden (a lineup's other countries, lower-quality feeds)?
     * Shared by both panes so a drag reconciles the same way in each. Off by default;
     * remembered per browser (loadShowHidden, client only).
     */
    showHidden = $state(false);

    /**
     * Channels hidden in this session while hidden channels are out of view: they
     * stay on screen (dimmed) so a hide can be undone where it happened, until the
     * switch is toggled.
     */
    keepShown = new SvelteSet<string>();

    /** Which categories are expanded — SHARED across panes so open/close stays in sync. */
    expandedMap = $state<Record<string, boolean>>({});

    // Persistence + status (rendered, so reactive).
    isSaving = $state(false);
    showSaved = $state(false);
    undoState = $state<UndoState | null>(null);

    // Right-click / keyboard / touch context menu (rendered by ChannelTable).
    contextMenu = $state<ContextMenuState | null>(null);
    // Polite screen-reader announcement for drag-free moves + keyboard reorder.
    announcement = $state('');

    // Non-reactive bookkeeping.
    private snapshot: AdminChannelCategory[] | null = null;
    // The order the last successful save stored (sortOrder = index): the baseline
    // for "what changed", so rows a save already renumbered are not sent again.
    private stored: AdminChannelCategory[] | null = null;
    private saveTimeout: ReturnType<typeof setTimeout> | null = null;
    private savedTimeout: ReturnType<typeof setTimeout> | null = null;
    private announceTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSeededRef: AdminChannelCategory[] | null = null;

    // Group-drag lifecycle (captured at drag start via the first consider event):
    //   null  → no drag active
    //   []    → a drag is active but it's a single-channel drag (not a group)
    //   [ids] → a multi-select group drag, in visual order
    private dragGroupIds: string[] | null = null;
    private dragLeaderId: string | null = null;
    // True once the current drag has been committed (on the landing zone), so the source
    // zone's finalize for the same drag is ignored.
    private dropCommitted = false;

    selectedCount = $derived(this.selectedIds.size);

    /** True while a save is in flight/pending — used to avoid clobbering optimistic state.
     *  (The page fetches `categories` once on mount and never re-invalidates, so there is no
     *  mid-drag refetch to additionally guard against here.) */
    get isMutating(): boolean {
        return this.saveTimeout !== null || this.isSaving;
    }

    // =========================================================================
    // Seeding (imperative, NOT $derived) — a benign prop/refetch must not clobber
    // an in-flight optimistic mutation or drag.
    // =========================================================================

    seed(incoming: AdminChannelCategory[]): void {
        if (incoming === this.lastSeededRef) return;
        if (this.isMutating) return;
        this.lastSeededRef = incoming;
        this.categories = cloneCategories(incoming);
        this.stored = null;
        this.syncExpandDefaults();
    }

    loadShowHidden(): void {
        try {
            this.showHidden = localStorage.getItem(SHOW_HIDDEN_KEY) === '1';
        } catch {
            // Storage blocked: keep the default.
        }
    }

    setShowHidden(value: boolean): void {
        this.showHidden = value;
        this.keepShown.clear();
        // Leaving channels out of view also leaves them out of the selection.
        if (!value) {
            for (const ch of this.categories.flatMap((c) => c.channels)) {
                if (!ch.isVisible) this.selectedIds.delete(ch.id);
            }
        }
        try {
            localStorage.setItem(SHOW_HIDDEN_KEY, value ? '1' : '0');
        } catch {
            // Storage blocked: the choice lasts for this page only.
        }
    }

    /** Channels a selection or move acts on as seen: hidden ones only when shown. */
    private isShown(ch: AdminChannel): boolean {
        return this.showHidden || ch.isVisible || this.keepShown.has(ch.id);
    }

    /** Keep channels just hidden on screen while hidden channels are out of view. */
    private keepOnScreen(ids: Iterable<string>): void {
        if (this.showHidden) return;
        for (const id of ids) this.keepShown.add(id);
    }

    /** With hidden channels out of view, a move carries the hidden feeds behind each channel. */
    private withFollowers(ids: string[]): string[] {
        return this.showHidden
            ? ids
            : withHiddenFollowers(this.categories, ids, (ch) => !this.isShown(ch));
    }

    // =========================================================================
    // Expand / collapse (shared across panes)
    // =========================================================================

    /** Toggle a category open/closed — both panes reflect it because the map is shared. */
    toggleCategory(categoryId: string): void {
        this.expandedMap[categoryId] = !this.expandedMap[categoryId];
    }

    isExpanded(categoryId: string): boolean {
        return this.expandedMap[categoryId] ?? false;
    }

    /** Give every category an expand entry (default: expanded when ≤100 channels total),
     *  and drop entries for categories that no longer exist. */
    private syncExpandDefaults(): void {
        const total = this.categories.reduce((n, c) => n + c.channels.length, 0);
        const def = total <= 100;
        for (const cat of this.categories) {
            if (!(cat.id in this.expandedMap)) this.expandedMap[cat.id] = def;
        }
        for (const id of Object.keys(this.expandedMap)) {
            if (!this.categories.some((c) => c.id === id)) delete this.expandedMap[id];
        }
    }

    // =========================================================================
    // Selection
    // =========================================================================

    enterSelectionMode(): void {
        this.isSelectionMode = true;
    }

    exitSelectionMode(): void {
        this.isSelectionMode = false;
        this.selectedIds.clear();
    }

    toggleSelect(channelId: string): void {
        if (this.selectedIds.has(channelId)) this.selectedIds.delete(channelId);
        else this.selectedIds.add(channelId);
    }

    selectAllInCategory(categoryId: string): void {
        const cat = this.categories.find((c) => c.id === categoryId);
        if (!cat) return;
        const shown = cat.channels.filter((ch) => this.isShown(ch));
        const allSelected = shown.every((ch) => this.selectedIds.has(ch.id));
        if (allSelected) for (const ch of shown) this.selectedIds.delete(ch.id);
        else for (const ch of shown) this.selectedIds.add(ch.id);
    }

    /** Select all channels across all categories, or clear if everything is already selected. */
    toggleSelectAll(): void {
        const allIds = this.categories.flatMap((c) =>
            c.channels.filter((ch) => this.isShown(ch)).map((ch) => ch.id),
        );
        const allSelected = allIds.length > 0 && allIds.every((id) => this.selectedIds.has(id));
        if (allSelected) this.selectedIds.clear();
        else for (const id of allIds) this.selectedIds.add(id);
    }

    allSelected(): boolean {
        return (
            this.selectedCount > 0 &&
            this.categories.every((cat) =>
                cat.channels.every((ch) => !this.isShown(ch) || this.selectedIds.has(ch.id)),
            )
        );
    }

    // =========================================================================
    // New category
    // =========================================================================

    /** Create a category; returns its id (the caller decides whether to expand it). */
    async createCategory(name: string): Promise<string | null> {
        const trimmed = name.trim();
        if (!trimmed) return null;

        const { data, error } = await apiPost(
            '/api/admin/livetv/categories',
            CreateCategoryResponseSchema,
            { name: trimmed },
        );

        if (error || !data) {
            toasts.error(m.admin_livetv_category_create_error());
            return null;
        }

        const newCat: AdminChannelCategory = {
            id: data.id,
            name: data.name,
            sortOrder: data.sortOrder,
            isVisible: true,
            channels: [],
        };
        this.categories = [...this.categories, newCat];
        this.expandedMap[data.id] = true;
        return data.id;
    }

    // =========================================================================
    // Category rename / merge / delete
    // =========================================================================

    async renameCategory(categoryId: string, newName: string): Promise<void> {
        const previous = cloneCategories(this.categories);
        this.categories = this.categories.map((cat) =>
            cat.id === categoryId ? { ...cat, name: newName } : cat,
        );

        const { error } = await apiPut(
            `/api/admin/livetv/categories/${categoryId}`,
            CategoryUpdateResponseSchema,
            { name: newName },
        );

        if (error) {
            this.categories = previous;
            toasts.error(m.admin_livetv_category_rename_error());
        }
    }

    async mergeCategory(sourceCategoryId: string, targetCategoryId: string): Promise<void> {
        const previous = cloneCategories(this.categories);
        const sourceCat = this.categories.find((c) => c.id === sourceCategoryId);
        if (!sourceCat) return;

        this.categories = this.categories
            .map((cat) =>
                cat.id === targetCategoryId
                    ? { ...cat, channels: [...cat.channels, ...sourceCat.channels] }
                    : cat,
            )
            .filter((cat) => cat.id !== sourceCategoryId);

        const { error } = await apiPost(
            `/api/admin/livetv/categories/${sourceCategoryId}/merge`,
            MergeCategoryResponseSchema,
            { targetCategoryId },
        );

        if (error) {
            this.categories = previous;
            toasts.error(m.admin_livetv_category_merge_error());
        }
    }

    async deleteCategory(categoryId: string): Promise<void> {
        const cat = this.categories.find((c) => c.id === categoryId);
        if (!cat || cat.channels.length > 0) return;

        const previous = cloneCategories(this.categories);
        const categoryName = cat.name;

        this.categories = this.categories.filter((c) => c.id !== categoryId);

        let undone = false;
        const timeout = setTimeout(async () => {
            if (undone) return;
            const { error } = await apiDelete(
                `/api/admin/livetv/categories/${categoryId}`,
                LiveTvAckResponseSchema,
            );
            if (error) {
                toasts.error(m.admin_livetv_category_delete_error());
            }
        }, 5000);

        this.showUndoToast(
            m.admin_livetv_category_deleted_undo({ name: categoryName }),
            async () => {
                undone = true;
                clearTimeout(timeout);
                this.categories = previous;
            },
        );
    }

    // =========================================================================
    // Undo toast
    // =========================================================================

    showUndoToast(message: string, reverseAction: () => Promise<void>): void {
        if (this.undoState) {
            clearTimeout(this.undoState.timeout);
            this.undoState = null;
        }
        const timeout = setTimeout(() => {
            this.undoState = null;
        }, 5000);
        this.undoState = { message, reverseAction, timeout };
    }

    async performUndo(): Promise<void> {
        if (!this.undoState) return;
        clearTimeout(this.undoState.timeout);
        const action = this.undoState.reverseAction;
        this.undoState = null;
        await action();
    }

    // =========================================================================
    // Channel numbers. A number belongs to a station (all feeds of its backup
    // group), and a swap or a category's start number moves other rows too, so
    // a change reloads the list (onNumbersChanged) instead of patching it here.
    // =========================================================================

    /** Set by the page: reload the channel list after a number change. */
    onNumbersChanged: (() => void) | null = null;

    /** Gives a channel's station this number (pinned). Asks before taking another station's. */
    async setChannelNumber(channelId: string, number: number): Promise<boolean> {
        const url = `/api/admin/livetv/channels/${channelId}/number`;
        let result = await apiPut(url, ChannelNumberResponseSchema, { number });
        if (result.status === 409) {
            const holder = typeof result.details === 'string' ? result.details : '';
            const question = holder
                ? m.admin_livetv_number_swap_confirm({ number: String(number), name: holder })
                : m.admin_livetv_number_swap_confirm_unnamed({ number: String(number) });
            if (!confirm(question)) return false;
            result = await apiPut(url, ChannelNumberResponseSchema, { number, swap: true });
        }
        if (result.error) {
            toasts.error(m.admin_livetv_number_save_error());
            return false;
        }
        this.onNumbersChanged?.();
        return true;
    }

    /** Hands a station's number back to automatic numbering. */
    async unpinChannelNumber(channelId: string): Promise<void> {
        const { error } = await apiDelete(
            `/api/admin/livetv/channels/${channelId}/number`,
            ChannelUpdatedResponseSchema,
        );
        if (error) {
            toasts.error(m.admin_livetv_number_save_error());
            return;
        }
        this.onNumbersChanged?.();
    }

    /** A category's "Numbers start at" (0 removes it). */
    async setCategoryNumberStart(categoryId: string, numberStart: number): Promise<void> {
        const { error } = await apiPut(
            `/api/admin/livetv/categories/${categoryId}`,
            CategoryUpdateResponseSchema,
            { numberStart },
        );
        if (error) {
            toasts.error(m.admin_livetv_number_save_error());
            return;
        }
        this.onNumbersChanged?.();
    }

    // =========================================================================
    // Single-channel mutations
    // =========================================================================

    /** Clears a feed's failure streak; the feed shows as ok again (and reappears for viewers). */
    async resetHealth(channelId: string): Promise<boolean> {
        const { data, error } = await apiPost(
            `/api/admin/livetv/channels/${channelId}/health/reset`,
            LiveTvChannelHealthSchema,
        );
        if (error || !data) {
            toasts.error(m.admin_livetv_health_reset_error());
            return false;
        }
        this.categories = this.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.map((ch) =>
                ch.id === channelId ? { ...ch, health: data } : ch,
            ),
        }));
        toasts.success(m.admin_livetv_health_reset_done());
        return true;
    }

    async updateName(channelId: string, newName: string): Promise<void> {
        const previous = cloneCategories(this.categories);
        this.categories = this.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.map((ch) =>
                ch.id === channelId ? { ...ch, adminDisplayName: newName } : ch,
            ),
        }));

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}`,
            ChannelUpdatedResponseSchema,
            { adminDisplayName: newName },
        );

        if (error) {
            this.categories = previous;
            toasts.error(m.admin_livetv_name_save_error());
        }
    }

    async updateQuality(channelId: string, newTier: string): Promise<void> {
        const previous = cloneCategories(this.categories);
        this.categories = this.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.map((ch) =>
                ch.id === channelId
                    ? { ...ch, qualityTier: newTier as AdminChannel['qualityTier'] }
                    : ch,
            ),
        }));

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}`,
            ChannelUpdatedResponseSchema,
            { qualityTier: newTier },
        );

        if (error) {
            this.categories = previous;
            toasts.error(m.admin_livetv_quality_save_error());
        }
    }

    async toggleVisibility(channelId: string, newState: boolean): Promise<void> {
        if (!newState) this.keepOnScreen([channelId]);
        this.categories = this.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.map((ch) =>
                ch.id === channelId ? { ...ch, isVisible: newState } : ch,
            ),
        }));

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}`,
            ChannelUpdatedResponseSchema,
            { isVisible: newState },
        );

        if (error) {
            this.categories = this.categories.map((cat) => ({
                ...cat,
                channels: cat.channels.map((ch) =>
                    ch.id === channelId ? { ...ch, isVisible: !newState } : ch,
                ),
            }));
            toasts.error(m.admin_livetv_visibility_toggle_error());
        }
    }

    // =========================================================================
    // Category visibility (category + all its channels)
    // =========================================================================

    async toggleCategoryVisibility(categoryId: string, newState: boolean): Promise<void> {
        const cat = this.categories.find((c) => c.id === categoryId);
        if (!cat) return;

        const previousStates = cat.channels.map((ch) => ({ id: ch.id, isVisible: ch.isVisible }));
        const previousCatVisible = cat.isVisible;

        if (!newState) this.keepOnScreen(cat.channels.map((ch) => ch.id));
        const applyState = (visible: boolean): void => {
            this.categories = this.categories.map((c) =>
                c.id === categoryId
                    ? {
                          ...c,
                          isVisible: visible,
                          channels: c.channels.map((ch) => ({ ...ch, isVisible: visible })),
                      }
                    : c,
            );
        };

        const restore = (): void => {
            this.categories = this.categories.map((c) =>
                c.id === categoryId
                    ? {
                          ...c,
                          isVisible: previousCatVisible,
                          channels: c.channels.map((ch) => {
                              const prev = previousStates.find((p) => p.id === ch.id);
                              return prev ? { ...ch, isVisible: prev.isVisible } : ch;
                          }),
                      }
                    : c,
            );
        };

        applyState(newState);

        const { error } = await apiPut(
            `/api/admin/livetv/categories/${categoryId}`,
            CategoryUpdateResponseSchema,
            { isVisible: newState },
        );

        if (error) {
            restore();
            toasts.error(m.admin_livetv_bulk_error());
            return;
        }

        const count = cat.channels.length;
        const undoMessage = newState
            ? m.admin_livetv_bulk_show_undo({ count })
            : m.admin_livetv_bulk_hide_undo({ count });

        this.showUndoToast(undoMessage, async () => {
            await apiPut(
                `/api/admin/livetv/categories/${categoryId}`,
                CategoryUpdateResponseSchema,
                {
                    isVisible: previousCatVisible,
                },
            );
            restore();
        });
    }

    // =========================================================================
    // Bulk operations (selection)
    // =========================================================================

    async executeBulkAction(
        action: BulkAction,
        extra?: { qualityTier?: string; categoryId?: string },
    ): Promise<void> {
        if (this.bulkActionInFlight) return;
        const channelIds = [...this.selectedIds];
        if (channelIds.length === 0) return;
        this.bulkActionInFlight = true;
        if (action === 'hide') this.keepOnScreen(channelIds);

        const previousStates = new Map<string, Partial<AdminChannel>>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- local rollback temp, not reactive state
        for (const cat of this.categories) {
            for (const ch of cat.channels) {
                if (this.selectedIds.has(ch.id)) {
                    previousStates.set(ch.id, {
                        isVisible: ch.isVisible,
                        qualityTier: ch.qualityTier,
                        categoryId: ch.categoryId,
                    });
                }
            }
        }

        this.categories = this.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.map((ch) => {
                if (!this.selectedIds.has(ch.id)) return ch;
                switch (action) {
                    case 'hide':
                        return { ...ch, isVisible: false };
                    case 'show':
                        return { ...ch, isVisible: true };
                    case 'setQuality':
                        return {
                            ...ch,
                            qualityTier: extra?.qualityTier as AdminChannel['qualityTier'],
                        };
                    case 'moveToCategory':
                        return { ...ch, categoryId: extra?.categoryId };
                    default:
                        return ch;
                }
            }),
        }));

        const { error } = await apiPut(
            '/api/admin/livetv/channels/bulk',
            BulkChannelUpdateResponseSchema,
            {
                channelIds,
                action,
                ...extra,
            },
        );

        if (error) {
            this.categories = this.categories.map((cat) => ({
                ...cat,
                channels: cat.channels.map((ch) => {
                    const prev = previousStates.get(ch.id);
                    return prev ? { ...ch, ...prev } : ch;
                }),
            }));
            toasts.error(m.admin_livetv_bulk_error());
            this.bulkActionInFlight = false;
            return;
        }

        const count = channelIds.length;
        let undoMessage: string;
        switch (action) {
            case 'hide':
                undoMessage = m.admin_livetv_bulk_hide_undo({ count });
                break;
            case 'show':
                undoMessage = m.admin_livetv_bulk_show_undo({ count });
                break;
            case 'moveToCategory': {
                const catName = this.categories.find((c) => c.id === extra?.categoryId)?.name ?? '';
                undoMessage = m.admin_livetv_bulk_moved_undo({ count, category: catName });
                break;
            }
            case 'setQuality':
                undoMessage = m.admin_livetv_bulk_quality_undo({
                    count,
                    quality: (extra?.qualityTier ?? '').toUpperCase(),
                });
                break;
        }

        this.showUndoToast(undoMessage, async () => {
            if (action === 'hide' || action === 'show') {
                const reverseAction = action === 'hide' ? 'show' : 'hide';
                await apiPut('/api/admin/livetv/channels/bulk', BulkChannelUpdateResponseSchema, {
                    channelIds,
                    action: reverseAction,
                });
            } else {
                const revertPromises = channelIds.map((id) => {
                    const prev = previousStates.get(id);
                    if (!prev) return Promise.resolve();
                    const revertData: Record<string, unknown> = {};
                    if (action === 'setQuality')
                        revertData.qualityTier = prev.qualityTier ?? undefined;
                    if (action === 'moveToCategory')
                        revertData.categoryId = prev.categoryId ?? undefined;
                    if (Object.keys(revertData).length === 0) return Promise.resolve();
                    return apiPut(
                        `/api/admin/livetv/channels/${id}`,
                        ChannelUpdatedResponseSchema,
                        revertData,
                    );
                });
                await Promise.all(revertPromises);
            }
            this.categories = this.categories.map((cat) => ({
                ...cat,
                channels: cat.channels.map((ch) => {
                    const prev = previousStates.get(ch.id);
                    return prev ? { ...ch, ...prev } : ch;
                }),
            }));
        });

        this.selectedIds.clear();
        this.bulkActionInFlight = false;
    }

    bulkHide(): void {
        void this.executeBulkAction('hide');
    }
    bulkShow(): void {
        void this.executeBulkAction('show');
    }
    /**
     * Move the selection into a category, at its end or top. A plain reorder save
     * (category + position) rather than the bulk endpoint, which only rewrote the
     * category field and left the channels listed under their old category.
     */
    bulkMoveToCategory(categoryId: string, position: 'top' | 'bottom' = 'bottom'): void {
        // A bulk hide/show/quality request in flight would roll back over the moved rows.
        if (this.bulkActionInFlight) return;
        const ids: string[] = [];
        for (const cat of this.categories) {
            for (const ch of cat.channels) if (this.selectedIds.has(ch.id)) ids.push(ch.id);
        }
        if (ids.length === 0) return;
        this.relocateChannels(ids, categoryId, position);
        this.selectedIds.clear();
    }
    bulkSetQuality(qualityTier: string): void {
        void this.executeBulkAction('setQuality', { qualityTier });
    }

    // =========================================================================
    // Category reorder (drag + keyboard)
    // =========================================================================

    /** Live drag preview from the category-level dndzone consider event. */
    setCategoriesDuringDrag(items: AdminChannelCategory[]): void {
        this.categories = withFullChannels(this.categories, items);
    }

    /** Finalize category reorder; persist. */
    finalizeCategoryReorder(items: AdminChannelCategory[]): void {
        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = withFullChannels(this.categories, items);
        this.debouncedSave();
    }

    reorderCategories(index: number, direction: 'up' | 'down'): void {
        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= this.categories.length) return;
        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        const updated = [...this.categories];
        const [moved] = updated.splice(index, 1);
        updated.splice(newIndex, 0, moved);
        this.categories = updated;
        this.debouncedSave();
    }

    /**
     * Move a category by id (header menu, keyboard, category rail): works whether
     * categories are expanded or filtered, unlike the index-based drag above. Only
     * the category order is saved; channel positions do not change.
     */
    moveCategory(categoryId: string, move: CategoryMove): void {
        const next = planCategoryMove(this.categories, categoryId, move);
        if (next === this.categories) return;
        this.commitCategoryOrder(next, categoryId);
    }

    /** New category order from a drag in the category rail (ids top to bottom). */
    reorderCategoriesByIds(orderedIds: string[], movedId?: string): void {
        const next = orderCategoriesByIds(this.categories, orderedIds);
        if (next.every((c, i) => c.id === this.categories[i]?.id)) return;
        this.commitCategoryOrder(next, movedId);
    }

    private commitCategoryOrder(next: AdminChannelCategory[], movedId?: string): void {
        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = next;
        this.debouncedSave();
        const index = next.findIndex((c) => c.id === movedId);
        if (index >= 0) {
            const cat = next[index];
            this.announce(
                m.admin_livetv_category_moved_announce({
                    name: cat.id === UNCATEGORIZED_ID ? m.admin_livetv_uncategorized() : cat.name,
                    position: index + 1,
                    total: next.length,
                }),
            );
        }
    }

    // =========================================================================
    // Channel reorder within a category (from CategoryGroup)
    // =========================================================================

    /** Count shown on a selected row's drag badge (0 unless a multi-select group exists). */
    get groupDragCount(): number {
        return this.isSelectionMode && this.selectedIds.size > 1 ? this.selectedIds.size : 0;
    }

    /**
     * Called on every channel-drag consider event. On the drag-start trigger it captures
     * whether this is a multi-select GROUP drag (and the group's visual order), snapshotting
     * so the decision stays stable across the source/destination finalize events even after
     * the selection is cleared on commit. Other consider triggers are ignored.
     */
    noteChannelDragConsider(leaderId: string, trigger: string): void {
        if (trigger !== 'dragStarted') return;

        this.dropCommitted = false;
        this.dragLeaderId = leaderId;
        if (this.isSelectionMode && this.selectedIds.size > 1 && this.selectedIds.has(leaderId)) {
            const order: string[] = [];
            for (const cat of this.categories) {
                for (const ch of cat.channels) if (this.selectedIds.has(ch.id)) order.push(ch.id);
            }
            this.dragGroupIds = order;
        } else {
            this.dragGroupIds = []; // single-channel drag
        }
    }

    /**
     * Channel drag finalize. `leaderId` is the grabbed channel (svelte-dnd-action info.id).
     *
     * A drag — single OR multi-select group — is committed EXACTLY ONCE, on the zone where the
     * grabbed channel actually landed (the only zone whose payload contains `leaderId`). That
     * single commit (planGroupMove) removes the moved channel(s) from wherever they were and
     * inserts them at the drop slot. The source zone(s) also fire finalize (payload without the
     * leader) but are ignored — committing them too would re-apply a "channel removed" list and,
     * when the same category is shown in both split panes, delete the channel entirely.
     */
    applyChannelDrop(
        categoryId: string,
        items: AdminChannel[],
        leaderId: string,
        query: string | PaneFilter,
        trigger?: string,
    ): void {
        // Drag aborted (released outside any zone): svelte-dnd-action restores the item to its
        // origin, so there is nothing to persist.
        if (trigger === 'droppedOutsideOfAny') return;

        const payload = items.filter((ch) => ch.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        const landedHere = payload.some((ch) => ch.id === leaderId);
        // Only the landing zone commits; ignore source-zone finalizes and any duplicate.
        if (!landedHere || this.dropCommitted) return;

        // The moved set: the multi-select group captured for THIS drag's leader, else just the
        // leader. The dragLeaderId match guards against ever reusing a stale group if a finalize
        // were to arrive without a preceding 'dragStarted' consider.
        const draggedIds =
            this.dragGroupIds && this.dragGroupIds.length > 1 && this.dragLeaderId === leaderId
                ? this.dragGroupIds
                : [leaderId];
        const filter = normalizeFilter(query);
        // Hidden feeds behind a dragged channel go with it, also into another category.
        const groupIds = filter.hideHidden
            ? withHiddenFollowers(
                  this.categories,
                  draggedIds,
                  (ch) => !channelMatches(ch, { query: '', hideHidden: true, keep: filter.keep }),
              )
            : draggedIds;

        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = planGroupMove(
            this.categories,
            groupIds,
            leaderId,
            categoryId,
            payload,
            filter,
            UNCATEGORIZED_ID,
        );
        this.dropCommitted = true;
        this.debouncedSave();
        if (draggedIds.length > 1) this.selectedIds.clear();
    }

    /**
     * Reconcile a single category's channel list (used by keyboard reorder, which never crosses
     * categories or panes so there is no competing finalize). `items` is the new visible order;
     * hidden (filtered-out) channels are preserved via reconcileCategoryChannels.
     */
    applyChannelZone(categoryId: string, items: AdminChannel[], query: string | PaneFilter): void {
        const cat = this.categories.find((c) => c.id === categoryId);
        if (!cat) return;

        const payload = items.filter((ch) => ch.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        const destCategoryId = categoryId === UNCATEGORIZED_ID ? undefined : categoryId;
        // Stamp the destination category onto the visible channels (no-op for ones already here).
        const stamped = payload.map((ch) =>
            ch.categoryId === destCategoryId ? ch : { ...ch, categoryId: destCategoryId },
        );

        const newChannels = reconcileCategoryChannels(
            cat.channels,
            stamped,
            normalizeFilter(query),
        );

        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = this.categories.map((c) =>
            c.id === categoryId ? { ...c, channels: newChannels } : c,
        );
        this.debouncedSave();
    }

    // =========================================================================
    // Context menu (right-click / Shift+F10 / touch ⋯) — drag-free relocation
    // =========================================================================

    openContextMenu(channelId: string, x: number, y: number): void {
        this.contextMenu = { channelId, x, y };
    }

    closeContextMenu(): void {
        this.contextMenu = null;
    }

    channelById(channelId: string): AdminChannel | undefined {
        for (const cat of this.categories) {
            const found = cat.channels.find((ch) => ch.id === channelId);
            if (found) return found;
        }
        return undefined;
    }

    private categoryOf(channelId: string): string {
        for (const cat of this.categories) {
            if (cat.channels.some((ch) => ch.id === channelId)) return cat.id;
        }
        return UNCATEGORIZED_ID;
    }

    /**
     * The channels a context action operates on: the whole selection when the right-clicked
     * row is part of a multi-selection, otherwise just that row. Returned in visual order.
     */
    private contextTargets(channelId: string): string[] {
        if (this.isSelectionMode && this.selectedIds.has(channelId) && this.selectedIds.size > 1) {
            const order: string[] = [];
            for (const cat of this.categories) {
                for (const ch of cat.channels) if (this.selectedIds.has(ch.id)) order.push(ch.id);
            }
            return order;
        }
        return [channelId];
    }

    /** How many channels a context action would affect (for menu labels). */
    contextTargetCount(channelId: string): number {
        return this.contextTargets(channelId).length;
    }

    contextMoveToTop(channelId: string): void {
        this.moveContextTargetsToEdge(channelId, 'top');
    }

    contextMoveToBottom(channelId: string): void {
        this.moveContextTargetsToEdge(channelId, 'bottom');
    }

    contextMoveToCategory(
        channelId: string,
        destCategoryId: string,
        position: 'top' | 'bottom' = 'bottom',
    ): void {
        this.relocateContextTargets(channelId, destCategoryId, position);
    }

    /** Move each target to the top/bottom of ITS OWN category (no category change) so a
     *  multi-category selection isn't yanked into the clicked row's category. */
    private moveContextTargetsToEdge(channelId: string, position: 'top' | 'bottom'): void {
        const ids = this.contextTargets(channelId);
        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = planMoveToOwnEdge(this.categories, this.withFollowers(ids), position);
        this.debouncedSave();
        this.announce(
            position === 'top'
                ? m.admin_livetv_context_moved_top_announce({ count: ids.length })
                : m.admin_livetv_context_moved_bottom_announce({ count: ids.length }),
        );
        if (ids.length > 1) this.selectedIds.clear();
        this.closeContextMenu();
    }

    private relocateContextTargets(
        channelId: string,
        destCategoryId: string,
        position: 'top' | 'bottom',
    ): void {
        const ids = this.contextTargets(channelId);
        this.relocateChannels(ids, destCategoryId, position);
        if (ids.length > 1) this.selectedIds.clear();
        this.closeContextMenu();
    }

    /** Move `ids` (visual order) into a category at its top or end; persist + announce. */
    private relocateChannels(
        ids: string[],
        destCategoryId: string,
        position: 'top' | 'bottom',
    ): void {
        if (!this.snapshot) this.snapshot = cloneCategories(this.categories);
        this.categories = planMoveToCategory(
            this.categories,
            this.withFollowers(ids),
            destCategoryId,
            position,
            UNCATEGORIZED_ID,
        );
        this.debouncedSave();
        const destName =
            destCategoryId === UNCATEGORIZED_ID
                ? m.admin_livetv_uncategorized()
                : (this.categories.find((c) => c.id === destCategoryId)?.name ?? '');
        this.announce(
            m.admin_livetv_context_moved_announce({ count: ids.length, category: destName }),
        );
    }

    contextToggleVisibility(channelId: string): void {
        const ids = this.contextTargets(channelId);
        const newState = !(this.channelById(channelId)?.isVisible ?? true);
        if (ids.length > 1) {
            void this.executeBulkAction(newState ? 'show' : 'hide');
        } else {
            void this.toggleVisibility(channelId, newState);
        }
        this.closeContextMenu();
    }

    contextSetQuality(channelId: string, tier: string): void {
        const ids = this.contextTargets(channelId);
        if (ids.length > 1) void this.executeBulkAction('setQuality', { qualityTier: tier });
        else void this.updateQuality(channelId, tier);
        this.closeContextMenu();
    }

    /**
     * The feeds of the backup group `channelId` belongs to, in the viewer rank
     * (the feed viewers get first). Only the feeds in this payload — a
     * source-filtered view can miss some. Empty for an ungrouped channel.
     */
    groupFeeds(channelId: string): AdminChannel[] {
        const groupId = this.channelById(channelId)?.backupGroupId;
        if (!groupId) return [];
        return [...this.channelIndex.byId.values()]
            .filter((ch) => ch.backupGroupId === groupId)
            .sort(compareGroupFeeds);
    }

    /**
     * Make `channelId` the primary of its backup group — the feed viewers get
     * while it is visible. Optimistic: every member row learns the new primary
     * at once and rolls back when the server refuses.
     */
    async setGroupPrimary(channelId: string): Promise<void> {
        const channel = this.channelById(channelId);
        const groupId = channel?.backupGroupId;
        if (!channel || !groupId || channel.groupPrimaryChannelId === channelId) return;
        const previous = channel.groupPrimaryChannelId;
        const assign = (primary: string | undefined): void => {
            this.categories = this.categories.map((cat) => ({
                ...cat,
                channels: cat.channels.map((ch) =>
                    ch.backupGroupId === groupId ? { ...ch, groupPrimaryChannelId: primary } : ch,
                ),
            }));
        };
        assign(channelId);

        const { error } = await apiPut(
            `/api/admin/livetv/backup-groups/${groupId}/primary`,
            LiveTvAckResponseSchema,
            { channelId },
        );
        const name = channel.adminDisplayName ?? channel.name;
        if (error) {
            assign(previous);
            toasts.error(m.admin_livetv_feed_primary_failed());
        } else {
            this.announce(m.admin_livetv_feed_primary_saved({ name }));
        }
    }

    contextSelect(channelId: string): void {
        if (!this.isSelectionMode) this.enterSelectionMode();
        this.toggleSelect(channelId);
        this.closeContextMenu();
    }

    /** Set a polite screen-reader announcement. Clears first so an identical repeat message
     *  still changes the aria-live region content and is re-announced. */
    announce(message: string): void {
        if (this.announceTimer) clearTimeout(this.announceTimer);
        this.announcement = '';
        this.announceTimer = setTimeout(() => {
            this.announcement = message;
            this.announceTimer = null;
        }, 30);
    }

    // =========================================================================
    // Debounced batch persistence
    // =========================================================================

    debouncedSave(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => void this.persistReorder(), 500);
    }

    private async persistReorder(): Promise<void> {
        this.saveTimeout = null;

        // Nothing to persist (e.g. no categories at all) — the request body would be empty and
        // the endpoint's schema rejects it, so skip rather than toast a spurious error.
        if (this.categories.length === 0) {
            this.snapshot = null;
            return;
        }

        this.isSaving = true;
        this.showSaved = false;

        const categoryUpdates = this.categories.map((cat, idx) => ({ id: cat.id, sortOrder: idx }));

        const sent = cloneCategories(this.categories);
        const channelUpdates = changedChannelUpdates(
            this.stored ?? this.snapshot,
            sent,
            'uncategorized',
        );

        const { error } = await apiPut(
            '/api/admin/livetv/channels/reorder',
            ChannelsReorderedResponseSchema,
            {
                channels: channelUpdates.length > 0 ? channelUpdates : undefined,
                categories: categoryUpdates.length > 0 ? categoryUpdates : undefined,
            },
        );

        this.isSaving = false;

        if (error) {
            if (this.snapshot) this.categories = cloneCategories(this.snapshot);
            this.snapshot = null;
            // The rollback also undoes an edit made meanwhile: drop its pending save.
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            toasts.error(m.admin_livetv_reorder_error());
        } else {
            // Another save pending (an edit made while this one was in flight): its diff
            // starts from what THIS request stored, never from the live state, which
            // already holds the newer edit and would diff to "nothing changed".
            this.stored = storedOrder(sent);
            if (this.saveTimeout) this.snapshot = this.stored;
            else this.snapshot = null;
            this.showSaved = true;
            if (this.savedTimeout) clearTimeout(this.savedTimeout);
            this.savedTimeout = setTimeout(() => {
                this.showSaved = false;
            }, 2000);
        }
    }
}

// =============================================================================
// Context distribution — one store shared by ChannelTable and its ChannelPane(s).
// =============================================================================

const CHANNEL_STORE_KEY = Symbol('livetvChannelStore');

/** Call during ChannelTable init to share its store with descendant panes. */
export function setChannelStore(store: ChannelStore): void {
    setContext(CHANNEL_STORE_KEY, store);
}

/** Call during a descendant component's init to read the shared store. */
export function getChannelStore(): ChannelStore {
    const store = getContext<ChannelStore | undefined>(CHANNEL_STORE_KEY);
    if (!store) throw new Error('ChannelStore context missing — render inside <ChannelTable>');
    return store;
}
