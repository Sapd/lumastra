<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { detailTabPath } from './detail-tabs.js';
    import type { PageData } from './$types';
    import { untrack } from 'svelte';
    import { page } from '$app/stores';
    import { adminNavPrefs } from '$lib/stores/admin-nav-prefs.store.svelte';
    import { browser } from '$app/environment';
    import { afterNavigate, goto, invalidateAll, replaceState } from '$app/navigation';
    import * as m from '$lib/paraglide/messages.js';
    import {
        shouldAutoCollapse,
        shouldAutoCollapseByEntryCount,
        loadSidebarCollapsed,
        saveSidebarCollapsed,
    } from './sidebar-collapse.js';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import {
        Icon,
        InformationCircle,
        Photo,
        QueueList,
        ArrowsUpDown,
        ArrowPath,
        DocumentText,
        MusicalNote,
        Microphone,
        BookOpen,
        Bars3BottomLeft,
        ChartBar,
        LockOpen,
        ChevronDown,
        ChevronLeft,
        ChevronRight,
    } from 'svelte-hero-icons';
    import { Tabs } from '$lib/components/ui';
    import AdminBreadcrumb from '$lib/components/admin/media/AdminBreadcrumb.svelte';
    import AdminMediaSearch from '$lib/components/admin/media/AdminMediaSearch.svelte';
    import AlbumMerge from '$lib/components/admin/media/AlbumMerge.svelte';
    import MediaHierarchySidebar from '$lib/components/admin/media/MediaHierarchySidebar.svelte';
    import MusicHierarchySidebar from '$lib/components/admin/media/MusicHierarchySidebar.svelte';
    import {
        musicContextParams,
        artistTracksReturnParams,
    } from '$lib/components/admin/media/music-context.js';
    import SharedFileSummary from '$lib/components/admin/media/SharedFileSummary.svelte';
    import CoverageSummary from '$lib/components/admin/media/CoverageSummary.svelte';
    import OverviewTab from '$lib/components/admin/media/OverviewTab.svelte';
    import FileIssuesPanel from '$lib/components/admin/media/FileIssuesPanel.svelte';
    import { afterDeletePath } from './after-delete-path';
    import { decideDeleteFailureAction } from './detail-actions.js';
    import { actionsFor, type ActionContext } from '$lib/components/admin/media/media-actions.js';
    import {
        isDeleteConfirmed,
        deleteConfirmExpectedValue,
        EMPTY_TITLE_DELETE_CONFIRM_WORD,
    } from './delete-confirm.js';
    import { setArtistNoSplit, unlockMediaMetadata, deleteMedia } from '$lib/api/admin';
    import { IdentifyModal } from '$lib/components/admin';
    import { clickOutside } from '$lib/utils/click-outside';
    import { mediaActionLabel } from '$lib/components/admin/media/media-action-presentation.js';
    import {
        mediaIssueFix,
        mediaIssueFixLabel,
        mediaIssueLabel,
        severityBadgeClass,
        severityDotClass,
    } from '$lib/components/admin/media/media-issue-presentation.js';
    import { noteIssues, problemIssues, type MediaIssue } from '$lib/shared/media-issues.js';
    import { loadTriageContext, triagePosition, type TriagePosition } from '../triage-context.js';
    import { appPath } from '$lib/shared/api-urls.js';
    import { Z } from '$lib/utils/z-index';
    import SeasonThumbnailAction from '$lib/components/admin/media/SeasonThumbnailAction.svelte';
    import ImagesTab from '$lib/components/admin/media/ImagesTab.svelte';
    import SyncTab from '$lib/components/admin/media/SyncTab.svelte';
    import SeasonDetailTab from '$lib/components/admin/media/SeasonDetailTab.svelte';
    import EpisodesTab from '$lib/components/admin/media/EpisodesTab.svelte';
    import HealthBadge from '$lib/components/admin/media/HealthBadge.svelte';
    import FilesTab from '$lib/components/admin/media/FilesTab.svelte';
    import DiscographyTab from '$lib/components/admin/media/DiscographyTab.svelte';
    import TracksTab from '$lib/components/admin/media/TracksTab.svelte';
    import AudioFeaturesTab from '$lib/components/admin/media/AudioFeaturesTab.svelte';
    import LyricsTab from '$lib/components/admin/media/LyricsTab.svelte';
    import ChaptersTab from '$lib/components/admin/media/ChaptersTab.svelte';
    import AudiobookTab from '$lib/components/admin/media/AudiobookTab.svelte';
    import PipelineTab from '$lib/components/admin/coverage/PipelineTab.svelte';
    import {
        getCatalogPosterUrl,
        getCatalogBackdropUrl,
        getCatalogLogoUrl,
        getCatalogThumbUrl,
    } from '$lib/utils/image-utils';
    import { parseMusicChapters } from '$lib/utils/music-track-metadata';
    import { getMediaTypeLabel } from '$lib/components/admin/media/media-type-badge';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { formatDuration, formatRelativeTime } from '$lib/utils/time-formatting';
    import {
        isMusicType,
        isSeries as _isSeries,
        isSeason as _isSeason,
        isEpisode as _isEpisode,
        isNonEntertainment as _isNonEntertainment,
        isExtra as _isExtra,
        isAudiobook as _isAudiobook,
    } from '$lib/shared/media-types';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import { Play } from 'svelte-hero-icons';

    let overviewRef = $state<OverviewTab | null>(null);
    let searchRef = $state<AdminMediaSearch | null>(null);

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    let healthTooltip = $derived.by(() => {
        const d = data.healthDetail;
        if (!d) return undefined;
        const parts: string[] = [];
        if (d.seasonCountLocal !== d.seasonCountProvider) {
            parts.push(
                m.admin_mediaedit_health_seasons_mismatch({
                    local: d.seasonCountLocal,
                    provider: d.seasonCountProvider,
                }),
            );
        }
        if (d.episodeCountLocal !== d.episodeCountProvider) {
            parts.push(
                m.admin_mediaedit_health_episodes_mismatch({
                    local: d.episodeCountLocal,
                    provider: d.episodeCountProvider,
                }),
            );
        }
        if (data.fileIssues.length > 0) {
            parts.push(
                m.media_issue_episode_problems({
                    count: new Set(data.fileIssues.map((f) => f.mediaItemId)).size,
                }),
            );
        }
        return parts.length > 0 ? parts.join(', ') : undefined;
    });

    /**
     * The badge's own status only compares season and episode counts with the
     * provider. Open file findings must not sit next to a green "Healthy".
     */
    let headerHealthStatus = $derived(
        data.healthStatus === 'healthy' && data.fileIssues.length > 0
            ? 'warning'
            : data.healthStatus,
    );

    /**
     * Same two mismatches as `healthTooltip` above, counted rather than
     * phrased — feeds the Health tab's badge so it stays visible (via the
     * overflow menu's badge passthrough) when the tab itself scrolls off.
     */
    let healthFindingsCount = $derived.by(() => {
        const d = data.healthDetail;
        if (!d) return 0;
        let count = 0;
        if (d.seasonCountLocal !== d.seasonCountProvider) count++;
        if (d.episodeCountLocal !== d.episodeCountProvider) count++;
        return count;
    });

    /**
     * Total health issues across every file, not the count of files that
     * have one — `FileIssuesPanel` computes its own header count the same
     * way. A "3" on the Files tab should mean three problems, not three
     * files (one of which might carry two).
     */
    let fileFindingsCount = $derived(data.fileIssues.reduce((sum, f) => sum + f.issues.length, 0));

    type TabId =
        | 'overview'
        | 'episodes'
        | 'ordering'
        | 'health'
        | 'season'
        | 'discography'
        | 'tracks'
        | 'audio-features'
        | 'lyrics'
        | 'chapters'
        | 'book'
        | 'files'
        | 'artwork'
        | 'maintenance';

    interface TabDef {
        id: TabId;
        label: string;
        icon: typeof InformationCircle;
        seriesOnly?: boolean;
        seasonOnly?: boolean;
        episodesTabVisible?: boolean;
        /** Show only for artist media type */
        artistOnly?: boolean;
        /** Show only for album media type */
        albumOnly?: boolean;
        /** Show only for track media type */
        trackOnly?: boolean;
        /** Show only for audiobook media type */
        audiobookOnly?: boolean;
        /**
         * Hide for audiobooks.
         *
         * Distinct from the `*Only` flags: this is for a tab that applies to
         * everything EXCEPT books, which is the shape of every tab backed by
         * `media_files` — an audiobook's bytes live on the AudiobookShelf server
         * and the row has no file records at all.
         */
        hideForAudiobook?: boolean;
    }

    const allTabs: TabDef[] = [
        {
            id: 'overview',
            label: m.media_tab_overview(),
            icon: InformationCircle,
        },
        {
            id: 'episodes',
            label: m.media_tab_episodes(),
            icon: QueueList,
            episodesTabVisible: true,
        },
        {
            id: 'discography',
            label: m.media_tab_discography(),
            icon: MusicalNote,
            artistOnly: true,
        },
        {
            id: 'tracks',
            label: m.media_tab_tracks(),
            icon: QueueList,
            albumOnly: true,
        },
        {
            id: 'audio-features',
            label: m.media_tab_audio_features(),
            icon: Microphone,
            trackOnly: true,
        },
        {
            id: 'lyrics',
            label: m.media_tab_lyrics(),
            icon: BookOpen,
            trackOnly: true,
        },
        {
            id: 'chapters',
            label: m.media_tab_chapters(),
            icon: Bars3BottomLeft,
            trackOnly: true,
        },
        {
            id: 'book',
            label: m.media_tab_book(),
            icon: BookOpen,
            audiobookOnly: true,
        },
        {
            id: 'files',
            label: m.media_tab_files(),
            icon: DocumentText,
            hideForAudiobook: true,
        },
        { id: 'artwork', label: m.media_redesign_artwork(), icon: Photo },
        { id: 'maintenance', label: m.media_redesign_maintenance(), icon: ArrowPath },
    ];

    let isSeries = $derived(_isSeries(data.mediaItem.mediaType));
    let isSeason = $derived(_isSeason(data.mediaItem.mediaType));
    let isEpisode = $derived(_isEpisode(data.mediaItem.mediaType));
    let isMusicItem = $derived(isMusicType(data.mediaItem.mediaType));
    let isNonEntertainmentItem = $derived(_isNonEntertainment(data.mediaItem.mediaType));
    let isExtraItem = $derived(_isExtra(data.mediaItem.mediaType));
    let isArtistItem = $derived(data.mediaItem.mediaType === 'artist');
    let isAlbumItem = $derived(data.mediaItem.mediaType === 'album');
    let isTrackItem = $derived(data.mediaItem.mediaType === 'track');
    let isAudiobookItem = $derived(_isAudiobook(data.mediaItem.mediaType));

    const musicBack = $derived.by(() => {
        const artistTracks = musicContextParams($page.url.searchParams).get(
            'music_from_artist_tracks',
        );
        if (
            (isTrackItem || isAlbumItem) &&
            artistTracks &&
            !(isTrackItem && musicContextParams($page.url.searchParams).get('music_from_album'))
        ) {
            const params = artistTracksReturnParams($page.url.searchParams);
            return {
                href: `/admin/library/media/${artistTracks}?${params.toString()}`,
                label: m.music_credits_back_artist_tracks(),
            };
        }
        const album = isTrackItem
            ? data.parentChain.find((ancestor) => ancestor.mediaType === 'album')
            : null;
        const artist = isAlbumItem
            ? data.parentChain.find((ancestor) => ancestor.mediaType === 'artist')
            : null;
        const parent = album ?? artist;
        if (!parent) return null;
        const params = musicContextParams($page.url.searchParams);
        params.delete(album ? 'music_from_album' : 'music_from_artist');
        if (artist)
            for (const key of [
                'tracks_q',
                'tracks_issue',
                'tracks_sort',
                'tracks_page',
                'music_from_album',
            ])
                params.delete(key);
        params.set('tab', album ? 'tracks' : 'discography');
        return {
            href: `/admin/library/media/${parent.id}?${params.toString()}`,
            label: album ? m.media_music_back_tracks() : m.media_music_back_discography(),
        };
    });
    let editNavigation = $state(0);
    let consumedEditRequest: string | null = null;
    afterNavigate(() => {
        editNavigation += 1;
    });
    $effect(() => {
        const url = $page.url;
        const requestedId = data.mediaItem.id;
        const overview = overviewRef;
        const requestKey = `${editNavigation}:${url.pathname}${url.search}`;
        if (url.searchParams.get('edit') !== '1') {
            consumedEditRequest = null;
            return;
        }
        // The loaded item and the page store can flush separately during a
        // reused-route navigation. Never apply the previous item's edit URL.
        if (url.pathname !== resolve(`/admin/library/media/${requestedId}`) || !overview) return;
        untrack(() => {
            if (consumedEditRequest === requestKey || !overview.startEditing(requestedId)) return;
            consumedEditRequest = requestKey;
            const target = new URL(url);
            target.searchParams.delete('edit');
            replaceState(target, $page.state);
        });
    });

    // "Single act — don't split" flag for artist rows whose name contains a
    // conjunction/ampersand that is part of one act's identity (e.g. "Above &
    // Beyond") rather than a real collaboration. Persisted at
    // custom_metadata.no_split; honored by the scanner's collaboration merge.
    let noSplit = $state(false);
    let noSplitSaving = $state(false);

    // Re-sync the toggle when navigating between artists (this route's component
    // is reused, so a one-time initializer would show the previous artist's flag).
    $effect(() => {
        void data.mediaItem.id;
        noSplit = Boolean(
            (data.audioFeatures as Record<string, unknown> | null | undefined)?.no_split,
        );
    });

    async function toggleNoSplit(event: Event): Promise<void> {
        const input = event.currentTarget as HTMLInputElement;
        if (noSplitSaving) {
            input.checked = noSplit;
            return;
        }
        const next = !noSplit;
        const id = data.mediaItem.id;
        noSplitSaving = true;
        try {
            const res = await setArtistNoSplit(id, next);
            // A response for an artist we already left must not flip this one's toggle.
            if (id !== data.mediaItem.id) return;
            if (!res.error && res.data) {
                noSplit = next;
                toasts.success(next ? m.music_single_act_saved() : m.music_single_act_cleared());
            } else {
                input.checked = noSplit; // revert the native checkbox to persisted state
                toasts.error(m.media_plain_single_act_failed());
            }
        } catch {
            input.checked = noSplit;
            toasts.error(m.media_plain_single_act_failed());
        } finally {
            noSplitSaving = false;
        }
    }

    function playTrack(trackId?: string, trackTitle?: string): void {
        const id = trackId ?? data.mediaItem.id;
        const title = trackTitle ?? data.mediaItem.title;
        const artistAncestor = data.parentChain.find((a) => a.mediaType === 'artist');
        const albumAncestor = data.parentChain.find((a) => a.mediaType === 'album');
        void musicPlayerStore.startPlayback(
            musicTrackFromCard({
                id,
                title: title ?? m.admin_mediaedit_unknown_track(),
                artists: [
                    {
                        id: artistAncestor?.id ?? data.artistId ?? null,
                        title: artistAncestor?.title ?? m.music_unknown_artist(),
                    },
                ],
                type: 'track',
                durationMs:
                    data.mediaItem.runtimeSeconds == null
                        ? null
                        : Math.round(data.mediaItem.runtimeSeconds * 1000),
                album: albumAncestor
                    ? { id: albumAncestor.id, title: albumAncestor.title ?? '' }
                    : null,
                chapters: parseMusicChapters(data.audioFeatures?.chapters),
            }),
        );
    }

    let tabs = $derived(
        allTabs
            .filter((t) => {
                if (t.seriesOnly && !isSeries) return false;
                if (t.seasonOnly && !isSeason) return false;
                if (t.episodesTabVisible && !isSeries && !isSeason) return false;
                if (t.artistOnly && !isArtistItem) return false;
                if (t.albumOnly && !isAlbumItem && !isArtistItem) return false;
                if (t.trackOnly && !isTrackItem) return false;
                if (t.audiobookOnly && !isAudiobookItem) return false;
                if (t.hideForAudiobook && isAudiobookItem) return false;
                return true;
            })
            .map((t) => {
                if (t.id === 'episodes') return { ...t, badge: healthFindingsCount };
                if (t.id === 'files') return { ...t, badge: fileFindingsCount };
                return t;
            }),
    );
    // Start on the tab the URL names, so the server-rendered page (shown until
    // hydration, which can take seconds on a big page) already matches it.
    const initialUrlTab = $page.url.searchParams.get('tab') as TabId | null;
    let activeTab = $state<TabId>(
        initialUrlTab && untrack(() => tabs).some((t) => t.id === initialUrlTab)
            ? initialUrlTab
            : 'overview',
    );
    // svelte-ignore state_referenced_locally
    let lastItemId = data.mediaItem.id;

    $effect(() => {
        if (data.mediaItem.id !== lastItemId) {
            lastItemId = data.mediaItem.id;
            const validIds = tabs.map((t) => t.id);
            // Prefer the tab carried in the URL (back-nav, or sidebar-carried ?tab=),
            // then fall back to the currently active tab, then overview.
            // Never call goto here: $page.url may still be the OLD URL when this
            // effect fires (data prop can update before the $page store flushes),
            // so any goto using $page.url.pathname would navigate back to the
            // previous item.
            const urlTab = $page.url.searchParams.get('tab') as TabId | null;
            const candidate = (urlTab ?? activeTab) as TabId;
            activeTab = validIds.includes(candidate) ? candidate : 'overview';
            // Page-level state that belongs to the item we left. A delete dialog
            // left open (back/forward while it showed) must not carry the old
            // item's cascade count onto this one, and a reorder in progress was
            // for the old series.
            closeDeleteDialog();
            reorderMode = false;
            return;
        }
        const validIds = tabs.map((t) => t.id);
        if (!validIds.includes(activeTab)) {
            activeTab = 'overview';
        }
    });

    // Sidebar context
    // seriesId is null when the ancestor chain could not be resolved (or item has no parent).
    // Never fall back to data.mediaItem.id here — passing the item's own UUID as a series ID
    // would silently query the wrong resource in EpisodesTab / SeasonDetailTab / MediaHierarchySidebar.
    let seriesId = $derived<string | null>(data.seriesId);
    // Extras are excluded even though they always have a parent: an `extra`
    // sits OUTSIDE the series/season tree the sidebar navigates, so `seriesId`
    // is null for the common case (a trailer under a movie) and the fallback
    // aside rendered a yellow "Hierarchy unavailable" for an item whose
    // hierarchy is perfectly intact. There is no tree to show; the breadcrumb
    // names the parent, which is the actual question ("which film is this
    // trailer for").
    let showSidebar = $derived((isSeries || data.parentChain.length > 0) && !isExtraItem);
    let activeSeason = $state<number | null>(null);
    let reorderMode = $state(false);

    // How many rows the visible sidebar will render, for the auto-collapse rule.
    // Computed server-side (+page.server.ts): the season count for a series or
    // season/episode page, the album count for a music page, or `null` when
    // none applies or the count could not be determined. `null` must stay
    // `null` here — shouldAutoCollapse treats it as "unknown", not "empty".
    let sidebarEntryCount = $derived(data.sidebarEntryCount);

    // Initial value applies only the entry-count half of the auto-collapse
    // rule: there is no `window` during SSR, so the viewport half cannot run
    // until hydration (the $effect below adds it). Without this, every fresh
    // load of a page the auto rule would collapse -- e.g. an artist with one
    // album -- rendered the full 288px sidebar first and closed it a tick
    // later. The residual gap this leaves (a wide entry count on a narrow
    // browser window renders expanded until the effect corrects it) is an
    // accepted limit, not a bug -- closing it would need a preference cookie,
    // which is more infrastructure than this visual is worth.
    // svelte-ignore state_referenced_locally
    let sidebarCollapsed = $state(shouldAutoCollapseByEntryCount(data.sidebarEntryCount));

    $effect(() => {
        if (!browser) return;
        const stored = loadSidebarCollapsed(localStorage);
        sidebarCollapsed = stored ?? shouldAutoCollapse(sidebarEntryCount, window.innerWidth);
    });

    $effect(() => {
        adminNavPrefs.setHierarchyExpanded(
            (showSidebar || (isMusicItem && !!data.artistId)) && !sidebarCollapsed,
        );
        return () => adminNavPrefs.setHierarchyExpanded(false);
    });

    function toggleSidebar(): void {
        sidebarCollapsed = !sidebarCollapsed;
        saveSidebarCollapsed(browser ? localStorage : null, sidebarCollapsed);
    }

    // Drives which controls the header's control row offers — see
    // media-actions.ts, the cross-surface registry (spec §4.4).
    let actionCtx = $derived<ActionContext>({
        mediaType: data.mediaItem.mediaType,
        surface: 'detail',
        // Fails OPEN when the file summary could not be determined (a DB
        // hiccup, not a genuine "no files") — see fileSummaryDetermined in
        // +page.server.ts. A Play/Watch link that 404s is a smaller harm than
        // silently hiding one that works.
        hasFiles: data.fileSummary.count > 0 || !data.fileSummaryDetermined,
        childCount: data.childCounts?.episodes ?? 0,
        // A never-synced series has 0 episode rows, and a cascading sync is what
        // fetches them; see hasCascadableContainer.
        hasCascadableContainer: isSeries,
        locked: data.lockStatus.locked,
        pageState: { isSeries, reorderMode },
    });
    let actions = $derived(new Set(actionsFor(actionCtx).map((a) => a.id)));

    // Lifted from OverviewTab so the header's Lock action can trigger the same
    // unlock call; OverviewTab's own Lock banner button calls this via a prop.
    let unlocking = $state(false);
    let metadataBusyCounts = $state<Record<string, number>>({});
    const metadataBusy = $derived((metadataBusyCounts[data.mediaItem.id] ?? 0) > 0);
    function metadataBusyChanged(id: string, busy: boolean): void {
        const count = (metadataBusyCounts[id] ?? 0) + (busy ? 1 : -1);
        if (count > 0) metadataBusyCounts[id] = count;
        else delete metadataBusyCounts[id];
    }

    async function handleUnlock(): Promise<void> {
        if (unlocking || metadataBusy) return;
        unlocking = true;
        try {
            const { data: unlockResult, error } = await unlockMediaMetadata(data.mediaItem.id);
            if (error || !unlockResult) {
                toasts.error(m.media_overview_unlock_failed());
                return;
            }
            toasts.success(m.media_overview_unlock_success());
            await invalidateAll();
        } catch {
            toasts.error(m.media_overview_unlock_failed());
        } finally {
            unlocking = false;
        }
    }

    // ------------------------------------------------------------------
    // Triage redesign (spec §7): one Actions menu, issues strip, triage bar
    // ------------------------------------------------------------------

    let actionsMenuOpen = $state(false);
    let albumMergeRef = $state<AlbumMerge | undefined>();

    let identifyTarget = $state<{ id: string; title: string; mediaType: string } | null>(null);

    function tabHref(tab: TabId, section?: string, edit = false): string {
        return resolve(
            detailTabPath(data.mediaItem.id, $page.url.searchParams, tab, section, edit),
        );
    }
    function openTab(tab: TabId, section?: string, edit = false): void {
        void goto(tabHref(tab, section, edit), { noScroll: true, keepFocus: true });
    }

    function fixIssue(issue: MediaIssue): void {
        switch (mediaIssueFix(issue)) {
            case 'identify':
                identifyTarget = {
                    id: data.mediaItem.id,
                    title: data.mediaItem.title,
                    mediaType: data.mediaItem.mediaType,
                };
                return;
            case 'syncImages':
                openTab('artwork');
                return;
            case 'syncMetadata':
                openTab('maintenance', 'metadata');
                return;
            case 'showFiles':
                // The label promises the Files tab; every item but an audiobook
                // (no local files, so no Files tab) has one.
                openTab('files');
                return;
            case 'merge':
                void goto(resolve('/admin/library/media?view=duplicates'));
                return;
        }
    }

    /** The saved list page this item was opened from, if any. */
    let triage = $state<TriagePosition | null>(null);
    /** Issue count when this item was opened: "No issues left" only after fixing some. */
    let issuesAtOpen = $state(0);
    /** Problems get the strip; info notes (Not linked to Jellyfin) one muted line. */
    let detailProblems = $derived(problemIssues(data.issues));
    let detailNotes = $derived(noteIssues(data.issues));
    $effect(() => {
        const id = data.mediaItem.id;
        issuesAtOpen = untrack(() => data.issues.length);
        if (!browser) {
            triage = null;
            return;
        }
        const context = loadTriageContext(sessionStorage);
        let position = triagePosition(context, id);
        if (!position) {
            for (const ancestor of data.parentChain) {
                const ancestorPosition = triagePosition(context, ancestor.id);
                if (ancestorPosition) {
                    position = { ...ancestorPosition, prevHref: null, nextHref: null };
                    break;
                }
            }
        }
        triage = position;
    });

    // Lifted from OverviewTab so the delete confirmation dialog exists exactly
    // once in the tree — both the header's Delete action and OverviewTab's
    // Danger Zone button trigger it via the same function.
    let showDeleteDialog = $state(false);
    let deleteConfirmInput = $state('');
    let deleting = $state(false);
    let cascadeChildCount = $state<number | null>(null); // non-null → in cascade-confirm mode

    // See delete-confirm.ts: a season's raw title can be '' (not null), and
    // matching the input against that directly let Delete unlock with
    // nothing typed. `deleteConfirmExpected` is what the dialog's label and
    // placeholder show the operator to type.
    let deleteConfirmExpected = $derived(deleteConfirmExpectedValue(data.mediaItem.title));
    let deleteConfirmUsingFallback = $derived(data.mediaItem.title.trim().length === 0);
    let deleteConfirmed = $derived(isDeleteConfirmed(deleteConfirmInput, data.mediaItem.title));

    function openDeleteDialog(): void {
        deleteConfirmInput = '';
        cascadeChildCount = null;
        showDeleteDialog = true;
    }

    function closeDeleteDialog(): void {
        showDeleteDialog = false;
        deleteConfirmInput = '';
        cascadeChildCount = null;
    }

    async function handleDelete(cascade = false): Promise<void> {
        if (!deleteConfirmed || deleting) return;
        // Snapshot the item: the redirect and toast must name the item that was
        // deleted even if navigation swaps `data` while the request runs.
        const { id, title, parentId } = data.mediaItem;
        const parentChain = data.parentChain;
        deleting = true;
        try {
            const { error, status, details } = await deleteMedia(id, { cascade });
            if (!error) {
                toasts.success(m.media_overview_delete_success({ title }));
                // closeDeleteDialog, not just hiding it: a cascade count left
                // behind would open the next item's dialog in cascade mode.
                closeDeleteDialog();
                await goto(appPath(afterDeletePath(parentId, parentChain)));
                return;
            }
            // The decision (cascade-confirm vs generic failure) is pure logic
            // lifted into detail-actions.ts so it is unit-tested independent of
            // this fetch — see decideDeleteFailureAction.
            const decision = decideDeleteFailureAction(status, details, { cascade });
            if (decision.kind === 'confirmCascade') {
                cascadeChildCount = decision.childCount; // stay open, switch to cascade-confirm
                return;
            }
            toasts.error(typeof error === 'string' ? error : m.media_overview_delete_failed());
        } catch {
            toasts.error(m.media_overview_delete_failed());
        } finally {
            deleting = false;
        }
    }

    // Small poster for the header. Episodes have no poster of their own — a
    // poster request walks up to the season/series poster — so show the episode's
    // own still (landscape thumb) instead, which is what identifies the episode.
    let artworkRevision = $state(0);
    function handleArtworkSaved(): void {
        artworkRevision = Date.now();
        void invalidateAll();
    }
    let headerPosterUrl = $derived(
        (isEpisode
            ? getCatalogThumbUrl(data.mediaItem.id, { size: 'thumb' })
            : getCatalogPosterUrl(data.mediaItem.id, { size: 'thumb' })) + `&v=${artworkRevision}`,
    );

    let headerPosterVisible = $state(false);

    // Reset visibility when item changes so broken images don't persist
    $effect(() => {
        void data.mediaItem.id;
        headerPosterVisible = false;
    });

    // Current image URLs for the images tab.
    // Use fallback:'none' so a missing image 404s instead of redirecting to the
    // popcorn placeholder — otherwise ImageDropZone's <img> loads the placeholder
    // successfully, mistakes it for a real custom/provider image, and shows a
    // bogus "Remove" button that can't remove anything (there's no local artwork
    // row for a placeholder). With 404 the drop-zone shows its empty state and
    // hides Remove; real provider/TMDB images still return 200 and display.
    let currentPosterUrl = $derived(
        getCatalogPosterUrl(data.mediaItem.id, { size: 'full', fallback: 'none' }),
    );
    let currentBackdropUrl = $derived(
        getCatalogBackdropUrl(data.mediaItem.id, { size: 'full', fallback: 'none' }),
    );
    let currentLogoUrl = $derived(getCatalogLogoUrl(data.mediaItem.id, { fallback: 'none' }));
    let currentThumbUrl = $derived(
        getCatalogThumbUrl(data.mediaItem.id, { size: 'full', fallback: 'none' }),
    );

    async function handleReorderSave(
        items: Array<{ id: string; episodeNumber: number }>,
    ): Promise<void> {
        // Reorder is only available when viewing a series (isSeries === true),
        // in which case the current item IS the series. Captured before the
        // request: the page can move to another item while it runs.
        const seriesItemId = data.mediaItem.id;
        try {
            const res = await fetch(`/api/admin/media/${seriesItemId}/episodes/reorder`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            });
            if (!res.ok) {
                toasts.error(m.admin_toast_failed_to_save_episode_order());
                return;
            }
            toasts.success(m.admin_toast_episode_order_saved());
            if (seriesItemId === data.mediaItem.id) reorderMode = false;
            void invalidateAll();
        } catch {
            toasts.error(m.admin_toast_failed_to_save_episode_order());
        }
    }

    // Breadcrumb construction from parentChain
    let breadcrumbs = $derived.by(() => {
        const crumbs: Array<{ label: string; href?: string }> = [
            { label: m.media_label_media(), href: '/admin/library/media' },
        ];

        for (const ancestor of data.parentChain) {
            if (_isSeries(ancestor.mediaType)) {
                crumbs.push({
                    label: ancestor.title ?? m.media_series(),
                    href: `/admin/library/media/${ancestor.id}`,
                });
            } else if (_isSeason(ancestor.mediaType)) {
                crumbs.push({
                    // `||`: a season's title can be '' (see delete-confirm.ts).
                    label:
                        ancestor.title ||
                        m.admin_mediaedit_season_n({ number: ancestor.seasonNumber ?? '?' }),
                    href: `/admin/library/media/${ancestor.id}`,
                });
            } else if (ancestor.mediaType === 'artist') {
                crumbs.push({
                    label: ancestor.title ?? m.admin_mediaedit_artist(),
                    href: `/admin/library/media/${ancestor.id}`,
                });
            } else if (ancestor.mediaType === 'album') {
                crumbs.push({
                    label: ancestor.title ?? m.media_album(),
                    href: `/admin/library/media/${ancestor.id}`,
                });
            } else if (ancestor.title) {
                // Any other ancestor type still gets a crumb. The four cases
                // above are the hierarchy levels that need a TYPED fallback
                // label; dropping everything else meant an `extra` whose parent
                // is a movie or an episode showed no ancestry at all, on the one
                // screen where "which film is this trailer for" is the question.
                // Gated on a title because there is no generic name worth
                // inventing for an untitled row.
                crumbs.push({
                    label: ancestor.title,
                    href: `/admin/library/media/${ancestor.id}`,
                });
            }
        }

        crumbs.push({
            label:
                isSeason && !data.mediaItem.title
                    ? m.admin_mediaedit_season_n({ number: data.mediaItem.seasonNumber ?? '?' })
                    : data.mediaItem.title,
        });
        return crumbs;
    });

    function handleSeasonSelect(seasonNumber: number): void {
        activeSeason = seasonNumber;
    }

    // Sync activeSeason from URL (handles initial load and back/forward navigation)
    $effect(() => {
        const seasonParam = $page.url.searchParams.get('season');
        if (seasonParam) {
            const parsed = parseInt(seasonParam, 10);
            if (!isNaN(parsed)) activeSeason = parsed;
        } else {
            activeSeason = null;
        }
    });

    // Track recent items for quick-nav search
    $effect(() => {
        searchRef?.trackRecent({
            id: data.mediaItem.id,
            title: data.mediaItem.title,
            mediaType: data.mediaItem.mediaType,
            year: data.mediaItem.year ?? null,
        });
    });
</script>

<!-- Breadcrumb + quick-nav search. Search is global navigation, not an action
     on this item, so it lives here rather than in the item's control row. -->
<div class="flex items-center justify-between gap-4">
    <div class="min-w-0 flex-1">
        <AdminBreadcrumb crumbs={breadcrumbs} />
    </div>
    <div class="shrink-0">
        <AdminMediaSearch bind:this={searchRef} />
    </div>
</div>

<!-- Two-panel layout -->
<div class="flex flex-col md:flex-row">
    <!-- Sidebar -->
    {#if isMusicItem && data.artistId}
        <MusicHierarchySidebar
            artistId={data.artistId}
            currentItemId={data.mediaItem.id}
            collapsed={sidebarCollapsed}
            ontoggle={toggleSidebar} />
    {:else if isMusicItem}
        <!-- Music item with no resolved artistId (ancestor chain unavailable).
             Collapsed to the same 40px rail as the real sidebar's collapsed
             state — a "hierarchy unavailable" notice was never worth 256px. -->
        <aside
            class="w-10 shrink-0 border-r border-surface-700 flex flex-col items-center gap-2 py-3"
            aria-label={m.admin_mediaedit_hierarchy_unavailable()}
            title={m.admin_mediaedit_hierarchy_unavailable()}>
            <Icon src={InformationCircle} class="w-5 h-5 text-warning-400" />
            {#if data.mediaItem.parentId}
                <a
                    href={resolve(`/admin/library/media/${data.mediaItem.parentId}`)}
                    class="text-primary-400 hover:text-primary-300 text-lg leading-none"
                    title={m.admin_mediaedit_go_to_parent()}>
                    &uarr;
                </a>
            {/if}
        </aside>
    {:else if showSidebar && seriesId}
        <MediaHierarchySidebar
            {artworkRevision}
            {seriesId}
            currentItemId={data.mediaItem.id}
            {activeSeason}
            {reorderMode}
            collapsed={sidebarCollapsed}
            ontoggle={toggleSidebar}
            onseasonselect={handleSeasonSelect}
            onreorderstart={() => {
                reorderMode = true;
            }}
            onreordercancel={() => {
                reorderMode = false;
            }}
            onreordersave={handleReorderSave} />
    {:else if showSidebar}
        <!-- showSidebar is true but seriesId could not be resolved. Collapsed to
             the same 40px rail as the real sidebar's collapsed state — a
             "hierarchy unavailable" notice was never worth 256px. -->
        <aside
            class="w-10 shrink-0 border-r border-surface-700 flex flex-col items-center gap-2 py-3"
            aria-label={m.admin_mediaedit_hierarchy_unavailable()}
            title={m.admin_mediaedit_hierarchy_unavailable()}>
            <Icon src={InformationCircle} class="w-5 h-5 text-warning-400" />
            {#if data.mediaItem.parentId}
                <a
                    href={resolve(`/admin/library/media/${data.mediaItem.parentId}`)}
                    class="text-primary-400 hover:text-primary-300 text-lg leading-none"
                    title={m.admin_mediaedit_go_to_parent()}>
                    &uarr;
                </a>
            {/if}
        </aside>
    {/if}

    <!-- Detail panel -->
    <div class="flex-1 min-w-0">
        {#if data.mediaItem.mediaType === 'album'}
            {#key data.mediaItem.id}
                <div class="px-6">
                    <AlbumMerge
                        bind:this={albumMergeRef}
                        hideTrigger
                        albumId={data.mediaItem.id}
                        initialTarget={$page.url.searchParams.get('mergeWith') ?? undefined}
                        onmerged={(id) => {
                            void goto(resolve(`/admin/library/media/${id}`), {
                                invalidateAll: true,
                            });
                        }} />
                </div>
            {/key}
        {/if}
        <!-- Header (sticky) -->
        <div class="p-3 sm:p-6 pb-0">
            {#if musicBack}<a
                    class="mb-4 inline-flex text-sm text-yellow-300 hover:underline"
                    href={resolve(musicBack.href)}>{musicBack.label}</a
                >{/if}
            {#if triage}
                <nav
                    class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-surface-700 bg-surface-800/50 px-3 py-2 text-sm"
                    aria-label={m.media_triage_label()}
                    data-testid="triage-bar">
                    <div class="flex items-center gap-3">
                        <a
                            href={triage.listHref}
                            class="inline-flex items-center gap-1 font-medium text-yellow-300 hover:text-yellow-200">
                            <Icon src={ChevronLeft} class="w-4 h-4" />
                            {triage.viewLabel}
                        </a>
                        <span class="text-surface-400">
                            {m.media_triage_position({ index: triage.index, total: triage.total })}
                        </span>
                    </div>
                    <div class="flex items-center gap-2">
                        {#if triage.prevHref}
                            <a
                                href={triage.prevHref}
                                class="inline-flex items-center gap-1 rounded border border-surface-600 px-2.5 py-1 text-xs text-surface-200 hover:bg-surface-700"
                                ><Icon
                                    src={ChevronLeft}
                                    class="w-3.5 h-3.5" />{m.media_triage_previous()}</a>
                        {/if}
                        {#if triage.nextHref}
                            <a
                                href={triage.nextHref}
                                class="inline-flex items-center gap-1 rounded border border-surface-600 bg-surface-700 px-2.5 py-1 text-xs font-medium text-surface-100 hover:bg-surface-600"
                                >{m.media_triage_next()}<Icon
                                    src={ChevronRight}
                                    class="w-3.5 h-3.5" /></a>
                        {/if}
                    </div>
                </nav>
            {/if}
            <div class="mb-4 flex flex-col gap-3">
                <!-- Identity row: poster + title + metadata. The title must never be the
                     thing that shrinks — see the min-w-0/flex-1 note below. -->
                <div class="flex items-start gap-4">
                    <!-- Poster thumbnail -->
                    <img
                        src={headerPosterUrl}
                        alt=""
                        class="{isEpisode
                            ? 'w-28 h-16'
                            : 'w-16 h-24'} rounded-lg object-cover bg-surface-800 shrink-0 {headerPosterVisible
                            ? ''
                            : 'hidden'}"
                        onload={() => (headerPosterVisible = true)}
                        onerror={(e) => {
                            headerPosterVisible = false;
                            (e.currentTarget as HTMLImageElement).src = '';
                        }} />
                    {#if !headerPosterVisible}
                        <div
                            class="{isEpisode
                                ? 'w-28 h-16'
                                : 'w-16 h-24'} rounded-lg bg-surface-800/60 border border-surface-700/40 shrink-0 flex items-center justify-center">
                            <Icon src={Photo} class="w-6 h-6 text-surface-600" />
                        </div>
                    {/if}
                    <div class="flex-1 min-w-0">
                        {#if isSeason}
                            {#if data.parentChain.length > 0}
                                <div class="text-xs text-surface-400 uppercase tracking-wide mb-1">
                                    {data.parentChain[0]?.title ?? m.media_series()}
                                </div>
                            {/if}
                        {/if}
                        <h2
                            class="text-xl font-bold text-white break-words"
                            title={data.mediaItem.title}>
                            {isSeason
                                ? data.mediaItem.title ||
                                  m.admin_mediaedit_season_n({
                                      number: data.mediaItem.seasonNumber ?? 0,
                                  })
                                : data.mediaItem.title}
                        </h2>
                        <div
                            class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-surface-400 mt-1">
                            <span
                                class="px-2 py-0.5 rounded bg-surface-700/60 text-xs font-medium uppercase">
                                {getMediaTypeLabel(data.mediaItem.mediaType)}
                            </span>
                            {#if isEpisode && data.mediaItem.seasonNumber != null && data.mediaItem.episodeNumber != null && data.mediaItem.parentId}
                                <span class="text-xs font-medium">
                                    <a
                                        href={resolve(
                                            `/admin/library/media/${data.mediaItem.parentId}`,
                                        )}
                                        class="text-surface-300 hover:text-primary-400 hover:underline"
                                        title={m.media_tab_season()}
                                        >S{data.mediaItem.seasonNumber}</a
                                    ><span class="text-surface-400"
                                        >·E{data.mediaItem.episodeNumber}</span>
                                </span>
                            {/if}
                            {#if data.mediaItem.year}
                                <span>{data.mediaItem.year}</span>
                            {/if}
                            {#if isSeries && headerHealthStatus}
                                <HealthBadge status={headerHealthStatus} tooltip={healthTooltip} />
                            {/if}
                            {#if data.musicSummary}
                                <span
                                    >{isAlbumItem
                                        ? m.media_music_collection_summary({
                                              tracks: data.musicSummary.trackCount,
                                              duration: formatDuration(
                                                  data.musicSummary.totalSeconds,
                                              ),
                                          })
                                        : m.media_music_album_summary({
                                              albums: data.musicSummary.albumCount,
                                              tracks: data.musicSummary.trackCount,
                                              duration: formatDuration(
                                                  data.musicSummary.totalSeconds,
                                              ),
                                          })}</span>
                            {/if}
                            {#if data.childCounts}
                                <span>&middot;</span>
                                <span>
                                    {m.admin_mediaedit_seasons_episodes_count({
                                        seasons: data.childCounts.seasons,
                                        episodes: data.childCounts.episodes,
                                    })}
                                </span>
                            {/if}
                            {#if data.fileSummary && data.fileSummary.count > 0}
                                <span>&middot;</span>
                                <span>
                                    {#if data.fileSummary.totalBytes != null}
                                        {data.fileSummary.count === 1
                                            ? m.media_header_files_summary_one({
                                                  size: formatFileSize(data.fileSummary.totalBytes),
                                              })
                                            : m.media_header_files_summary({
                                                  count: data.fileSummary.count,
                                                  size: formatFileSize(data.fileSummary.totalBytes),
                                              })}
                                    {:else}
                                        <!-- file_size_bytes is populated by an async probe;
                                             a not-yet-probed file has a NULL size, which
                                             SUM() drops. "0 B" would read as "empty file"
                                             when the truth is "size not known yet", so fall
                                             back to a bare count instead of fabricating one. -->
                                        {data.fileSummary.count}
                                        {data.fileSummary.count === 1
                                            ? m.media_files_count_singular()
                                            : m.media_files_count_plural()}
                                    {/if}
                                </span>
                            {/if}
                            {#if data.lastSyncedAt}
                                <span>&middot;</span>
                                <span>
                                    {m.media_header_last_synced({
                                        ago: formatRelativeTime(data.lastSyncedAt),
                                    })}
                                </span>
                            {/if}
                            <!-- No "never synced" fallback: provider_metadata.fetched_at
                                 is only ever written for movies/series. Episodes get at
                                 most one still-image backfill write and never again;
                                 music types have no provider_metadata write path at all.
                                 An absent lastSyncedAt on those types cannot be told apart
                                 from "this item's sync isn't recorded here" versus "this
                                 item was truly never synced" -- claiming the stronger,
                                 false-on-most-of-the-library statement would mislead the
                                 operator. Silence is the honest answer. A per-type
                                 suppression list was rejected: it rots the same way the
                                 audiobook filter in the media browser did, silently
                                 missing whatever type is added next. -->
                            {#if data.lockStatus.locked}
                                <span
                                    class="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 text-xs font-medium">
                                    {m.media_header_locked()}
                                </span>
                            {/if}
                        </div>
                    </div>
                </div>

                <!-- Control row. Its own line, so a fixed-width control can never
                     compete with the title for horizontal space. Play/Watch/
                     Reorder/Unlock/Delete are gated by the pure rules in
                     media-actions.ts (the cross-surface registry, spec §4.4),
                     not inline conditions. Diagnose is the one exception: it
                     is a static link to ?tab=maintenance&section=processing that applies to every
                     media type, so there is no rule for it to go through. -->
                <div class="flex flex-wrap items-center gap-2">
                    {#if actions.has('play')}
                        <button
                            class="btn variant-filled-primary text-sm px-4 py-2 inline-flex items-center gap-2"
                            onclick={() => playTrack()}>
                            <Icon src={Play} class="w-4 h-4" />
                            {isEpisode ? m.media_redesign_play_episode() : m.play()}
                        </button>
                    {/if}
                    {#if actions.has('watch')}
                        <a
                            href={resolve(`/watch/${data.mediaItem.id}`)}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="btn variant-filled-primary text-sm px-4 py-2 inline-flex items-center gap-2"
                            title={m.play()}>
                            <Icon src={Play} class="w-4 h-4" />
                            {isEpisode ? m.media_redesign_play_episode() : m.play()}
                        </a>
                    {/if}
                    <button
                        type="button"
                        class="btn variant-ghost-surface text-sm px-4 py-2"
                        onclick={() => openTab('overview', undefined, true)}>
                        {m.media_redesign_edit_metadata()}
                    </button>
                    <!-- One Actions menu (triage spec §7) instead of a row of
                         separate buttons. Destructive actions retain their parent-owned confirmation. Every
                         entry is still gated by the media-actions registry,
                         except Diagnose (a static link to ?tab=maintenance&section=processing that
                         applies to every media type). -->
                    <div class="relative" use:clickOutside={() => (actionsMenuOpen = false)}>
                        <button
                            type="button"
                            class="btn variant-ghost-surface text-sm px-4 py-2 inline-flex items-center gap-2"
                            aria-haspopup="menu"
                            aria-expanded={actionsMenuOpen}
                            onclick={() => (actionsMenuOpen = !actionsMenuOpen)}
                            onkeydown={(e) => {
                                if (e.key === 'Escape') actionsMenuOpen = false;
                            }}>
                            {m.media_redesign_more_actions()}
                            <Icon src={ChevronDown} class="w-4 h-4" />
                        </button>
                        {#if actionsMenuOpen}
                            <div
                                role="menu"
                                tabindex="-1"
                                class="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-surface-700 bg-surface-800 p-1 shadow-xl"
                                onkeydown={(e) => {
                                    if (e.key === 'Escape') actionsMenuOpen = false;
                                }}>
                                {#if actions.has('syncMetadata') && !isMusicItem}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            openTab('maintenance', 'metadata');
                                        }}>
                                        <Icon src={ArrowPath} class="w-4 h-4" />
                                        {mediaActionLabel('syncMetadata')}
                                    </button>
                                {/if}
                                {#if actions.has('syncWithChildren')}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            openTab('maintenance', 'metadata');
                                        }}>
                                        <Icon src={ArrowPath} class="w-4 h-4" />
                                        {mediaActionLabel('syncWithChildren')}
                                    </button>
                                {/if}
                                {#if actions.has('syncImages') && !isMusicItem}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            openTab('artwork');
                                        }}>
                                        <Icon src={Photo} class="w-4 h-4" />
                                        {mediaActionLabel('syncImages')}
                                    </button>
                                {/if}
                                <div class="my-1 h-px bg-surface-700"></div>
                                <a
                                    role="menuitem"
                                    href={tabHref('maintenance', 'processing')}
                                    class="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-surface-100 hover:bg-surface-700"
                                    title={m.admin_mediaedit_diagnose_title()}
                                    onclick={() => (actionsMenuOpen = false)}>
                                    <Icon src={ChartBar} class="w-4 h-4" />
                                    {m.admin_mediaedit_diagnose()}
                                </a>
                                {#if actions.has('reorder')}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            openTab('episodes');
                                        }}>
                                        <Icon src={ArrowsUpDown} class="w-4 h-4" />
                                        {m.admin_mediaedit_reorder()}
                                    </button>
                                {/if}
                                {#if isAlbumItem}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full rounded px-3 py-2 text-left text-sm text-surface-100 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            albumMergeRef?.show();
                                        }}>{m.album_merge_open()}</button>
                                {/if}
                                {#if actions.has('delete')}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full rounded px-3 py-2 text-left text-sm text-red-300 hover:bg-surface-700"
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            openDeleteDialog();
                                        }}>{m.media_overview_delete_button()}</button>
                                {/if}
                                {#if actions.has('unlock')}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-amber-200 hover:bg-surface-700"
                                        disabled={unlocking || metadataBusy}
                                        onclick={() => {
                                            actionsMenuOpen = false;
                                            void handleUnlock();
                                        }}>
                                        <Icon src={LockOpen} class="w-4 h-4" />
                                        {m.media_overview_unlock_button()}
                                    </button>
                                {/if}
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Issues strip (triage spec §7): the same issues and fixes as the
                 browser row and inspector. The item's own file problems stay
                 in FileIssuesPanel below, which has the per-file detail. -->
            {#if detailProblems.length > 0}
                <div class="mb-4 space-y-2" data-testid="detail-issues">
                    {#each detailProblems as issue, i (issue.kind + (issue.subtype ?? '') + i)}
                        <div
                            class="flex flex-wrap items-center gap-3 rounded-lg border border-surface-700 bg-surface-800/40 px-3 py-2">
                            <span
                                class="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium {severityBadgeClass(
                                    issue.severity,
                                )}">
                                <span
                                    class="h-1.5 w-1.5 rounded-full {severityDotClass(
                                        issue.severity,
                                    )}"></span>
                                {mediaIssueLabel(issue, data.mediaItem.mediaType)}
                            </span>
                            {#if issue.detail}
                                <span class="min-w-0 flex-1 truncate text-xs text-surface-400"
                                    >{issue.detail}</span>
                            {:else}
                                <span class="flex-1"></span>
                            {/if}
                            <button
                                type="button"
                                class="rounded border border-surface-600 bg-surface-700 px-2.5 py-1 text-xs font-medium text-surface-100 hover:bg-surface-600"
                                onclick={() => fixIssue(issue)}>
                                {mediaIssueFixLabel(mediaIssueFix(issue))}
                            </button>
                        </div>
                    {/each}
                </div>
            {:else if data.issues.length === 0 && issuesAtOpen > 0 && triage?.nextHref}
                <div
                    class="mb-4 flex items-center gap-3 rounded-lg border border-emerald-800/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
                    <span class="flex-1">{m.media_detail_no_issues_left()}</span>
                    <a
                        class="font-medium text-yellow-300 hover:text-yellow-200"
                        href={triage.nextHref}
                        >{m.media_detail_next_in_view({ view: triage.viewLabel })}</a>
                </div>
            {/if}
            {#each detailNotes as note (note.kind)}
                <p
                    class="mb-4 flex items-center gap-2 text-xs text-surface-500"
                    data-testid="detail-issue-note">
                    <span>{mediaIssueLabel(note, data.mediaItem.mediaType)}</span>
                    <button
                        type="button"
                        class="text-surface-400 underline hover:text-surface-200"
                        onclick={() => fixIssue(note)}>
                        {mediaIssueFixLabel(mediaIssueFix(note))}
                    </button>
                </p>
            {/each}

            <!-- Above the fold on purpose, and outside the tab branches: a
                 broken download is the single most actionable thing about an
                 item, and the browser-row tooltip that surfaced it disappears
                 on click-through -- it should stay visible no matter which
                 tab the operator is on. Audiobooks have no local files, so
                 the panel can never have anything to say about one. -->
            {#if !isAudiobookItem}
                <div class="mb-6">
                    <FileIssuesPanel mediaId={data.mediaItem.id} files={data.fileIssues} />
                </div>
            {/if}

            <!-- Tabs -->
            <!-- size="sm": at "md" the eight tabs of a series overflowed into
                 "More" even on a 1440px screen, hiding Images/Sync/Pipeline. -->
            <Tabs items={tabs} bind:active={activeTab} variant="underline" size="sm" syncToUrl />
        </div>

        <!-- Tab content (scrollable) -->
        <div class="p-3 sm:p-6">
            <!-- Keyed on the item: SvelteKit reuses this page across [id]
                 navigations, and every tab keeps load/edit state for the item it
                 was mounted with. Remounting is what stops a late response or an
                 open editor for the previous item landing in this one. -->
            {#key data.mediaItem.id}
                {#if activeTab === 'overview'}
                    <div class="mb-6 space-y-4">
                        {#if isSeries}
                            <CoverageSummary
                                coverage={data.episodeCoverage}
                                seasons={data.seasonCoverage}
                                onissues={() => {
                                    void goto(tabHref('episodes', 'issues'));
                                }} />
                        {:else if !isAudiobookItem && !isAlbumItem && !isArtistItem}
                            <section
                                class="rounded-xl border border-surface-700 bg-surface-800/40 p-4 space-y-2"
                                aria-label={m.media_redesign_availability()}>
                                <h3 class="font-semibold">{m.media_redesign_availability()}</h3>
                                <p class="text-sm text-surface-300">
                                    {!data.fileSummaryDetermined
                                        ? m.media_redesign_availability_unknown()
                                        : data.fileSummary.count > 0
                                          ? m.media_redesign_physical_files({
                                                count: data.fileSummary.count,
                                            })
                                          : m.media_redesign_catalog_only()}
                                </p>
                                <button
                                    type="button"
                                    class="text-sm text-yellow-300 underline"
                                    onclick={() => openTab('files')}
                                    >{m.media_redesign_inspect_files()}</button>
                            </section>
                        {/if}
                        {#if isAlbumItem || isArtistItem}
                            <section
                                class="rounded-xl border border-surface-700 bg-surface-800/40 p-4 space-y-3">
                                <h3 class="font-semibold">
                                    {isAlbumItem ? m.media_tab_tracks() : m.media_tab_discography()}
                                </h3>
                                {#if data.musicSummary}<p class="text-sm text-surface-300">
                                        {isAlbumItem
                                            ? m.media_music_collection_summary({
                                                  tracks: data.musicSummary.trackCount,
                                                  duration: formatDuration(
                                                      data.musicSummary.totalSeconds,
                                                  ),
                                              })
                                            : m.media_music_album_summary({
                                                  albums: data.musicSummary.albumCount,
                                                  tracks: data.musicSummary.trackCount,
                                                  duration: formatDuration(
                                                      data.musicSummary.totalSeconds,
                                                  ),
                                              })}
                                    </p>{/if}
                                <p class="text-sm text-surface-400">
                                    {m.media_music_curated_metadata()}
                                </p>
                                <button
                                    type="button"
                                    class="text-sm text-yellow-300 underline"
                                    onclick={() => openTab(isAlbumItem ? 'tracks' : 'discography')}
                                    >{isAlbumItem
                                        ? m.media_music_open_tracks()
                                        : m.media_music_open_discography()}</button>
                                <p class="text-xs text-surface-400">
                                    {m.media_music_container_files()}
                                </p>
                            </section>
                        {/if}
                        {#if isEpisode}<SharedFileSummary mediaId={data.mediaItem.id} />{/if}
                        <p class="text-sm text-surface-400">
                            {m.media_redesign_metadata_provenance({
                                provider: data.externalIds.tmdb
                                    ? 'TMDB'
                                    : isAudiobookItem
                                      ? 'AudiobookShelf'
                                      : m.media_redesign_local_metadata(),
                            })}
                            <button
                                type="button"
                                class="ml-2 text-yellow-300 underline"
                                onclick={() => openTab('maintenance', 'metadata')}
                                >{m.media_redesign_metadata()}</button>
                        </p>
                    </div>
                    <OverviewTab
                        languageSummary={data.languageSummary}
                        bind:this={overviewRef}
                        mediaId={data.mediaItem.id}
                        title={data.mediaItem.title}
                        titleSource={data.mediaItem.titleSource}
                        status={data.mediaItem.status}
                        dismissed={data.mediaItem.dismissed}
                        canonicalId={data.mediaItem.canonicalId}
                        onbusychange={metadataBusyChanged}
                        {metadataBusy}
                        lockedAt={data.lockStatus.lockedAt}
                        originalTitle={data.mediaItem.originalTitle}
                        englishTitle={data.mediaItem.englishTitle}
                        year={data.mediaItem.year}
                        overview={data.mediaItem.overview}
                        locked={data.lockStatus.locked}
                        lockedBy={data.lockStatus.lockedBy}
                        mediaType={data.mediaItem.mediaType}
                        createdAt={data.mediaItem.createdAt}
                        updatedAt={data.mediaItem.updatedAt}
                        audioFeatures={data.audioFeatures ?? undefined}
                        customMetadata={isNonEntertainmentItem
                            ? (data.nonEntertainmentMetadata ?? undefined)
                            : undefined}
                        parentArtistId={isAlbumItem
                            ? (data.parentChain.find((a) => a.mediaType === 'artist')?.id ??
                              undefined)
                            : undefined}
                        parentArtistTitle={isAlbumItem
                            ? (data.parentChain.find((a) => a.mediaType === 'artist')?.title ??
                              undefined)
                            : undefined}
                        onUnlock={handleUnlock}
                        {unlocking}
                        onsaved={() => invalidateAll()} />

                    {#if isArtistItem}
                        <p class="mb-4 text-sm text-surface-300">
                            {m.music_credits_collaboration_help()}
                            <a
                                class="text-primary-300 underline"
                                href={resolve(
                                    detailTabPath(
                                        data.mediaItem.id,
                                        $page.url.searchParams,
                                        'tracks',
                                    ),
                                )}>{m.music_credits_review_artist_tracks()}</a>
                        </p>
                        <div
                            class="mt-6 rounded-lg border border-surface-700 bg-surface-800/40 p-4">
                            <label class="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    class="checkbox mt-0.5"
                                    checked={noSplit}
                                    disabled={noSplitSaving}
                                    onchange={toggleNoSplit} />
                                <span class="flex flex-col gap-1">
                                    <span class="text-sm font-medium text-surface-100">
                                        {m.music_single_act_label()}
                                    </span>
                                    <span class="text-xs text-surface-400">
                                        {m.music_single_act_help()}
                                    </span>
                                </span>
                            </label>
                        </div>
                    {/if}
                {:else if activeTab === 'artwork'}
                    <ImagesTab
                        discogsAttribution={data.discogsAttribution}
                        onsaved={handleArtworkSaved}
                        mediaId={data.mediaItem.id}
                        externalIds={data.externalIds}
                        mediaType={data.mediaItem.mediaType}
                        {currentPosterUrl}
                        {currentBackdropUrl}
                        {currentLogoUrl}
                        {currentThumbUrl}
                        maxImageUploadMb={data.maxImageUploadMb} />
                {:else if activeTab === 'episodes'}
                    {#if isSeason && data.seriesId}
                        <EpisodesTab
                            coverage={data.episodeCoverage}
                            seriesId={data.seriesId}
                            initialSeason={data.mediaItem.seasonNumber ?? null} />
                        <details class="mt-6 rounded-lg border border-surface-700 p-4">
                            <summary class="cursor-pointer text-sm font-medium"
                                >{m.media_tab_season()}</summary>
                            <SeasonDetailTab
                                onsaved={handleArtworkSaved}
                                seasonId={data.mediaItem.id}
                                seriesId={data.seriesId}
                                seasonNumber={data.mediaItem.seasonNumber ?? 1} />
                        </details>
                    {:else if isSeason}
                        <!-- Season page: seriesId could not be resolved — safe error state -->
                        <p class="text-sm text-warning-400">
                            {m.admin_mediaedit_series_unavailable()}
                        </p>
                    {:else}
                        <!-- Series page: episodes tab uses the series' own id directly -->
                        <EpisodesTab
                            seriesId={data.mediaItem.id}
                            coverage={data.episodeCoverage}
                            initialSeason={null} />
                    {/if}
                {:else if activeTab === 'discography'}
                    <DiscographyTab artistId={data.mediaItem.id} onsaved={() => invalidateAll()} />
                {:else if activeTab === 'tracks'}
                    <TracksTab
                        albumId={data.mediaItem.id}
                        kind={isArtistItem ? 'artist' : 'album'}
                        onsaved={() => invalidateAll()} />
                {:else if activeTab === 'audio-features'}
                    <AudioFeaturesTab
                        mediaId={data.mediaItem.id}
                        audioFeatures={data.audioFeatures ?? undefined} />
                {:else if activeTab === 'lyrics'}
                    <LyricsTab mediaId={data.mediaItem.id} onsaved={() => invalidateAll()} />
                {:else if activeTab === 'chapters'}
                    <ChaptersTab
                        mediaId={data.mediaItem.id}
                        runtimeSeconds={data.mediaItem.runtimeSeconds}
                        onsaved={() => invalidateAll()} />
                {:else if activeTab === 'book'}
                    {#if data.audiobookDetail}
                        <AudiobookTab detail={data.audiobookDetail} absBaseUrl={data.absBaseUrl} />
                    {:else}
                        <p class="text-sm text-warning-400">
                            {m.media_book_unavailable()}
                        </p>
                    {/if}
                {:else if activeTab === 'files'}
                    {#if isSeason}
                        <SeasonThumbnailAction
                            seasonId={data.mediaItem.id}
                            onsaved={handleArtworkSaved} />
                    {/if}
                    <FilesTab
                        mediaId={data.mediaItem.id}
                        mediaType={data.mediaItem.mediaType}
                        {isSeries}
                        jellyfinId={data.externalIds?.jellyfin} />
                {:else if activeTab === 'maintenance'}
                    {@const rawMaintenanceSection =
                        $page.url.searchParams.get('section') ?? 'metadata'}
                    {@const maintenanceSection = ['metadata', 'processing', 'history'].includes(
                        rawMaintenanceSection,
                    )
                        ? rawMaintenanceSection
                        : 'metadata'}
                    <div
                        class="mb-5 flex flex-wrap gap-2"
                        role="group"
                        aria-label={m.media_redesign_maintenance()}>
                        {#each ['metadata', 'processing', 'history'] as section (section)}
                            <a
                                aria-current={maintenanceSection === section ? 'page' : undefined}
                                class="rounded-lg border border-surface-700 px-3 py-2 text-sm hover:bg-surface-700"
                                href={tabHref('maintenance', section)}>
                                {section === 'metadata'
                                    ? m.media_redesign_metadata()
                                    : section === 'processing'
                                      ? m.media_redesign_processing()
                                      : m.media_redesign_history()}
                            </a>
                        {/each}
                    </div>
                    <p class="mb-4 text-sm text-surface-400">
                        {isSeries
                            ? m.media_redesign_scope_descendants()
                            : m.media_redesign_scope_item()}
                    </p>
                    {#if maintenanceSection === 'metadata'}
                        <SyncTab
                            mediaId={data.mediaItem.id}
                            externalIds={data.externalIds}
                            mediaType={data.mediaItem.mediaType}
                            {isSeries}
                            activeRuns={data.activeRuns}
                            taskSection="metadata"
                            tmdbUrl={data.tmdbUrl}
                            tmdbContext={data.tmdbContext}
                            parentSeriesId={isEpisode || isSeason ? data.seriesId : null}
                            onsaved={handleArtworkSaved} />
                    {:else if maintenanceSection === 'history'}
                        <h3 class="text-lg font-semibold mb-3">{m.media_redesign_history()}</h3>
                        <PipelineTab
                            mediaItemId={data.mediaItem.id}
                            section="history"
                            devMode={$page.data.devToolsEnabled === true} />
                    {:else}
                        <h3 class="text-lg font-semibold mb-3">{m.media_redesign_processing()}</h3>
                        <PipelineTab
                            mediaItemId={data.mediaItem.id}
                            devMode={$page.data.devToolsEnabled === true} />
                        {#if isMusicItem}<p class="my-4 text-sm text-surface-300">
                                {m.media_music_processing_scope()}
                            </p>
                            {#if isTrackItem}<a
                                    class="text-sm text-yellow-300 underline"
                                    href={tabHref('audio-features')}
                                    >{m.media_tab_audio_features()}</a
                                >{/if}
                        {/if}
                        <SyncTab
                            mediaId={data.mediaItem.id}
                            externalIds={data.externalIds}
                            mediaType={data.mediaItem.mediaType}
                            {isSeries}
                            activeRuns={data.activeRuns}
                            taskSection="processing"
                            onsaved={handleArtworkSaved} />
                    {/if}
                {/if}
            {/key}
        </div>
    </div>
</div>

<!-- Delete confirmation dialog. Lifted here from OverviewTab so it exists
     exactly once, regardless of which tab is active or whether it was
     triggered from the header or from OverviewTab's own Danger Zone button. -->
{#if identifyTarget}
    <IdentifyModal
        item={identifyTarget}
        onidentified={(mediaId) => {
            identifyTarget = null;
            if (mediaId !== data.mediaItem.id) {
                void goto(resolve(`/admin/library/media/${mediaId}`));
            } else {
                void invalidateAll();
            }
        }}
        onclose={() => (identifyTarget = null)} />
{/if}

{#if showDeleteDialog}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/60"
        style="z-index: {Z.MODAL}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title">
        <div
            class="bg-surface-800 border border-surface-700 rounded-xl shadow-xl w-full max-w-md mx-4 p-6 space-y-5">
            <h2 id="delete-dialog-title" class="text-lg font-semibold text-error-400">
                {m.media_overview_delete_dialog_title()}
            </h2>
            <p class="text-sm text-surface-300">
                {m.media_overview_delete_dialog_prefix()}
                <strong class="text-surface-100">"{data.mediaItem.title}"</strong>
                {m.media_overview_delete_dialog_suffix()}
            </p>
            {#if cascadeChildCount !== null}
                <p
                    class="text-sm text-warning-300 bg-warning-900/20 border border-warning-700/40 rounded-lg px-3 py-2">
                    {m.media_overview_delete_cascade_warning({ childCount: cascadeChildCount })}
                </p>
            {/if}
            <div class="space-y-1.5">
                <label
                    class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                    for="delete-confirm-input">
                    {deleteConfirmUsingFallback
                        ? m.media_overview_delete_confirm_fallback_label({
                              word: EMPTY_TITLE_DELETE_CONFIRM_WORD,
                          })
                        : m.media_overview_delete_confirm_label()}
                </label>
                <input
                    id="delete-confirm-input"
                    type="text"
                    class="w-full bg-surface-900/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-error-500 focus:outline-none"
                    placeholder={deleteConfirmExpected}
                    bind:value={deleteConfirmInput} />
            </div>
            <div class="flex gap-3 justify-end pt-1">
                <button
                    class="btn variant-ghost-surface text-sm px-4 py-2"
                    onclick={closeDeleteDialog}
                    disabled={deleting}>
                    {m.cancel()}
                </button>
                {#if cascadeChildCount !== null}
                    <button
                        class="btn variant-filled-error text-sm px-4 py-2"
                        onclick={() => handleDelete(true)}
                        disabled={!deleteConfirmed || deleting}>
                        {deleting
                            ? m.media_overview_deleting()
                            : m.media_overview_delete_cascade_button({
                                  childCount: cascadeChildCount,
                              })}
                    </button>
                {:else}
                    <button
                        class="btn variant-filled-error text-sm px-4 py-2"
                        onclick={() => handleDelete(false)}
                        disabled={!deleteConfirmed || deleting}>
                        {deleting
                            ? m.media_overview_deleting()
                            : m.media_overview_delete_confirm_button()}
                    </button>
                {/if}
            </div>
        </div>
    </div>
{/if}
