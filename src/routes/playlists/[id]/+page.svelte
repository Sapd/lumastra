<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet, SvelteDate, SvelteMap } from 'svelte/reactivity';

    import * as m from '$lib/paraglide/messages.js';
    import {
        isMovie,
        isSeries,
        isEpisode,
        isMusic,
        isAudioTrack,
        isAudiobook,
    } from '$lib/shared/media-types';
    import { dndzone, TRIGGERS, SOURCES, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { onMount, onDestroy } from 'svelte';
    import {
        Icon,
        QueueList,
        Check,
        Trash,
        Bars3,
        XMark,
        Film,
        Tv,
        ChevronDown,
        ChevronRight,
        LightBulb,
        MusicalNote,
        BookOpen,
        Play,
    } from 'svelte-hero-icons';
    import { openMediaModal, openAlbumModal, openArtistModal } from '$lib/utils/modal-utils';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import { env } from '$env/dynamic/public';
    import WatchButton from '$lib/components/ui/WatchButton.svelte';
    import ItemWatchers from '$lib/components/playlist/ItemWatchers.svelte';
    import PlaylistChat from '$lib/components/playlist/PlaylistChat.svelte';
    import PlaylistHeader from '$lib/components/playlist/PlaylistHeader.svelte';
    import PlaylistMemberPanel from '$lib/components/playlist/PlaylistMemberPanel.svelte';
    import PlaylistSuggestions from '$lib/components/music/PlaylistSuggestions.svelte';
    import MusicLibraryTabs from '$lib/components/music/MusicLibraryTabs.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import Search from '$lib/Search.svelte';
    import type { PlaylistAddItem, PlaylistAddOutcome } from '$lib/types/playlist';
    import { imageFromIds, getCatalogPosterUrl, getCatalogThumbUrl } from '$lib/utils/image-utils';
    import { getPreferredExternalId, hasAnyId } from '$lib/utils/external-ids';
    import type { MemberProgress, ItemWatcher } from '$lib/types/playlist';
    import type { PlaylistEntry, PlaylistMember } from '$lib/types/api-playlists';
    import type { MusicTrack } from '$lib/schemas/music';
    import type { PageData } from './$types';
    import {
        buildTypedPlaylist,
        PLAYLIST_DETAIL_DEPENDENCY,
        type ServerPlaylist,
    } from './playlist-detail-transform';
    import { watchlistItems, watchlistState } from '$lib/stores/watchlist';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
    import * as playlistsApi from '$lib/api/playlists';
    import {
        applyPlaylistSummary,
        syncWatchlistStoreAdded,
        syncWatchlistStoreRemoved,
    } from '$lib/stores/playlists';

    import { stopPropagation } from '$lib/utils/event-helpers';
    import { requireValue } from '$lib/utils/runtime-validation';
    import {
        leaderIdsToCollapsedGroups,
        collapsedGroupsToLeaderIds,
        type CollapsedGroups,
    } from '$lib/utils/playlist/collapse-state';

    interface Props {
        data: PageData;
    }

    let { data = $bindable() }: Props = $props();

    // Type-safe accessors for server data. `ServerPlaylist` and
    // `buildTypedPlaylist` live in a sibling pure module (not declared here)
    // so the loader → Playlist conversion is unit-testable outside Svelte —
    // see playlist-detail-transform.ts for why.
    type ServerMember = PlaylistMember;

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    // Local mutable state for playlist and members (not $derived, so local
    // mutations trigger reactivity). Synced from page data on navigation.
    let serverPlaylist: ServerPlaylist = $state(data?.playlist as ServerPlaylist);
    let serverItems: PlaylistEntry[] = $state((data?.items || []) as PlaylistEntry[]);
    let serverMembers: ServerMember[] = $state((data?.members || []) as ServerMember[]);

    // Re-sync from page data when navigating to a different playlist or when data refreshes
    // Compared against the last page data seen, not against serverPlaylist: local
    // mutations update serverPlaylist's summary (revision, itemCount) and must not
    // look like fresh page data that replaces the local list.
    let lastIncomingKey = incomingKey(data?.playlist as ServerPlaylist | undefined);
    function incomingKey(p: ServerPlaylist | undefined): string {
        return p ? `${p.id}:${p.updatedAt}:${p.revision}` : '';
    }
    $effect(() => {
        const incoming = data?.playlist as ServerPlaylist | undefined;
        const key = incomingKey(incoming);
        if (incoming && key !== lastIncomingKey) {
            lastIncomingKey = key;
            serverPlaylist = incoming;
            const newItems = (data?.items || []) as PlaylistEntry[];
            serverItems = newItems;
            items = newItems.map((item) => ({ ...item, id: item.id }));
            serverMembers = (data?.members || []) as ServerMember[];
        }
    });

    // Live watchlist. A detail modal opened from this page (search results,
    // "similar" titles) adds/removes via its Watchlist button, which writes the
    // watchlist playlist server-side and updates the client store — but this
    // page's list came from its load and never heard about it. When this page
    // IS the watchlist, re-run the load whenever the store's set of titles
    // changes (the re-sync effect above then picks up the new updatedAt).
    let lastWatchlistKeys: string | null = null;
    $effect(() => {
        // The store's first hydration is not a change — wait for it.
        if ($watchlistState.loading) return;
        const keys = $watchlistItems
            .map((i) => mediaCompositeKey(i.externalIds, i.mediaType))
            .sort()
            .join('|');
        const changed = lastWatchlistKeys !== null && keys !== lastWatchlistKeys;
        lastWatchlistKeys = keys;
        if (changed && serverPlaylist?.playlistType === 'watchlist') {
            invalidateWhenIdle(PLAYLIST_DETAIL_DEPENDENCY);
        }
    });

    // Social progress data
    let memberProgress: MemberProgress[] = $state([]);
    let itemsWatchedBy: Record<number, ItemWatcher[]> = $state({});
    let loadingProgress = false;

    // Fetch social progress data
    async function loadProgressData(targetPlaylistId: number, isCurrent: () => boolean) {
        loadingProgress = true;
        try {
            const { data: progressData, error: progressErr } =
                await playlistsApi.getPlaylistProgress(targetPlaylistId);
            if (isCurrent() && !progressErr && progressData) {
                const result = progressData as {
                    members?: MemberProgress[];
                    itemsWatchedBy?: Record<number, ItemWatcher[]>;
                };
                memberProgress = Array.isArray(result?.members) ? result.members : [];
                itemsWatchedBy = isRecord(result?.itemsWatchedBy)
                    ? (result.itemsWatchedBy as Record<number, ItemWatcher[]>)
                    : {};
            }
        } catch (e) {
            console.error('Failed to load progress data:', e);
        } finally {
            if (isCurrent()) loadingProgress = false;
        }
    }

    $effect(() => {
        const targetPlaylistId = serverPlaylist.id;
        const shared = serverMembers.length > 0 || serverPlaylist.visibility === 'public';
        let current = true;
        memberProgress = [];
        itemsWatchedBy = {};
        if (shared) void loadProgressData(targetPlaylistId, () => current);
        return () => {
            current = false;
        };
    });

    onMount(() => {
        // Check if tutorial was dismissed
        const dismissed = localStorage.getItem(TUTORIAL_DISMISSED_KEY);
        if (!dismissed && data.canEdit && !serverPlaylist.isSystem) {
            showTutorial = true;
        }
    });

    function dismissTutorial() {
        showTutorial = false;
        localStorage.setItem(TUTORIAL_DISMISSED_KEY, 'true');
    }

    // Items with drag-and-drop IDs
    // svelte-dnd-action uses string IDs for placeholders, so we need string | number union
    type DndItem = PlaylistEntry & { id: number | string };

    // Editing state
    let editingName = $state(false);
    let editingDescription = $state(false);
    let playlistName = $state('');
    let playlistDescription = $state('');
    let savingMetadata = $state(false);
    let actionError = $state('');
    let orderSaved = $state(false);
    let handledEditRequest = $state<string | null>(null);

    $effect(() => {
        const request =
            $page.url.searchParams.get('edit') === '1' ? `${serverPlaylist.id}:edit` : null;
        if (!request) handledEditRequest = null;
        if (request && request !== handledEditRequest && data.canEdit && !serverPlaylist.isSystem) {
            handledEditRequest = request;
            playlistName = serverPlaylist.name;
            editingName = true;
        }
    });

    // Sync editing values with server data when it changes (but not during editing)
    $effect(() => {
        if (!editingName && serverPlaylist?.name) {
            playlistName = serverPlaylist.name;
        }
        if (!editingDescription) {
            playlistDescription = serverPlaylist?.description || '';
        }
    });

    // Member management
    let showMemberPanel = $state(false);
    let searchQuery = $state('');
    let searchResults: Array<{ username: string; id: string }> = $state([]);
    let searching = false;
    let inviting = $state(false);
    let updatingMember = $state<string | null>(null);
    let selectedRole: 'editor' | 'readonly' = $state('readonly');

    // Loading states
    let savingOrder = $state(false);
    let togglingWatched = $state<number | null>(null);
    let removingItem = $state<number | null>(null);
    let removingBlock = $state<number | null>(null); // Leader ID of block being deleted
    let deletingPlaylist = $state(false);

    // Tutorial banner state
    let showTutorial = $state(false);
    const TUTORIAL_DISMISSED_KEY = 'playlist-drag-tutorial-dismissed';

    // Search modal state
    let showSearchModal = $state(false);
    let addingItem = $state(false);

    // Collapsed blocks - tracked by LEADER ITEM ID (not series key)
    // This allows separate contiguous blocks of the same series to be independently collapsed
    let collapsedSeriesBlocks = new SvelteSet<number>(); // Leader item IDs
    let collapsedSeasonBlocks = new SvelteSet<number>(); // Leader item IDs

    function toggleSeasonCollapse(leaderId: number) {
        if (collapsedSeasonBlocks.has(leaderId)) {
            collapsedSeasonBlocks.delete(leaderId);
        } else {
            collapsedSeasonBlocks.add(leaderId);
        }
        scheduleSaveViewState();
    }

    function toggleSeriesCollapse(leaderId: number) {
        if (collapsedSeriesBlocks.has(leaderId)) {
            collapsedSeriesBlocks.delete(leaderId);
        } else {
            collapsedSeriesBlocks.add(leaderId);
        }
        scheduleSaveViewState();
    }

    // --- Server-side collapse persistence -----------------------------------
    // The collapse sets above are keyed by leader ITEM ID (fragile across
    // reorders); we persist the STABLE series/season KEYS instead and translate
    // at this boundary. A user's own saved state wins; a freshly-invited viewer
    // inherits the owner's collapsed groups (resolved in the load fn).
    let saveViewStateTimer: ReturnType<typeof setTimeout> | null = null;
    let appliedCollapseForPlaylistId: number | null = null;

    function applyPersistedCollapse(groups: CollapsedGroups) {
        const { series, season } = collapsedGroupsToLeaderIds(
            realItems,
            groups,
            getSeriesKey,
            getSeasonKey,
            (id) => seriesBlockLeaders.get(id),
            (id) => seasonBlockLeaders.get(id),
        );
        collapsedSeriesBlocks.clear();
        collapsedSeasonBlocks.clear();
        for (const id of series) collapsedSeriesBlocks.add(id);
        for (const id of season) collapsedSeasonBlocks.add(id);
    }

    function scheduleSaveViewState() {
        // Only authenticated users can persist (the row is keyed by users.id);
        // an anonymous public viewer has no identity, so skip the (rejected) call.
        if (!data.userId) return;
        if (saveViewStateTimer) clearTimeout(saveViewStateTimer);
        saveViewStateTimer = setTimeout(() => {
            saveViewStateTimer = null;
            const collapsedGroups = leaderIdsToCollapsedGroups(
                realItems,
                collapsedSeriesBlocks,
                collapsedSeasonBlocks,
                getSeriesKey,
                getSeasonKey,
            );
            void playlistsApi.saveViewState(serverPlaylist.id, { collapsedGroups });
        }, 600);
    }

    // Apply the persisted collapse once per playlist (covers initial load and
    // client-side navigation to a different playlist on the same component).
    $effect(() => {
        const pid = serverPlaylist.id;
        if (appliedCollapseForPlaylistId === pid) return;
        appliedCollapseForPlaylistId = pid;
        applyPersistedCollapse(data.collapsedGroups ?? { series: [], season: [] });
    });

    // Get all item IDs in the same contiguous block as the item at startIndex
    function getContiguousSeriesBlockIds(startIndex: number): number[] {
        if (startIndex < 0 || startIndex >= realItems.length) return [];

        const leader = realItems[startIndex];
        const seriesKey = getSeriesKey(leader);
        if (!seriesKey) return [leader.id];

        const blockIds: number[] = [leader.id];

        // Look forward for contiguous items in the same series
        for (let i = startIndex + 1; i < realItems.length; i++) {
            if (getSeriesKey(realItems[i]) === seriesKey) {
                blockIds.push(realItems[i].id);
            } else {
                break;
            }
        }

        return blockIds;
    }

    function getContiguousSeasonBlockIds(startIndex: number): number[] {
        if (startIndex < 0 || startIndex >= realItems.length) return [];

        const leader = realItems[startIndex];
        const seasonKey = getSeasonKey(leader);
        if (!seasonKey) return [leader.id];

        const blockIds: number[] = [leader.id];

        // Look forward for contiguous items in the same season
        for (let i = startIndex + 1; i < realItems.length; i++) {
            if (getSeasonKey(realItems[i]) === seasonKey) {
                blockIds.push(realItems[i].id);
            } else {
                break;
            }
        }

        return blockIds;
    }

    // Track what's being dragged for group dragging
    let draggingGroupInfo = $state<{
        type: 'season' | 'series';
        leaderId: number;
        memberIds: number[]; // IDs of all items in the contiguous block
    } | null>(null);

    const flipDurationMs = 200;
    let orderBeforeDrag: typeof items = [];

    function handleDndConsider(
        e: CustomEvent<{
            items: typeof items;
            info?: { trigger: string; id: number | string };
        }>,
    ) {
        const { info } = e.detail;
        if (info?.trigger === TRIGGERS.DRAG_STOPPED) {
            draggingGroupInfo = null;
            return;
        }
        if (!data.canEdit || serverPlaylist.isSystem || savingOrder) return;

        // Detect drag start to track group dragging
        if (info?.trigger === TRIGGERS.DRAG_STARTED) {
            orderBeforeDrag = [...items];
            orderSaved = false;
            const draggedItem = items.find((i) => i.id === info.id);
            // Only process if the id is a number (not the placeholder string)
            const numericId = typeof info.id === 'number' ? info.id : null;
            if (draggedItem && isEpisode(draggedItem.mediaType) && numericId !== null) {
                const realIdx = realItems.findIndex((i) => i.id === info.id);
                const isFirstInSeries = needsSeriesHeader(draggedItem, realIdx);
                const isFirstInSeason = needsSeasonHeader(draggedItem, realIdx);

                // Check if dragging a collapsed series block (takes priority)
                if (isFirstInSeries && collapsedSeriesBlocks.has(numericId)) {
                    const memberIds = getContiguousSeriesBlockIds(realIdx);
                    draggingGroupInfo = {
                        type: 'series',
                        leaderId: numericId,
                        memberIds,
                    };
                }
                // Check if dragging a collapsed season block
                else if (isFirstInSeason && collapsedSeasonBlocks.has(numericId)) {
                    const memberIds = getContiguousSeasonBlockIds(realIdx);
                    draggingGroupInfo = {
                        type: 'season',
                        leaderId: numericId,
                        memberIds,
                    };
                }
            }
        }

        items = e.detail.items;
    }

    async function handleDndFinalize(
        e: CustomEvent<{ items: typeof items; info?: { id: number | string; source?: string } }>,
    ) {
        if (!data.canEdit || serverPlaylist.isSystem || savingOrder) return;
        let newItems = [...e.detail.items];

        // If we were dragging a group, move all group members to follow the leader
        if (draggingGroupInfo) {
            const { leaderId, memberIds } = draggingGroupInfo;
            const memberIdSet = new Set(memberIds);

            // Filter out placeholder items
            // Note: item.id can be string (placeholder) or number (real item)
            newItems = newItems.filter((item) => typeof item.id === 'number');

            // Find the leader's new position
            const leaderIndex = newItems.findIndex((i) => i.id === leaderId);

            if (leaderIndex !== -1) {
                // Get all items in the group (excluding the leader) - only from the original block
                const groupMembers = newItems.filter(
                    (i) => i.id !== leaderId && typeof i.id === 'number' && memberIdSet.has(i.id),
                );

                // Remove group members from their current positions
                newItems = newItems.filter(
                    (i) => i.id === leaderId || typeof i.id !== 'number' || !memberIdSet.has(i.id),
                );

                // Find leader's position again (might have shifted after removal)
                const newLeaderIndex = newItems.findIndex((i) => i.id === leaderId);

                // Sort group members by their original order (season then episode number)
                groupMembers.sort((a, b) => {
                    if (a.seasonNumber !== b.seasonNumber) {
                        return (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0);
                    }
                    return (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0);
                });

                // Insert group members right after the leader
                newItems.splice(newLeaderIndex + 1, 0, ...groupMembers);
            }

            // Keyboard finalize fires after each arrow press, not only on drop.
            // Keep the whole collapsed group selected until DRAG_STOPPED.
            if (e.detail.info?.source !== SOURCES.KEYBOARD) draggingGroupInfo = null;
        }

        // Filter out placeholder items
        items = newItems.filter((item) => typeof item.id === 'number');

        // Save new order to server
        savingOrder = true;
        actionError = '';
        try {
            const reorderData = items.map((item, idx) => ({
                id: item.id as number,
                position: idx,
            }));

            const { data: reorderResult, error: reorderError } = await playlistsApi.reorderItems(
                serverPlaylist.id,
                {
                    expectedRevision: serverPlaylist.revision,
                    entryIds: reorderData.map((item) => item.id),
                },
            );
            if (reorderError) {
                invalidateWhenIdle(PLAYLIST_DETAIL_DEPENDENCY);
                throw reorderError;
            }
            if (reorderResult) {
                applyPlaylistSummary(serverPlaylist.id, reorderResult);
                serverPlaylist = { ...serverPlaylist, ...reorderResult };
            }
            orderBeforeDrag = [...items];
            orderSaved = true;
        } catch (e) {
            console.error('Failed to save order:', e);
            // Restore order without resurrecting items removed while saving or
            // discarding newly added items.
            const previousPositions = new Map(
                orderBeforeDrag.map((item, index) => [item.id, index]),
            );
            items = [...items].sort(
                (a, b) =>
                    (previousPositions.get(a.id) ?? Infinity) -
                    (previousPositions.get(b.id) ?? Infinity),
            );
            actionError = m.viewer_playlist_order_failed();
        } finally {
            savingOrder = false;
        }
    }

    async function toggleWatched(item: (typeof items)[0]) {
        if (!data.userId || togglingWatched !== null) return;
        const targetPlaylistId = serverPlaylist.id;
        actionError = '';

        togglingWatched = typeof item.id === 'number' ? item.id : null;
        const newWatchedState = !item.watched;
        try {
            const { data: watchedData, error: watchedErr } = await playlistsApi.toggleItemWatched(
                serverPlaylist.id,
                item.id as number,
                { watched: newWatchedState },
            );

            if (serverPlaylist.id !== targetPlaylistId) return;
            if (watchedErr) throw watchedErr;
            if (!watchedErr) {
                if (watchedData?.playlistSummary) {
                    applyPlaylistSummary(serverPlaylist.id, watchedData.playlistSummary);
                }
                items = items.map((i) =>
                    i.id === item.id ? { ...i, watched: newWatchedState } : i,
                );

                // Update local itemsWatchedBy optimistically
                if (newWatchedState) {
                    // Add current user to watchers
                    if (!itemsWatchedBy[item.id]) {
                        itemsWatchedBy[item.id] = [];
                    }
                    if (!itemsWatchedBy[item.id].some((w) => w.userId === data.userId)) {
                        itemsWatchedBy[item.id] = [
                            ...itemsWatchedBy[item.id],
                            {
                                userId: data.userId,
                            },
                        ];
                    }
                } else {
                    // Remove current user from watchers
                    if (itemsWatchedBy[item.id]) {
                        itemsWatchedBy[item.id] = itemsWatchedBy[item.id].filter(
                            (w) => w.userId !== data.userId,
                        );
                    }
                }

                // Update member progress for current user
                memberProgress = memberProgress.map((m) => {
                    if (m.userId === data.userId) {
                        const newWatchedCount = newWatchedState
                            ? m.watchedCount + 1
                            : m.watchedCount - 1;
                        return {
                            ...m,
                            watchedCount: newWatchedCount,
                            progressPercent:
                                m.totalCount > 0
                                    ? Math.round((newWatchedCount / m.totalCount) * 100)
                                    : 0,
                        };
                    }
                    return m;
                });
            }
        } catch (e) {
            console.error('Failed to toggle watched:', e);
            if (serverPlaylist.id === targetPlaylistId)
                actionError = m.viewer_playlist_save_failed();
        } finally {
            togglingWatched = null;
        }
    }

    async function removeItem(item: (typeof items)[0]) {
        if (!data.canEdit) return;

        const confirmed = confirm(`${m.btn_remove()} "${item.title}"?`);
        if (!confirmed) return;

        removingItem = typeof item.id === 'number' ? item.id : null;
        try {
            const { data: removeData, error: removeErr } = await playlistsApi.removeItem(
                serverPlaylist.id,
                item.id as number,
            );

            if (!removeErr) {
                items = items.filter((i) => i.id !== item.id);
                // Keep every Watchlist button (cards, detail modal) in step: removing
                // a title here un-saves it, and the store is what those buttons read.
                if (serverPlaylist.playlistType === 'watchlist') syncWatchlistStoreRemoved(item);
                if (removeData) {
                    applyPlaylistSummary(serverPlaylist.id, removeData);
                    serverPlaylist = { ...serverPlaylist, ...removeData };
                }
            }
        } catch (e) {
            console.error('Failed to remove item:', e);
        } finally {
            removingItem = null;
        }
    }

    /**
     * Remove an entire block (series or season) from the playlist
     */
    async function removeBlock(
        leaderId: number,
        blockType: 'series' | 'season',
        blockName: string,
    ) {
        if (!data.canEdit) return;

        // Get the IDs of all items in this block
        const leaderIndex = realItems.findIndex((i) => i.id === leaderId);
        if (leaderIndex === -1) return;

        const blockIds =
            blockType === 'series'
                ? getContiguousSeriesBlockIds(leaderIndex)
                : getContiguousSeasonBlockIds(leaderIndex);

        if (blockIds.length === 0) return;

        const typeLabel =
            blockType === 'series' ? m.playlist_remove_series() : m.playlist_remove_season();
        const confirmed = confirm(`${typeLabel} "${blockName}"?`);
        if (!confirmed) return;

        removingBlock = leaderId;
        try {
            const { data: bulkData, error: bulkErr } = await playlistsApi.bulkDeleteItems(
                serverPlaylist.id,
                blockIds,
            );

            if (!bulkErr) {
                // Remove all items from the local list
                const blockIdSet = new Set(blockIds);
                items = items.filter((i) => !blockIdSet.has(i.id));

                // Clean up collapsed state for deleted block
                if (blockType === 'series') {
                    collapsedSeriesBlocks.delete(leaderId);
                } else {
                    collapsedSeasonBlocks.delete(leaderId);
                }
                // Persist so the removed group doesn't linger in saved state.
                scheduleSaveViewState();

                if (bulkData) {
                    applyPlaylistSummary(serverPlaylist.id, bulkData);
                    serverPlaylist = { ...serverPlaylist, ...bulkData };
                }
            }
        } catch (e) {
            console.error('Failed to remove block:', e);
        } finally {
            removingBlock = null;
        }
    }

    /**
     * Delete the entire playlist (owner only)
     */
    async function deletePlaylist() {
        if (serverPlaylist.role !== 'owner') return;

        const confirmed = confirm(`${m.playlist_delete()} "${serverPlaylist.name}"?`);
        if (!confirmed) return;

        deletingPlaylist = true;
        try {
            const { error: deleteErr } = await playlistsApi.deletePlaylist(serverPlaylist.id);

            if (!deleteErr) {
                // Keep the originating music context when returning to the library.
                goToPath(playlistFallbackHref);
            } else {
                console.error('Failed to delete playlist:', deleteErr);
                alert(m.error_default());
            }
        } catch (e) {
            console.error('Failed to delete playlist:', e);
            alert(m.error_default());
        } finally {
            deletingPlaylist = false;
        }
    }

    async function saveName() {
        if (!data.canEdit || serverPlaylist.isSystem || savingMetadata || !playlistName.trim())
            return;
        const name = playlistName.trim();
        savingMetadata = true;
        actionError = '';
        try {
            const { error } = await playlistsApi.updatePlaylist(serverPlaylist.id, {
                name,
            });
            if (error) throw error;
            serverPlaylist = { ...serverPlaylist, name };
            editingName = false;
        } catch (e) {
            console.error('Failed to save name:', e);
            actionError = m.viewer_playlist_save_failed();
        } finally {
            savingMetadata = false;
        }
    }

    async function saveDescription() {
        if (!data.canEdit || serverPlaylist.isSystem || savingMetadata) return;
        const description = playlistDescription.trim();
        savingMetadata = true;
        actionError = '';
        try {
            const { error } = await playlistsApi.updatePlaylist(serverPlaylist.id, {
                description,
            });
            if (error) throw error;
            serverPlaylist = {
                ...serverPlaylist,
                description: description || null,
            };
            editingDescription = false;
        } catch (e) {
            console.error('Failed to save description:', e);
            actionError = m.viewer_playlist_save_failed();
        } finally {
            savingMetadata = false;
        }
    }

    async function toggleVisibility() {
        if (serverPlaylist.role !== 'owner' || serverPlaylist.isSystem || savingMetadata) return;

        const newVisibility = serverPlaylist.visibility === 'public' ? 'private' : 'public';

        savingMetadata = true;
        actionError = '';
        try {
            const { error } = await playlistsApi.updatePlaylist(serverPlaylist.id, {
                visibility: newVisibility,
            });
            if (error) throw error;
            serverPlaylist = { ...serverPlaylist, visibility: newVisibility };
        } catch (e) {
            console.error('Failed to toggle visibility:', e);
            actionError = m.viewer_playlist_save_failed();
        } finally {
            savingMetadata = false;
        }
    }

    // Member search
    let searchTimeout: ReturnType<typeof setTimeout>;
    let searchVersion = 0;
    onDestroy(() => {
        clearTimeout(searchTimeout);
        searchVersion++;
    });
    async function handleSearch() {
        clearTimeout(searchTimeout);
        const version = ++searchVersion;
        const query = searchQuery.trim();
        const targetPlaylistId = serverPlaylist.id;
        const isCurrent = () => version === searchVersion && targetPlaylistId === serverPlaylist.id;
        searching = false;
        searchResults = [];
        // Mirror the server's peer-branch floor (defs/users/search.ts,
        // MIN_QUERY_LEN_PEER). Below it the server returns an empty page
        // regardless, so firing is two wasted round-trips per search.
        if (searchQuery.trim().length < 3) {
            searchResults = [];
            return;
        }

        searchTimeout = setTimeout(async () => {
            searching = true;
            try {
                const { data: searchData, error: searchErr } =
                    await playlistsApi.searchUsers(query);
                if (!isCurrent()) return;
                if (searchErr) throw searchErr;
                if (!searchErr && searchData) {
                    // New contract: { items: [{id, username}][], page }
                    searchResults = Array.isArray(searchData.items) ? searchData.items : [];
                }
            } catch (e) {
                console.error('Search failed:', e);
                if (isCurrent()) actionError = m.error_generic();
            } finally {
                if (isCurrent()) searching = false;
            }
        }, 300);
    }

    async function inviteMember(userId: string) {
        if (!data.canManageMembers || serverPlaylist.isSystem || inviting) return;
        inviting = true;
        actionError = '';
        try {
            const { data: inviteData, error: inviteErr } = await playlistsApi.inviteMember(
                serverPlaylist.id,
                {
                    userId,
                    role: selectedRole,
                },
            );
            if (inviteErr) throw inviteErr;

            if (!inviteErr && inviteData) {
                // New contract: bare member object (no .member wrapper, no success/timestamp)
                const member = inviteData;
                if (member?.author) {
                    const newMember: ServerMember = {
                        author: member.author,
                        role: member.role,
                        status: member.status,
                        invitedAt: member.invitedAt || new SvelteDate().toISOString(),
                    };
                    serverMembers = [...serverMembers, newMember];
                }
                searchQuery = '';
                searchResults = [];
            }
        } catch (e) {
            console.error('Failed to invite:', e);
            actionError = m.viewer_playlist_save_failed();
        } finally {
            inviting = false;
        }
    }

    async function removeMember(username: string) {
        if (!data.canManageMembers || serverPlaylist.isSystem) return;
        const confirmed = confirm(`${m.btn_remove()} ${username}?`);
        if (!confirmed) return;

        actionError = '';
        try {
            const { error } = await playlistsApi.removeMember(serverPlaylist.id, username);
            if (error) throw error;
            serverMembers = serverMembers.filter((member) => member.author.userId !== username);
        } catch (e) {
            console.error('Failed to remove member:', e);
            actionError = m.viewer_playlist_save_failed();
        }
    }

    async function updateMemberRole(username: string, roleValue: string) {
        if (!data.canManageMembers || serverPlaylist.isSystem || updatingMember) return;
        const role = roleValue as 'editor' | 'readonly';
        actionError = '';
        updatingMember = username;
        try {
            const { error } = await playlistsApi.updateMemberRole(serverPlaylist.id, username, {
                role,
            });
            if (error) throw error;
            serverMembers = serverMembers.map((member) =>
                member.author.userId === username ? { ...member, role } : member,
            );
        } catch (e) {
            console.error('Failed to update role:', e);
            actionError = m.viewer_playlist_save_failed();
        } finally {
            updatingMember = null;
        }
    }

    // Coalesce duplicate submissions independently of Search's visual state.
    const pendingSearchAdds = new SvelteMap<string, Promise<PlaylistAddOutcome>>();
    function handleAddToPlaylist(item: PlaylistAddItem): Promise<PlaylistAddOutcome> {
        if (!data.canEdit || !item.externalIds || !hasAnyId(item.externalIds))
            return Promise.resolve('failed');
        const playlistId = serverPlaylist.id;
        const key = JSON.stringify([
            playlistId,
            item.mediaType,
            Object.entries(item.externalIds).sort(),
            item.seasonNumber,
            item.episodeNumber,
        ]);
        const pending = pendingSearchAdds.get(key);
        if (pending) return pending;
        addingItem = true;
        const request = addSearchItem(item, playlistId).finally(() => {
            pendingSearchAdds.delete(key);
            addingItem = pendingSearchAdds.size > 0;
        });
        pendingSearchAdds.set(key, request);
        return request;
    }

    async function addSearchItem(
        item: PlaylistAddItem,
        playlistId: number,
    ): Promise<PlaylistAddOutcome> {
        const mediaId = item.externalIds?.internal;
        if (!mediaId) return 'failed';
        try {
            const { data: result, error } = await playlistsApi.addItem(playlistId, {
                mediaIds: [mediaId],
            });
            if (error || !result) return 'failed';
            const outcome = result.results[0];
            if (!outcome || outcome.status === 'rejected') return 'failed';
            applyPlaylistSummary(playlistId, result.summary);
            if (serverPlaylist.id === playlistId) {
                serverPlaylist = { ...serverPlaylist, ...result.summary };
                const ids = new Set(items.map((entry) => entry.id));
                items = [...items, ...outcome.entries.filter((entry) => !ids.has(entry.id))];
                if (serverPlaylist.playlistType === 'watchlist')
                    outcome.entries.forEach(syncWatchlistStoreAdded);
            }
            return outcome.status;
        } catch {
            return 'failed';
        }
    }

    function openItem(item: (typeof items)[0], position?: number) {
        if (isAudioTrack(item.mediaType) && item.parentId) {
            openAlbumModal(item.parentId);
            return;
        }
        if (isMusic(item.mediaType)) {
            const internalId = item.mediaId;
            if (internalId) {
                openAlbumModal(internalId);
                return;
            }
        }
        openMediaModal(
            {
                externalIds: { internal: item.mediaId },
                mediaType: item.mediaType,
                title: item.title,
                seriesInternalId: item.seriesId,
                seriesName: item.seriesName,
                seasonNumber: item.seasonNumber,
                episodeNumber: item.episodeNumber,
            },
            getItemPosterUrl(item),
            position !== undefined
                ? {
                      playlistContext: {
                          playlistId: serverPlaylist.id,
                          position: item.position,
                      },
                  }
                : undefined,
        );
    }

    function getMediaTypeIcon(type: string) {
        if (isAudiobook(type)) return BookOpen;
        if (isMusic(type) || isAudioTrack(type)) return MusicalNote;
        return type === 'movie' ? Film : Tv;
    }

    /**
     * Get poster URL using local caching endpoints (provider-agnostic)
     * Priority: internal UUID > External IDs (TMDB, etc.)
     */
    function getItemPosterUrl(item: (typeof items)[0]): string {
        // Episodes only ever have their own artwork under image type 'thumb' —
        // 'poster' has no per-episode source and inherits season/series art
        // instead, so resolve via the episode's own id under 'thumb' first.
        if (isEpisode(item.mediaType)) {
            const internalId = item.mediaId;
            if (internalId) {
                return getCatalogThumbUrl(internalId, { size: 'thumb' });
            }
            // No id of its own at all — fall back to the series poster.
            if (item.seriesId ? { internal: item.seriesId } : undefined) {
                return (
                    imageFromIds(
                        item.seriesId ? { internal: item.seriesId } : undefined,
                        'poster',
                        'tv',
                        { size: 'thumb' },
                    ) || ''
                );
            }
        }

        // For music items, prefer stored posterPath (album art), fall back to catalog endpoint
        if (isMusic(item.mediaType) || isAudioTrack(item.mediaType)) {
            if (item.posterPath) return item.posterPath;
            const internalId = item.mediaId;
            if (internalId) {
                return getCatalogPosterUrl(internalId, { size: 'thumb' });
            }
            return '';
        }

        // For movies/TV, use the item's external IDs.
        // The episode → 'tv' collapse is deliberate and lossy: an episode has no
        // poster of its own, so the composite key must address the series. Every
        // other token passes through verbatim into `tmdb:{id}:{type}`, which the
        // server parses across all five — the two-token type is the label, not
        // the constraint.
        // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
        const mediaType = (isEpisode(item.mediaType) ? 'tv' : item.mediaType) as 'movie' | 'tv';
        return (
            imageFromIds({ internal: item.mediaId }, 'poster', mediaType, { size: 'thumb' }) || ''
        );
    }

    // Visual grouping for episodes from the same series
    // Each color has shades [300, 400, 500, 600, 700] for season variations
    const seriesColorPalettes = [
        {
            base: 'primary',
            shades: [
                'border-l-primary-300',
                'border-l-primary-400',
                'border-l-primary-500',
                'border-l-primary-600',
                'border-l-primary-700',
            ],
        },
        {
            base: 'secondary',
            shades: [
                'border-l-secondary-300',
                'border-l-secondary-400',
                'border-l-secondary-500',
                'border-l-secondary-600',
                'border-l-secondary-700',
            ],
        },
        {
            base: 'tertiary',
            shades: [
                'border-l-tertiary-300',
                'border-l-tertiary-400',
                'border-l-tertiary-500',
                'border-l-tertiary-600',
                'border-l-tertiary-700',
            ],
        },
        {
            base: 'success',
            shades: [
                'border-l-success-300',
                'border-l-success-400',
                'border-l-success-500',
                'border-l-success-600',
                'border-l-success-700',
            ],
        },
        {
            base: 'warning',
            shades: [
                'border-l-warning-300',
                'border-l-warning-400',
                'border-l-warning-500',
                'border-l-warning-600',
                'border-l-warning-700',
            ],
        },
        {
            base: 'error',
            shades: [
                'border-l-error-300',
                'border-l-error-400',
                'border-l-error-500',
                'border-l-error-600',
                'border-l-error-700',
            ],
        },
        {
            base: 'sky',
            shades: [
                'border-l-sky-300',
                'border-l-sky-400',
                'border-l-sky-500',
                'border-l-sky-600',
                'border-l-sky-700',
            ],
        },
        {
            base: 'pink',
            shades: [
                'border-l-pink-300',
                'border-l-pink-400',
                'border-l-pink-500',
                'border-l-pink-600',
                'border-l-pink-700',
            ],
        },
        {
            base: 'lime',
            shades: [
                'border-l-lime-300',
                'border-l-lime-400',
                'border-l-lime-500',
                'border-l-lime-600',
                'border-l-lime-700',
            ],
        },
        {
            base: 'amber',
            shades: [
                'border-l-amber-300',
                'border-l-amber-400',
                'border-l-amber-500',
                'border-l-amber-600',
                'border-l-amber-700',
            ],
        },
    ];

    // Helper functions for grouping
    function getSeriesKey(item: (typeof items)[0]): string | null {
        if (isEpisode(item.mediaType)) {
            // Use the preferred external ID for series grouping (provider-agnostic)
            const preferred = getPreferredExternalId(
                item.seriesId ? { internal: item.seriesId } : undefined,
                {
                    includeUuids: true,
                },
            );
            const seriesId = preferred?.id;
            if (seriesId || item.seriesName) {
                return seriesId || item.seriesName || null;
            }
        }
        return null;
    }

    function getSeasonKey(item: (typeof items)[0]): string | null {
        if (
            isEpisode(item.mediaType) &&
            item.seasonNumber !== null &&
            item.seasonNumber !== undefined
        ) {
            const seriesKey = getSeriesKey(item);
            return seriesKey ? `${seriesKey}-S${item.seasonNumber}` : null;
        }
        return null;
    }

    function getSeriesColor(item: (typeof items)[0]): string {
        const key = getSeriesKey(item);
        if (!key) return 'border-l-surface-500';

        const paletteIdx = seriesColorMap.get(key);
        if (paletteIdx === undefined) return 'border-l-surface-500';

        const palette = seriesColorPalettes[paletteIdx];
        const seasonNum = item.seasonNumber ?? 1;
        // Map season to shade: S1->index 0, S2->1, S3->2, etc., wrapping around
        const shadeIdx = (seasonNum - 1) % palette.shades.length;
        return palette.shades[shadeIdx];
    }

    // Get the base color for series header (uses middle shade, 500)
    function getSeriesBaseColor(item: (typeof items)[0]): string {
        const key = getSeriesKey(item);
        if (!key) return 'border-l-surface-500';

        const paletteIdx = seriesColorMap.get(key);
        if (paletteIdx === undefined) return 'border-l-surface-500';

        // Use middle shade (index 2 = 500) for series header
        return seriesColorPalettes[paletteIdx].shades[2];
    }

    // Check headers needed before each item (uses realItems to handle drag placeholders correctly)
    function needsSeriesHeader(item: (typeof items)[0], realIndex: number): boolean {
        if (!isEpisode(item.mediaType)) return false;
        if (realIndex === 0) return true;
        const prevItem = realItems[realIndex - 1];
        if (!prevItem) return true;
        return getSeriesKey(item) !== getSeriesKey(prevItem);
    }

    function needsSeasonHeader(item: (typeof items)[0], realIndex: number): boolean {
        if (!isEpisode(item.mediaType)) return false;
        if (item.seasonNumber === null || item.seasonNumber === undefined) return false;

        // Always show season header if this is first item or new series
        if (realIndex === 0) return true;

        const prevItem = realItems[realIndex - 1];
        if (!prevItem) return true;
        // Different series = new season header
        if (getSeriesKey(item) !== getSeriesKey(prevItem)) return true;
        // Same series, different season
        return getSeasonKey(item) !== getSeasonKey(prevItem);
    }

    // Count episodes in current season for header display (uses realItems).
    // NOTE: written as a single ternary `return` on purpose — the early-return
    // guard form (`if (!key) return 0; return realItems.filter(...).length`)
    // hits a Svelte 5.55.1 SSR compiler bug that silently DROPS the second
    // `return`, so the function returns `undefined` and the template's
    // `.toString()` 500s on SSR (F5) for episode playlists. See getSeriesKey
    // returning a non-null key for episodes.
    function getSeasonEpisodeCount(item: (typeof items)[0]): number {
        const seasonKey = getSeasonKey(item);
        return seasonKey ? realItems.filter((i) => getSeasonKey(i) === seasonKey).length : 0;
    }

    // Count all episodes in series (uses realItems). Same single-ternary form as
    // getSeasonEpisodeCount — see the note there re: the Svelte SSR compiler bug.
    function getSeriesEpisodeCount(item: (typeof items)[0]): number {
        const seriesKey = getSeriesKey(item);
        return seriesKey ? realItems.filter((i) => getSeriesKey(i) === seriesKey).length : 0;
    }

    // Keyboard shortcut handler
    function handleKeydown(e: KeyboardEvent) {
        // Ctrl+F or Cmd+F opens the search modal (only if user can edit)
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            if (data.canEdit && !showSearchModal) {
                e.preventDefault();
                showSearchModal = true;
            }
        }
    }
    // Derived data transformations (serverPlaylist, serverItems, serverMembers defined at top)
    let typedPlaylist = $derived(buildTypedPlaylist(serverPlaylist, serverPlaylist.itemCount));
    // Transform members for components that expect PlaylistMember[]
    let typedMembers = $derived(
        (serverMembers || []).map((m): PlaylistMember => ({
            author: m.author,
            role: m.role === 'editor' ? 'editor' : 'readonly',
            status: m.status === 'accepted' ? 'accepted' : 'pending',
            invitedAt: m.invitedAt,
        })),
    );
    // Typed username for components
    let typedUsername = $derived((data.userId as string | null) || null);
    // svelte-dnd-action requires mutable items array — use $state, not $derived
    // svelte-ignore state_referenced_locally
    let items: PlaylistEntry[] = $state(
        serverItems.map((item) => ({
            ...item,
            id: item.id, // svelte-dnd-action requires 'id' field
        })),
    );
    // Calculate progress (exclude placeholders)
    // SHADOW_PLACEHOLDER_ITEM_ID is a string, real item IDs are numbers
    let realItems = $derived(items.filter((i) => typeof i.id === 'number'));
    // Compute block leaders for each item (maps itemId -> leaderId)
    // A block is a contiguous run of items from the same series/season
    let seriesBlockLeaders = $derived(
        (() => {
            // Using native Map in $derived is fine - it's recreated on each derivation
            // eslint-disable-next-line svelte/prefer-svelte-reactivity
            const leaders = new Map<number, number>(); // itemId -> leaderId
            let currentLeaderId: number | null = null;
            let currentSeriesKey: string | null = null;

            for (const item of realItems) {
                const key = getSeriesKey(item);
                if (key !== currentSeriesKey) {
                    currentSeriesKey = key;
                    currentLeaderId = key ? item.id : null;
                }
                if (currentLeaderId !== null) {
                    leaders.set(item.id, currentLeaderId);
                }
            }
            return leaders;
        })(),
    );
    let seasonBlockLeaders = $derived(
        (() => {
            // Using native Map in $derived is fine - it's recreated on each derivation
            // eslint-disable-next-line svelte/prefer-svelte-reactivity
            const leaders = new Map<number, number>(); // itemId -> leaderId
            let currentLeaderId: number | null = null;
            let currentSeasonKey: string | null = null;

            for (const item of realItems) {
                const key = getSeasonKey(item);
                if (key !== currentSeasonKey) {
                    currentSeasonKey = key;
                    currentLeaderId = key ? item.id : null;
                }
                if (currentLeaderId !== null) {
                    leaders.set(item.id, currentLeaderId);
                }
            }
            return leaders;
        })(),
    );
    let videoItems = $derived(
        realItems.filter(
            (i) => isMovie(i.mediaType) || isSeries(i.mediaType) || isEpisode(i.mediaType),
        ),
    );
    let watchableCount = $derived(videoItems.length);
    let watchedCount = $derived(videoItems.filter((i) => i.watched).length);
    let totalCount = $derived(realItems.length);
    let progressPercent = $derived(
        watchableCount > 0 ? Math.round((watchedCount / watchableCount) * 100) : 0,
    );
    // A playlist is "music" if it is typed as music (so an EMPTY music playlist
    // still gets the music UI) or any item is an audio track/music item. Use the
    // media-type comparators rather than a raw `=== 'track'` string compare.
    let hasMusicItems = $derived(
        typedPlaylist.playlistType === 'music' ||
            realItems.some((i) => isAudioTrack(i.mediaType) || isMusic(i.mediaType)),
    );
    // Navigation context follows the explicit playlist type. Mixed contents
    // can affect playback UI without reclassifying a shared playlist route.
    let isExplicitMusicPlaylist = $derived(serverPlaylist.playlistType === 'music');
    let playlistFallbackHref = $derived(
        $page.url.searchParams.get('from') === 'music'
            ? '/music'
            : isExplicitMusicPlaylist
              ? '/playlists?type=music'
              : '/playlists',
    );

    let hasPlayableMusic = $derived(
        realItems.some((item) => isAudioTrack(item.mediaType) && item.mediaId),
    );

    async function handleAddSuggestion(trackId: string): Promise<boolean> {
        if (!data.canEdit) return false;
        const { data: result, error } = await playlistsApi.addItem(serverPlaylist.id, {
            mediaIds: [trackId],
        });
        if (error || !result || result.results[0]?.status === 'rejected') return false;
        serverPlaylist = { ...serverPlaylist, ...result.summary };
        const ids = new Set(items.map((item) => item.id));
        items = [...items, ...result.results[0].entries.filter((entry) => !ids.has(entry.id))];
        return true;
    }
    function posterImages(url: string | undefined): MusicTrack['images'] | undefined {
        if (!url) return undefined;
        return {
            primary: { href: url, revision: '1', source: 'self' },
        };
    }

    // Video playlists had per-item play buttons only. Start where the viewer
    // left off: the first unwatched playable item, or the first one again when
    // everything is watched — in playlist context, so the player offers next.
    let playNext = $derived.by(() => {
        const playable = realItems
            .map((item, position) => ({ item, position }))
            .filter(
                ({ item }) =>
                    (isMovie(item.mediaType) ||
                        isSeries(item.mediaType) ||
                        isEpisode(item.mediaType)) &&
                    Boolean(item.mediaId),
            );
        if (playable.length === 0) return undefined;
        const unwatched = playable.find(({ item }) => !item.watched);
        const target = unwatched ?? playable[0];
        const mode: 'start' | 'continue' | 'again' = !unwatched
            ? 'again'
            : playable.some(({ item }) => item.watched)
              ? 'continue'
              : 'start';
        const itemId = target.item.mediaId ?? '';
        return {
            mode,
            title: target.item.title,
            onPlay: () =>
                goToPath(
                    `/watch/${itemId}?playlist=${serverPlaylist.id}&position=${target.position}`,
                ),
        };
    });

    function goToPath(path: string, replaceState = false): void {
        void import('$app/navigation').then(({ goto }) => goto(resolve(path), { replaceState }));
    }

    function getMusicTracks(): MusicTrack[] {
        return realItems
            .filter((i) => isAudioTrack(i.mediaType) && i.mediaId)
            .map((i) =>
                musicTrackFromCard({
                    id: requireValue(
                        i.mediaId,
                        'playlist entry mediaId must exist for music track',
                    ),
                    title: i.title,
                    artists: [{ id: null, title: i.artist ?? 'Unknown Artist' }],
                    images: posterImages(getItemPosterUrl(i) || undefined),
                }),
            );
    }

    async function playAllTracks(): Promise<void> {
        const tracks = getMusicTracks();
        if (tracks.length === 0) return;
        await musicPlayerStore.enqueueFromBrew(tracks, true, {
            type: 'mix',
            name: serverPlaylist.name,
            trackCount: tracks.length,
            href: $page.url.pathname + $page.url.search,
        });
    }

    async function shuffleAllTracks(): Promise<void> {
        const tracks = getMusicTracks();
        if (tracks.length === 0) return;
        // Fisher-Yates shuffle
        for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        }
        await musicPlayerStore.enqueueFromBrew(tracks, true, {
            type: 'mix',
            name: serverPlaylist.name,
            trackCount: tracks.length,
            href: $page.url.pathname + $page.url.search,
        });
    }

    // Computed: series color palette map (reactive, uses realItems to exclude placeholders)
    // Maps series key -> palette index
    let seriesColorMap = $derived(
        (() => {
            // Using native Map in $derived is fine - it's recreated on each derivation
            // eslint-disable-next-line svelte/prefer-svelte-reactivity
            const map = new Map<string, number>();
            let idx = 0;
            for (const item of realItems) {
                const key = getSeriesKey(item);
                if (key && !map.has(key)) {
                    map.set(key, idx % seriesColorPalettes.length);
                    idx++;
                }
            }
            return map;
        })(),
    );
</script>

<svelte:head>
    <title>{serverPlaylist.name} - {m.page_playlists()}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class="container mx-auto px-4 pb-6 pt-4 lg:pt-20 max-w-4xl">
    {#if isExplicitMusicPlaylist}
        <div class="mb-6 space-y-3">
            <MusicNavigation />
            <MusicLibraryTabs />
        </div>
    {/if}
    <PlaylistHeader
        playlist={typedPlaylist}
        canEdit={Boolean(data.canEdit)}
        canManageMembers={Boolean(data.canManageMembers)}
        username={typedUsername}
        bind:editingName
        bind:editingDescription
        bind:playlistName
        bind:playlistDescription
        {addingItem}
        {deletingPlaylist}
        {savingOrder}
        {savingMetadata}
        membersExpanded={showMemberPanel}
        {totalCount}
        {watchableCount}
        {watchedCount}
        {progressPercent}
        {memberProgress}
        onBack={() =>
            $page.state.musicPlaylistOrigin ? history.back() : goToPath(playlistFallbackHref, true)}
        onToggleVisibility={toggleVisibility}
        onOpenSearch={() => (showSearchModal = true)}
        onToggleMembers={() => (showMemberPanel = !showMemberPanel)}
        onDeletePlaylist={deletePlaylist}
        onSaveName={saveName}
        onSaveDescription={saveDescription}
        isMusicPlaylist={hasMusicItems}
        onPlayAll={hasPlayableMusic ? playAllTracks : undefined}
        onShuffle={hasPlayableMusic ? shuffleAllTracks : undefined}
        {playNext} />

    {#if actionError}
        <p role="alert" class="mb-4 rounded-lg bg-error-500/10 p-3 text-error-300">{actionError}</p>
    {/if}
    {#if orderSaved && !savingOrder}
        <p role="status" class="mb-3 text-sm text-success-400">{m.viewer_playlist_order_saved()}</p>
    {/if}

    {#if showMemberPanel && data.canManageMembers && !serverPlaylist.isSystem}
        <div id="playlist-members">
            <PlaylistMemberPanel
                bind:searchQuery
                {searchResults}
                bind:selectedRole
                {inviting}
                {updatingMember}
                members={typedMembers}
                onSearch={handleSearch}
                onInvite={inviteMember}
                onUpdateRole={updateMemberRole}
                onRemove={removeMember}
                onClose={() => (showMemberPanel = false)} />
        </div>
    {/if}

    <!-- Drag-and-Drop Tutorial Banner -->
    {#if showTutorial && items.length > 0}
        <div class="card p-4 bg-primary-900/30 border border-primary-500/30 mb-4">
            <div class="flex items-start gap-3">
                <div class="shrink-0 p-2 bg-primary-500/20 rounded-lg">
                    <Icon src={LightBulb} class="w-5 h-5 text-primary-400" />
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="font-semibold text-primary-300 mb-1">
                        {m.playlist_tutorial_title()}
                    </h4>
                    <p class="text-sm text-surface-300 leading-relaxed">
                        {m.playlist_tutorial_text()}
                    </p>
                </div>
                <button
                    type="button"
                    class="shrink-0 p-1 hover:bg-surface-700 rounded transition-colors"
                    onclick={dismissTutorial}
                    aria-label={m.playlist_tutorial_close()}>
                    <Icon src={XMark} class="w-5 h-5 text-surface-400" />
                </button>
            </div>
        </div>
    {/if}

    <!-- Items List -->
    {#if items.length === 0}
        <div class="card p-12 text-center bg-surface-800/50">
            <Icon src={QueueList} class="w-16 h-16 mx-auto mb-4 text-surface-500" />
            <h2 class="h3 mb-2">{m.playlist_empty_title()}</h2>
            <p class="text-surface-400 mb-4">
                {isExplicitMusicPlaylist
                    ? m.viewer_playlist_empty_hint()
                    : m.playlist_empty_description()}
            </p>
        </div>
    {:else}
        {#if data.canEdit && !serverPlaylist.isSystem}
            <p id="playlist-reorder-help" class="mb-3 text-sm text-surface-400">
                {m.viewer_playlist_reorder_help()}
            </p>
        {/if}
        <div
            aria-label={m.viewer_playlist_items_label()}
            aria-describedby={data.canEdit && !serverPlaylist.isSystem
                ? 'playlist-reorder-help'
                : undefined}
            use:dndzone={{
                items,
                flipDurationMs,
                dropTargetStyle: {
                    outline: '2px dashed rgba(var(--color-primary-500-rgb) / 0.5)',
                    borderRadius: '8px',
                },
                dragDisabled: !data.canEdit || serverPlaylist.isSystem === true || savingOrder,
            }}
            onconsider={handleDndConsider}
            onfinalize={handleDndFinalize}>
            {#each items as item, index (item.id)}
                {@const isPlaceholder = typeof item.id === 'string'}
                {@const realIndex = isPlaceholder
                    ? -1
                    : realItems.findIndex((i) => i.id === item.id)}
                {@const isFirstInSeries = !isPlaceholder && needsSeriesHeader(item, realIndex)}
                {@const isFirstInSeason = !isPlaceholder && needsSeasonHeader(item, realIndex)}
                {@const seriesBlockLeaderId = seriesBlockLeaders.get(item.id)}
                {@const seasonBlockLeaderId = seasonBlockLeaders.get(item.id)}
                {@const isSeriesBlockCollapsed =
                    seriesBlockLeaderId !== undefined &&
                    collapsedSeriesBlocks.has(seriesBlockLeaderId)}
                {@const isSeasonBlockCollapsed =
                    seasonBlockLeaderId !== undefined &&
                    collapsedSeasonBlocks.has(seasonBlockLeaderId)}
                {@const shouldHideForSeries =
                    isSeriesBlockCollapsed && !isFirstInSeries && !isPlaceholder}
                {@const shouldHideForSeason =
                    isSeasonBlockCollapsed &&
                    !isFirstInSeason &&
                    !isPlaceholder &&
                    !isSeriesBlockCollapsed}
                {@const isBeingDraggedAway =
                    draggingGroupInfo &&
                    !isPlaceholder &&
                    item.id !== draggingGroupInfo.leaderId &&
                    draggingGroupInfo.memberIds.includes(item.id)}
                {@const shouldHide =
                    shouldHideForSeries || shouldHideForSeason || isBeingDraggedAway}
                <div
                    animate:flip={{ duration: flipDurationMs }}
                    class="mb-1"
                    class:opacity-50={isPlaceholder}>
                    {#if !isPlaceholder}
                        <!-- Series Header (outside draggable, only visual) -->
                        {#if needsSeriesHeader(item, realIndex) && item.seriesName}
                            <div
                                class="flex items-center gap-2 pt-4 pb-2 px-2 text-sm select-none group/series
                                       hover:bg-surface-700/50 rounded transition-colors"
                                class:mt-4={realIndex > 0}>
                                <button
                                    type="button"
                                    class="flex items-center gap-2 flex-1 text-left"
                                    onclick={() => toggleSeriesCollapse(item.id)}>
                                    <Icon
                                        src={isSeriesBlockCollapsed ? ChevronRight : ChevronDown}
                                        class="w-4 h-4 text-surface-500 transition-transform" />
                                    <div
                                        class="w-1 h-5 rounded-full {getSeriesBaseColor(
                                            item,
                                        ).replace('border-l-', 'bg-')}">
                                    </div>
                                    <Icon src={Tv} class="w-4 h-4 text-surface-400" />
                                    <span class="font-semibold text-surface-200"
                                        >{item.seriesName}</span>
                                    <span class="text-surface-500 text-xs">
                                        ({m.playlist_episodes_count({
                                            count: getSeriesEpisodeCount(item).toString(),
                                        })})
                                    </span>
                                    {#if isSeriesBlockCollapsed}
                                        <span class="text-surface-600 text-[10px]"
                                            >{m.playlist_block_collapsed()}</span>
                                    {/if}
                                </button>
                                <!-- Delete series block button -->
                                {#if data.canEdit}
                                    <button
                                        type="button"
                                        class="btn-icon btn-icon-sm variant-ghost-error"
                                        onclick={stopPropagation(() =>
                                            removeBlock(item.id, 'series', item.seriesName || ''),
                                        )}
                                        disabled={removingBlock === item.id}
                                        aria-label={m.playlist_remove_series()}
                                        title={m.playlist_remove_series()}>
                                        {#if removingBlock === item.id}
                                            <span
                                                class="loading-spinner loading-spinner-error w-4 h-4"
                                            ></span>
                                        {:else}
                                            <Icon src={Trash} class="w-4 h-4" />
                                        {/if}
                                    </button>
                                {/if}
                            </div>
                        {/if}

                        <!-- Season Header (hidden when series is collapsed) -->
                        {#if needsSeasonHeader(item, realIndex) && !isSeriesBlockCollapsed}
                            <div
                                class="flex items-center gap-2 text-xs text-surface-400 select-none group/season
                                       hover:bg-surface-700/50 rounded transition-colors
                                       {needsSeriesHeader(item, realIndex)
                                    ? 'pb-1 pl-5'
                                    : 'pt-2 pb-1 pl-5'}">
                                <button
                                    type="button"
                                    class="flex items-center gap-2 flex-1 text-left"
                                    onclick={() => toggleSeasonCollapse(item.id)}>
                                    <Icon
                                        src={isSeasonBlockCollapsed ? ChevronRight : ChevronDown}
                                        class="w-3 h-3 text-surface-500 transition-transform" />
                                    <span class="font-medium"
                                        >{m.season_label({
                                            number: item.seasonNumber?.toString() || '0',
                                        })}</span>
                                    <span class="text-surface-500">
                                        ({m.playlist_episodes_count({
                                            count: getSeasonEpisodeCount(item).toString(),
                                        })})
                                    </span>
                                    {#if isSeasonBlockCollapsed}
                                        <span class="text-surface-600 text-[10px]"
                                            >{m.playlist_season_collapsed()}</span>
                                    {/if}
                                </button>
                                <!-- Delete season block button -->
                                {#if data.canEdit}
                                    <button
                                        type="button"
                                        class="btn-icon btn-icon-sm variant-ghost-error"
                                        onclick={stopPropagation(() =>
                                            removeBlock(
                                                item.id,
                                                'season',
                                                `${item.seriesName} ${m.season_label({ number: item.seasonNumber?.toString() || '0' })}`,
                                            ),
                                        )}
                                        disabled={removingBlock === item.id}
                                        aria-label={m.playlist_remove_season()}
                                        title={m.playlist_remove_season()}>
                                        {#if removingBlock === item.id}
                                            <span
                                                class="loading-spinner loading-spinner-error w-3 h-3"
                                            ></span>
                                        {:else}
                                            <Icon src={Trash} class="w-3 h-3" />
                                        {/if}
                                    </button>
                                {/if}
                            </div>
                        {/if}
                    {/if}

                    <!-- Item Card (draggable) - hidden if collapsed and not first in season -->
                    <div
                        class="card p-3 bg-surface-800 hover:bg-surface-700/80 transition-colors flex items-center gap-3 group
                               {isEpisode(item.mediaType)
                            ? 'border-l-4 ' + getSeriesColor(item)
                            : ''}
                               {shouldHide ? 'hidden' : ''}">
                        <!-- Drag Handle -->
                        {#if data.canEdit && !serverPlaylist.isSystem}
                            <div
                                class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 shrink-0">
                                <Icon src={Bars3} class="w-5 h-5" />
                            </div>
                        {/if}

                        <!-- Poster -->
                        <button
                            type="button"
                            class="shrink-0 w-12 h-18 rounded overflow-hidden bg-surface-700"
                            onclick={() => openItem(item, realIndex)}>
                            {#if hasAnyId({ internal: item.mediaId })}
                                <img
                                    src={getItemPosterUrl(item)}
                                    alt={item.title}
                                    class="w-full h-full object-cover"
                                    loading="lazy" />
                            {:else}
                                <div class="w-full h-full center">
                                    <Icon
                                        src={getMediaTypeIcon(item.mediaType)}
                                        class="w-6 h-6 text-surface-500" />
                                </div>
                            {/if}
                        </button>

                        <!-- Info -->
                        <div class="flex-1 min-w-0">
                            {#if isSeriesBlockCollapsed && isFirstInSeries}
                                <!-- Collapsed series block summary -->
                                <div class="font-medium text-surface-300">
                                    {item.seriesName}
                                </div>
                                <p class="text-sm text-surface-500">
                                    {m.playlist_episodes_count({
                                        count: getSeriesEpisodeCount(item).toString(),
                                    })} ({m.playlist_block_collapsed()})
                                </p>
                            {:else if isSeasonBlockCollapsed && isFirstInSeason}
                                <!-- Collapsed season block summary -->
                                <div class="font-medium text-surface-300">
                                    {item.seriesName} - {m.season_label({
                                        number: item.seasonNumber?.toString() || '0',
                                    })}
                                </div>
                                <p class="text-sm text-surface-500">
                                    {m.playlist_episodes_count({
                                        count: getSeasonEpisodeCount(item).toString(),
                                    })} ({m.playlist_season_collapsed()})
                                </p>
                            {:else}
                                <button
                                    type="button"
                                    class="font-medium hover:text-primary-400 transition-colors text-left truncate block w-full"
                                    onclick={() => openItem(item, realIndex)}>
                                    {#if isEpisode(item.mediaType)}
                                        S{item.seasonNumber}E{item.episodeNumber}:
                                        {item.title}
                                    {:else}
                                        {item.title}
                                    {/if}
                                </button>
                                {#if isEpisode(item.mediaType) && item.seriesName}
                                    <p class="text-sm text-surface-400 truncate">
                                        {item.seriesName}
                                    </p>
                                {:else if isAudioTrack(item.mediaType) || isMusic(item.mediaType)}
                                    <p class="text-sm text-surface-400 truncate">
                                        {#if item.artist && item.artistId}
                                            <button
                                                type="button"
                                                class="hover:text-primary-400 hover:underline"
                                                onclick={() =>
                                                    openArtistModal(item.artistId ?? '')}>
                                                {item.artist}
                                            </button>
                                        {:else if item.artist}
                                            <span>{item.artist}</span>
                                        {/if}
                                        {#if item.artist && item.seriesName}
                                            <span class="text-surface-500"> · </span>
                                        {/if}
                                        {#if item.seriesName && item.parentId}
                                            <button
                                                type="button"
                                                class="hover:text-primary-400 hover:underline"
                                                onclick={() => openAlbumModal(item.parentId ?? '')}>
                                                {item.seriesName}
                                            </button>
                                        {:else if item.seriesName}
                                            <span>{item.seriesName}</span>
                                        {/if}
                                        {#if !item.artist && !item.seriesName}
                                            <span>{item.title}</span>
                                        {/if}
                                    </p>
                                {:else}
                                    <p class="text-sm text-surface-500 capitalize">
                                        {isMovie(item.mediaType)
                                            ? m.media_movie()
                                            : isAudiobook(item.mediaType)
                                              ? m.media_audiobook()
                                              : m.media_series()}
                                    </p>
                                {/if}
                            {/if}
                        </div>

                        {#if !((isSeriesBlockCollapsed && isFirstInSeries) || (isSeasonBlockCollapsed && isFirstInSeason && !isSeriesBlockCollapsed))}
                            <!-- Who watched this item (social proof) - not shown when collapsed -->
                            {#if itemsWatchedBy[item.id]?.length > 0}
                                <div class="shrink-0">
                                    <ItemWatchers
                                        watchers={itemsWatchedBy[item.id]}
                                        currentUser={data.userId} />
                                </div>
                            {/if}

                            <!-- Actions - not shown when collapsed -->
                            <div class="flex items-center gap-1 shrink-0">
                                <!-- Play Button -->
                                {#if isAudioTrack(item.mediaType) && item.mediaId}
                                    <button
                                        type="button"
                                        class="btn-icon btn-icon-sm variant-filled-primary rounded-full"
                                        title={m.play()}
                                        onclick={() => {
                                            musicPlayerStore.play(
                                                musicTrackFromCard({
                                                    id: item.mediaId ?? '',
                                                    title: item.title,
                                                    artists: [
                                                        {
                                                            id: null,
                                                            title: item.artist ?? 'Unknown Artist',
                                                        },
                                                    ],
                                                    images: posterImages(
                                                        getItemPosterUrl(item) || undefined,
                                                    ),
                                                }),
                                            );
                                        }}>
                                        <Icon src={Play} class="w-4 h-4" />
                                    </button>
                                {:else if isAudiobook(item.mediaType)}
                                    <button
                                        type="button"
                                        class="btn-icon btn-icon-sm variant-ghost-primary"
                                        aria-label={m.search_result_details({ title: item.title })}
                                        onclick={() => openItem(item)}>
                                        <Icon src={BookOpen} class="w-4 h-4" />
                                    </button>
                                {:else if (isMovie(item.mediaType) || isSeries(item.mediaType) || isEpisode(item.mediaType)) && item.mediaId}
                                    <div
                                        class="btn-icon btn-icon-sm variant-filled-success rounded-full">
                                        <WatchButton
                                            itemId={item.mediaId ?? ''}
                                            variant="icon"
                                            size="md"
                                            playlistContext={{
                                                playlistId: serverPlaylist.id,
                                                position: realIndex,
                                            }} />
                                    </div>
                                {/if}

                                <!-- Watched Toggle (not for music) -->
                                {#if data.userId && (isMovie(item.mediaType) || isSeries(item.mediaType) || isEpisode(item.mediaType))}
                                    <button
                                        type="button"
                                        class="btn btn-sm {item.watched
                                            ? 'variant-filled-success'
                                            : 'variant-ghost-surface'}"
                                        onclick={() => toggleWatched(item)}
                                        disabled={togglingWatched !== null}
                                        title={item.watched
                                            ? m.playlist_mark_unwatched()
                                            : m.playlist_mark_watched()}>
                                        {#if togglingWatched === item.id}
                                            <span class="loading-spinner w-4 h-4"></span>
                                        {:else}
                                            <Icon src={Check} class="w-4 h-4" />
                                        {/if}
                                    </button>
                                {/if}

                                <!-- Remove Button -->
                                {#if data.canEdit}
                                    <button
                                        type="button"
                                        class="btn-icon btn-icon-sm variant-ghost-error"
                                        onclick={() => removeItem(item)}
                                        disabled={removingItem === item.id}
                                        aria-label={m.btn_remove()}>
                                        {#if removingItem === item.id}
                                            <span
                                                class="loading-spinner loading-spinner-error w-4 h-4"
                                            ></span>
                                        {:else}
                                            <Icon src={Trash} class="w-4 h-4" />
                                        {/if}
                                    </button>
                                {/if}
                            </div>
                        {:else if isSeriesBlockCollapsed && isFirstInSeries}
                            <!-- Expand button for collapsed series block -->
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-primary"
                                onclick={() => toggleSeriesCollapse(item.id)}>
                                <Icon src={ChevronDown} class="w-4 h-4 mr-1" />
                                {m.playlist_expand_block()}
                            </button>
                        {:else}
                            <!-- Expand button for collapsed season block -->
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-primary"
                                onclick={() => toggleSeasonCollapse(item.id)}>
                                <Icon src={ChevronDown} class="w-4 h-4 mr-1" />
                                {m.playlist_expand_season()}
                            </button>
                        {/if}
                    </div>
                </div>
            {/each}
        </div>
    {/if}

    <!-- Music Playlist Suggestions -->
    {#if hasMusicItems}
        <PlaylistSuggestions
            playlistId={String(serverPlaylist.id)}
            onAdd={data.canEdit ? handleAddSuggestion : undefined} />
    {/if}

    <!-- Playlist Chat -->
    {#if data.featureChatEnabled && typedUsername && !serverPlaylist.isSystem}
        <div class="mt-6">
            {#key serverPlaylist.id}
                <PlaylistChat
                    playlistId={serverPlaylist.id}
                    currentUser={typedUsername}
                    isOwner={serverPlaylist.owner.userId === typedUsername} />
            {/key}
        </div>
    {/if}
</div>

<!-- Search Modal for adding items -->
{#if data.canEdit}
    <Search
        bind:isOpen={showSearchModal}
        playlistMode={true}
        playlistId={serverPlaylist.id}
        restrictToTypes={$page.url.searchParams.get('type') === 'music' ? 'music' : undefined}
        existingPlaylistItems={realItems.map((item) => ({
            externalIds: { internal: item.mediaId },
            seriesExternalIds: item.seriesId ? { internal: item.seriesId } : undefined,
            seriesName: item.seriesName ?? undefined,
            mediaType: item.mediaType,
            seasonNumber: item.seasonNumber ?? undefined,
            episodeNumber: item.episodeNumber ?? undefined,
        }))}
        onclose={() => (showSearchModal = false)}
        onaddToPlaylist={handleAddToPlaylist} />
{/if}

<style>
    /* Drag handle styles */
    :global(.svelte-dnd-action-dragging) {
        opacity: 0.8;
        transform: scale(1.02);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
    }
</style>
