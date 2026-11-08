<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module>
    import { SvelteMap, SvelteSet, SvelteDate } from 'svelte/reactivity';
</script>

<script lang="ts">
    import '$lib/components/app-shell';
    // =========================================================================
    // i18n Import
    // =========================================================================
    import { tryJoinUpstreamUrl } from '$lib/shared/upstream-url.js';
    import * as m from '$lib/paraglide/messages.js';

    // =========================================================================
    // Widget Components Import
    // =========================================================================
    import MovieCalendar from '$lib/MovieCalendar.svelte';
    import { HeroSection, HeroControls, LiveSessionSection } from '$lib/components/sections';
    import Footer from '$lib/Footer.svelte';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import UserMenuPopover from '$lib/components/user-menu/UserMenuPopover.svelte';
    import LibrarySetupNotice from '$lib/components/LibrarySetupNotice.svelte';
    import PinnedAnnouncementsBanner from '$lib/components/PinnedAnnouncementsBanner.svelte';
    import Search from '$lib/Search.svelte';
    import UpcomingEpisodes from '$lib/UpcomingEpisodes.svelte';
    import HolidayRecommendations from '$lib/HolidayRecommendations.svelte';
    import Watchlist from '$lib/Watchlist.svelte';
    import Trending from '$lib/Trending.svelte';
    import { widgetFeatureKey } from '$lib/config/widget-definitions';
    import { isHolidayWidgetAvailable } from '$lib/config/home-widgets';
    import ForYou from '$lib/ForYou.svelte';
    import LiveTvWidget from '$lib/components/livetv/LiveTvWidget.svelte';
    import WatchParties from '$lib/components/WatchParties.svelte';
    import TableOfContents from '$lib/components/TableOfContents.svelte';
    import CollapsibleSection from '$lib/components/ui/CollapsibleSection.svelte';
    import LazyMount from '$lib/components/ui/LazyMount.svelte';
    import PluginWidgetSlot from '$lib/components/plugins/PluginWidgetSlot.svelte';
    import {
        buildHeroSection,
        buildLocalHeroSection,
        createLoadingHeroSection,
        validateHeroNextUpCache,
    } from '$lib/utils/hero-builder';
    import {
        createInitialState,
        handleInitialFetchComplete,
        handleValidationComplete,
        handleRefreshComplete,
        type HeroRefreshState,
    } from '$lib/utils/hero-refresh-controller';
    import type { PageSection } from '$lib/types/server-driven-ui';
    import { getExternalIdFor } from '$lib/utils/external-ids';
    import { getCatalogBackdropSrcSet, getAvatarUrl } from '$lib/utils/image-utils';
    import { isAudiobook } from '$lib/shared/media-types';
    import { isSeedFresh } from '$lib/utils/ssr-seed';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import type { HeroFirstSlide } from '$lib/schemas/hero';

    // =========================================================================
    // Framework/Utility Imports
    // =========================================================================
    import { browser } from '$app/environment';
    import type { PageData } from './$types';
    import { url, resolve } from '$lib/paths';
    import type { HeroButton } from '$lib/components/admin/navigation';
    import * as userApi from '$lib/api/user';
    import { saveHomeWidgetOrder } from './home-widget-order';
    import { dragHandleZone, dragHandle } from 'svelte-dnd-action';
    import { safeFlip } from '$lib/utils/safe-flip';
    import { JELLYFIN_CONNECT_URL } from '$lib/config/hero-button-labels';

    import {
        Icon,
        Film,
        SpeakerWave,
        BookOpen,
        Tv,
        ArrowDownOnSquareStack,
        MagnifyingGlass,
        RectangleGroup,
        ServerStack,
    } from 'svelte-hero-icons';

    import { writable } from 'svelte/store';
    import { dockVisible } from '$lib/stores/dock.store';
    import type { WatchlistItem } from '$lib/stores/watchlist';
    import type { ExternalIds } from '$lib/types/api-common';

    import { env } from '$env/dynamic/public';
    import { onMount } from 'svelte';
    import { afterNavigate } from '$app/navigation';
    import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
    import { createMinInterval } from '$lib/utils/min-interval';

    // =========================================================================
    // Page Data

    interface Props {
        // =========================================================================
        data: PageData;
    }

    let { data }: Props = $props();

    // Get homepage config from page data (with defaults)
    function getHomepageConfig() {
        return {
            trendingLimit: data.homepage?.trendingLimit ?? 20,
            holidayLimit: data.homepage?.holidayLimit ?? 20,
            dndAnimationMs: data.homepage?.dndAnimationMs ?? 300,
            searchDebounceMs: data.homepage?.searchDebounceMs ?? 300,
            // Admin-controlled widget configuration
            widgetOrder: (data.homepage?.widgetOrder ?? []) as string[],
            widgetVisibility: (data.homepage?.widgetVisibility ?? {}) as Record<string, string>,
        };
    }

    // Reactive config from page data
    let homepageConfig = $derived(getHomepageConfig());

    // =========================================================================
    // State
    // =========================================================================
    let isSearchOpen = $state(false);
    let usesCommandKey = $state(false);
    onMount(() => {
        usesCommandKey = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    });

    // =========================================================================
    // Account menu (avatar) — relocated from the footer into the hero nav row.
    // Opens the shared UserMenuPopover. Derive the avatar URL straight from the
    // SSR'd username (data.user = locals.user) so the real image is present on
    // the first paint instead of flashing the initials fallback while a
    // client-only fetch resolves it. getAvatarUrl resolves against username
    // (DB/Jellyfin/Gravatar all key off username, not the internal UUID).
    // =========================================================================
    let accountAvatarSrc = $derived(data.user?.username ? getAvatarUrl(data.user.username) : '');
    const accountPopup: PopupSettings = {
        event: 'click',
        target: 'accountMenu',
        focusOnOpen: true,
        placement: 'bottom-start',
    };

    type WatchlistComponent = {
        refresh?: () => void;
        addItemImmediately?: (item: WatchlistItem) => void;
    };

    type MovieSavedDetail = {
        externalIds?: ExternalIds;
        title?: string;
        item?: WatchlistItem;
    };

    type DndWidgetItem = Widget & { isDndShadowItem?: boolean };

    let watchlistComponent = $state<WatchlistComponent | null>(null);
    let devMode = import.meta.env.DEV;

    let previewHasAudio = $state(false);
    let mute = $state(true);
    let muteStore = writable(true);
    let heroSection: PageSection = $state(createLoadingHeroSection());

    // Live "is this playing right now" state for the hero, mirrored off the SAME
    // watchingSections the CW carousel consumes (kept fresh by the SSE-driven
    // `invalidate('app:watch-state')`). A Map<id, isPlaying> whose PRESENCE means
    // "the live CW plane knows this item" — so the hero flips BOTH ways in
    // lock-step with the carousel (→ Playing now, and back → Continue Watching)
    // with zero extra fetch. Keyed by internal id AND seriesId so a series-level
    // hero slide matches the specific playing episode. Absent → the hero falls
    // back to the item's own snapshot flag (from the /continue overlay).
    // Whether the SSR payload backing this render is actually recent. `/` is
    // cached by the service worker as an app shell with no TTL, so a
    // cache-served reopen replays every seed below — days later. A stale seed
    // is dropped rather than rendered; the client's own fetches repopulate.
    const ssrSeedFresh = $derived(isSeedFresh(data.ssrRenderedAt as number | null | undefined));

    let cwLiveState = $derived.by(() => {
        const map: Record<string, boolean> = {};
        // A stale seed would pin a bogus "Playing now" badge on the hero for a
        // stream that ended days ago.
        if (!ssrSeedFresh) return map;
        const sections = data.watchingSections as PageSection[] | null | undefined;
        const cw = sections?.find((s) => s.id === 'continue-watching');
        if (!cw) return map;
        for (const item of cw.items) {
            const playing = item.isPlaying === true;
            const internal = getExternalIdFor(item.externalIds, 'internal');
            if (internal) map[internal] = playing;
            // Series-level key ORs across episodes: any playing episode marks
            // the series as playing for a series-level hero slide.
            if (item.seriesId) map[item.seriesId] = (map[item.seriesId] ?? false) || playing;
        }
        return map;
    });

    // Hero carousel control plumbing: the controls cluster (dots/progress/pause/
    // mute) is lifted out of <HeroSection> into its own row below the nav buttons.
    // We hold a component ref (to drive goTo/togglePause/toggleMute) plus bind the
    // hero's exposed carousel view-state so <HeroControls> can render it.
    let heroComponent = $state<ReturnType<typeof HeroSection> | undefined>(undefined);
    let heroCurrentIndex = $state(0);
    let heroSlideCount = $state(0);
    let heroSlideTitles = $state<string[]>([]);
    let heroUserPaused = $state(false);
    let heroAutoplayActive = $state(false);
    let heroMuted = $state(true);
    const heroAutoplayIntervalMs = $derived(data.hero?.autoplayIntervalMs ?? 10000);

    // Hero state from server (determines which hero variant to show)
    let serverHeroState = $derived(data.heroState ?? 'full-metadata');

    // SSR first slide from server (may be null if not available).
    // Gated on seed freshness at this single point so every downstream use is
    // covered: the <link rel=preload>, the render gate, the `firstSlide` prop,
    // and — the one that actually persists — `ssrFirstSlide` into
    // buildHeroSection(). mergeSsrFirstSlide() prepends a non-matching SSR slide
    // as a placeholder, so a days-old seed would otherwise sit pinned at slot 0
    // of the live carousel for the whole session (nothing repolls the hero).
    const heroFirstSlide = $derived(
        ssrSeedFresh ? (data.heroFirstSlide as HeroFirstSlide | null) : null,
    );

    // The option set EVERY hero build in this session must share. It used to be
    // spelled out only at the onMount call site, so `executeHeroRefresh()` — the
    // SWR-revalidation and afterNavigate rebuild — silently dropped both options:
    // the rotated SSR lead lost its slot-0 pin (buildHeroSection does no rotation
    // of its own; mergeSsrFirstSlide is the ONLY thing that puts the lead first),
    // and because the watching pool is sliced to MAX_WATCHING_SLIDES the lead
    // could vanish from the carousel entirely a second after it painted. The cap
    // went with it, so the refreshed carousel also grew past `maxSlides`.
    // Deriving both here means a refresh cannot diverge from the initial build.
    const heroBuildOptions = $derived({
        ssrFirstSlide: heroFirstSlide ?? undefined,
        maxSlides: data.hero?.maxSlides,
    });

    // TMDB nudge dismissal (per-step, stored in DB). Resolved server-side: the
    // page only ever needed this one boolean, so shipping every onboarding row
    // (including `dismissed_by` / `dismissed_at`) was pure payload.
    let tmdbNudgeDismissed = $derived(data.tmdbNudgeDismissed ?? false);
    // Whether TMDB is already configured — heroState can stay 'local-content' even
    // after configuring TMDB (it only flips once external_ids are actually synced),
    // so the nudge needs this separate signal to avoid telling an admin to add TMDB
    // when they already have.
    let tmdbConfigured = $derived(data.tmdbConfigured ?? false);

    async function handleDismissTmdbNudge(): Promise<void> {
        try {
            await userApi.dismissOnboardingStep('tmdb_config');
            window.location.reload();
        } catch {
            /* expected: non-critical — page will reload without dismissing onboarding step */
        }
    }

    // Keep muteStore in sync with mute state
    $effect(() => {
        muteStore.set(mute);
    });

    // Stars background: STAR_LAYERS layers, each one element whose box-shadow
    // draws STARS_PER_LAYER points. It used to be 80 separately animated divs —
    // 80 composited layers blended over the whole viewport on every frame,
    // scrolling included. Each layer now twinkles as a unit (opacity only, so
    // it stays on the compositor) with its own speed and phase.
    const STAR_LAYERS = 4;
    const STARS_PER_LAYER = 20;
    let starLayers: { shadow: string; duration: number; delay: number }[] = $state([]);

    // =========================================================================
    // Permission Helpers (case-insensitive group matching)
    // =========================================================================
    function isAdmin(): boolean {
        const userGroups = data?.user?.userGroups || [];
        const adminGroups = data?.adminGroups || [];
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        const adminGroupsLower = adminGroups.map((g) => g.toLowerCase());
        return userGroupsLower.some((group) => adminGroupsLower.includes(group));
    }

    // =========================================================================
    // Widget Configuration
    // =========================================================================
    interface Widget {
        id: string;
        name: string;
    }

    // Widget visibility rules (permission-based + feature flags)
    const widgetPermissionChecks: Record<string, () => boolean> = {
        // Sessions visible if: feature enabled AND (sessions are public OR user is admin)
        'streaming-sessions': () =>
            data?.features?.sessions !== false &&
            (data?.features?.sessionsPublic !== false || isAdmin()),
        // Parties are folded into Active Streams (party cards + lobby cards), so
        // the standalone widget only renders as a fallback when that one is off.
        'watch-parties': () =>
            data?.features?.watchTogether !== false && !shouldShowWidget('streaming-sessions'),
        // Permission alone isn't enough: with Live TV off (the fresh-install
        // default) /api/livetv/channels is feature-gated to a 404, and the
        // widget's fetch logged a console error on every Home load.
        'live-tv': () =>
            data?.features?.liveTV === true && (data?.user?.hasLiveTvPermission ?? false),
        calendar: () => data?.features?.calendar !== false,
        // Off by default (DISABLE_HOLIDAY_RECOMMENDATIONS): the widget never
        // mounts, and never requests /api/recommendations/holiday, unless the
        // admin turned it on.
        'holiday-recommendations': () =>
            isHolidayWidgetAvailable(data?.features as Record<string, boolean> | undefined),
    };

    // Check if widget is disabled by admin
    function isAdminDisabled(widgetId: string): boolean {
        return homepageConfig.widgetVisibility[widgetId] === 'disabled';
    }

    // Feature-flag gate, derived from WIDGET_DEFINITIONS rather than listed here.
    // `widgetPermissionChecks` above is hand-maintained and simply had no
    // `trending` entry, so FEATURE_TRENDING=false greyed the widget out in admin
    // settings and still rendered it on the home page — with live TMDB content.
    // Reading the flag off the widget definition means a widget that declares one
    // cannot be rendered while it is off, including widgets added later.
    function isFeatureDisabled(widgetId: string): boolean {
        const key = widgetFeatureKey(widgetId);
        if (!key) return false;
        const flags = data?.features as Record<string, boolean | undefined> | undefined;
        return flags?.[key] === false;
    }

    // Check if widget should be visible (admin disabled takes priority)
    function shouldShowWidget(widgetId: string): boolean {
        // Admin disabled widgets are never shown
        if (isAdminDisabled(widgetId)) return false;

        // A widget whose declared feature flag is off is never shown
        if (isFeatureDisabled(widgetId)) return false;

        // Then check permission-based visibility
        const permissionCheck = widgetPermissionChecks[widgetId];
        if (permissionCheck) return permissionCheck();
        return true; // Default: visible
    }

    // Helper for nav buttons. Each requires BOTH the public link (so the
    // button has somewhere to go) and the matching server-computed `features`
    // flag, which is only true once the corresponding service's URL *and*
    // credentials are actually set (see `features.jellyfin` / `.audiobooks` /
    // `.kavita` in `$lib/server/config`) — a public URL alone (e.g. a
    // leftover placeholder) is not "configured".
    let jellyfinHomeUrl = $derived(
        tryJoinUpstreamUrl(env.PUBLIC_JELLYFINURL ?? '', '/web/#/home.html'),
    );
    let audiobookHomeUrl = $derived(tryJoinUpstreamUrl(env.PUBLIC_AUDIOBOOKURL ?? '', ''));
    let showMoviesAndShows = $derived(!!jellyfinHomeUrl && data?.features?.jellyfin === true);
    let showAudiobooks = $derived(!!audiobookHomeUrl && data?.features?.audiobooks === true);
    let showBooks = $derived(!!env.PUBLIC_BOOKURL && data?.features?.kavita === true);

    // Admin-configurable hero toolbar. When data.heroButtons is a non-empty
    // array the toolbar renders from config (only enabled buttons, in order);
    // otherwise the hardcoded default toolbar below is shown (backward-compat).
    let heroButtons = $derived<HeroButton[]>(
        Array.isArray(data?.heroButtons) ? (data.heroButtons as HeroButton[]) : [],
    );
    let enabledHeroButtons = $derived(heroButtons.filter((b) => b.enabled));

    function isHeroIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
    }
    // =========================================================================
    // Widget Ordering (Drag and Drop)
    // =========================================================================
    // Built-in widget IDs in default order
    const builtInWidgetIds = [
        'watch-parties',
        'for-you',
        'streaming-sessions',
        'trending',
        'holiday-recommendations',
        'live-tv',
        'watchlist',
        'upcoming-episodes',
        'calendar',
    ];

    // Get all widget IDs including plugin widgets.
    // Deduped so a plugin widget id that collides with a built-in id (or with
    // another plugin id) can never reach the keyed `{#each dndWidgets ...
    // (widget.id)}`, which would throw Svelte's `each_key_duplicate` and crash
    // the entire home page. First occurrence wins (built-ins take precedence).
    function getAllWidgetIds(): string[] {
        // Only 'home'-placement plugin widgets belong in the draggable grid.
        // Allowlist, NOT a below-hero denylist: every other placement (detail,
        // player, …) must stay out of the grid, and a denylist silently admits
        // each new one the day it is added.
        const pluginIds = (data.pluginWidgets ?? [])
            .filter((w) => (w.placement ?? 'home') === 'home')
            .map((w) => w.id);
        return [...new Set([...builtInWidgetIds, ...pluginIds])];
    }

    // Plugin widgets that render in the fixed banner slot directly under the hero.
    let belowHeroWidgets = $derived(
        (data.pluginWidgets ?? []).filter((w) => (w.placement ?? 'home') === 'below-hero'),
    );

    // Fallback widget order uses all available widgets
    let fallbackWidgetIds = $derived(getAllWidgetIds());

    // Get effective widget order: admin config > fallback
    function getDefaultWidgetIds(): string[] {
        const allIds = getAllWidgetIds();
        // Drop any legacy/removed widget ids the admin config may still carry
        // (e.g. 'ai-recommendations', which was renamed to 'for-you'). Such ids
        // have no render branch in the grid, so left unfiltered they surface as
        // dead entries in the TableOfContents index — a dot that scrolls nowhere
        // and desyncs the index from the actual page. Intersecting with the known
        // widget set keeps the grid AND the index limited to renderable widgets.
        const known = new SvelteSet(allIds);
        const adminOrder = homepageConfig.widgetOrder.filter((id) => known.has(id));
        if (adminOrder.length > 0) {
            // Use admin order, but add any missing widgets at the end
            const adminSet = new SvelteSet(adminOrder);
            const missing = allIds.filter((id) => !adminSet.has(id));
            return [...adminOrder, ...missing];
        }
        return allIds;
    }

    // Get widgets that should be hidden by default for new users
    function getAdminDefaultHiddenWidgets(): string[] {
        return Object.entries(homepageConfig.widgetVisibility)
            .filter(([, visibility]) => visibility === 'hidden')
            .map(([id]) => id);
    }

    // Get translated widget name
    function getWidgetName(id: string): string {
        // Built-in widget names with translations
        const builtInNames: Record<string, string> = {
            'watch-parties': m.widget_watch_parties(),
            'streaming-sessions': m.widget_streaming_sessions(),
            'for-you': m.widget_for_you(),
            trending: m.widget_trending(),
            'holiday-recommendations': m.widget_holiday_recommendations(),
            watchlist: m.widget_watchlist(),
            'upcoming-episodes': m.widget_upcoming_episodes(),
            'live-tv': m.widget_live_tv(),
            calendar: m.widget_series_calendar(),
        };

        // Check built-in first
        if (builtInNames[id]) {
            return builtInNames[id];
        }
        // Plugin-contributed widget: fall back to its declared title.
        const pluginWidget = (data.pluginWidgets ?? []).find((w) => w.id === id);
        if (pluginWidget) return pluginWidget.title;
        return id;
    }

    // Build widget objects from IDs
    function buildWidgetOrder(): Widget[] {
        return getDefaultWidgetIds().map((id) => ({
            id,
            name: getWidgetName(id),
        }));
    }

    // Initialize widgets from the SSR'd per-user DB layout (data.userWidgetOrder /
    // data.userHiddenWidgets). This runs IDENTICALLY on server and client — both
    // read from `data`, not localStorage — so the server-rendered HTML and the
    // client's first render are byte-identical (no hydration mismatch, no flash).
    // Null = "no saved order" → fall back to the admin-configured default.
    function initializeWidgets(): { widgets: Widget[]; hidden: string[] } {
        const savedOrder = data.userWidgetOrder;
        const widgets =
            Array.isArray(savedOrder) && savedOrder.length > 0
                ? buildWidgetOrderFromIds(savedOrder)
                : buildWidgetOrder();
        const hidden = data.userHiddenWidgets ?? getAdminDefaultHiddenWidgets();
        return { widgets, hidden };
    }

    // Build widget objects from a specific order of IDs
    function buildWidgetOrderFromIds(orderIds: string[]): Widget[] {
        const defaultIds = getDefaultWidgetIds();
        const orderedWidgets: Widget[] = [];
        const widgetMap = new SvelteMap(
            defaultIds.map((id) => [id, { id, name: getWidgetName(id) }]),
        );

        // Add in saved order
        for (const id of orderIds) {
            const widget = widgetMap.get(id);
            if (widget) {
                orderedWidgets.push(widget);
                widgetMap.delete(id);
            }
        }

        // Add any missing widgets
        for (const widget of widgetMap.values()) {
            orderedWidgets.push(widget);
        }

        return orderedWidgets;
    }

    // Initialize from the SSR'd per-user DB layout (runs identically on server +
    // client → no hydration mismatch, no flash). The admin "reset all users"
    // path deletes the DB row, so SSR then reads null → admin default; no
    // localStorage reset-epoch dance is needed anymore.
    const initialState = initializeWidgets();
    let widgets: Widget[] = $state(initialState.widgets);
    let userHiddenWidgets: string[] = $state(initialState.hidden);

    // DND animation duration (reactive to config)
    let flipDurationMs = $derived(homepageConfig.dndAnimationMs);
    let dragDisabled = $state(true);
    let savingWidgetOrder = $state(false);

    // Track widgets that have actual content (dynamically reported)
    function initialWidgetContentVisible(): Record<string, boolean> {
        return {
            // No SSR signal exists for these two (watch-parties isn't fetched by
            // +page.server.ts at all; the holiday plugin's own date/API check only
            // resolves client-side) — they start hidden and animate in via the
            // `.widget-collapsible` CSS transition below when they flip visible.
            'watch-parties': false,
            'holiday-recommendations': false,
            // SSR already knows whether LiveTV has any channel currently airing a
            // program (data.liveTvSection is null otherwise — see
            // loadLiveTvSection in +page.server.ts). Seed true when it does, so the
            // widget paints in place instead of popping in after hydration.
            'live-tv': (data.liveTvSection?.items?.length ?? 0) > 0,
            // Starts hidden, shows only when active sessions exist. When SSR seeded
            // us with active streams, start visible so the section paints with first
            // byte instead of flashing hidden→visible after hydration.
            'streaming-sessions': (data.initialSessions?.length ?? 0) > 0,
        };
    }

    let widgetContentVisible: Record<string, boolean> = $state(initialWidgetContentVisible());

    // Handle visibility change events from widgets
    function handleWidgetVisibility(widgetId: string, visible: boolean) {
        widgetContentVisible[widgetId] = visible;
        widgetContentVisible = widgetContentVisible; // Trigger reactivity
    }

    function handleWatchPartiesVisibility(detail: { visible: boolean }) {
        handleWidgetVisibility('watch-parties', detail.visible);
    }

    function handleHolidayVisibility(detail: { visible: boolean }) {
        handleWidgetVisibility('holiday-recommendations', detail.visible);
    }

    // Reactive: Filter widgets that should be visible (permission-based, user preference, AND have content)
    // This is the TableOfContents index source, so it must track the grid EXACTLY —
    // every entry here needs a corresponding rendered section (dndWidgets), otherwise
    // the index shows a dot that scrolls nowhere.
    let visibleWidgets = $derived(
        widgets.filter((w) => {
            // First check permission-based visibility
            if (!shouldShowWidget(w.id)) return false;
            // Check if user has hidden this widget
            if (userHiddenWidgets.includes(w.id)) return false;
            // Onboarding suppresses built-in media widgets in the grid (only plugin
            // widgets render — see computeDndWidgets), so the index must mirror that
            // or it would list media sections that aren't on the page.
            if (serverHeroState === 'onboarding' && !w.id.startsWith('plugin:')) return false;
            // Then check if widget has content (for dynamic widgets)
            if (w.id in widgetContentVisible) {
                return widgetContentVisible[w.id];
            }
            return true; // Default: visible
        }),
    );

    // Compute the DnD-source widget list from the current widgets/hidden/onboarding
    // state. SSR-safe (no browser APIs; serverHeroState comes from `data`), so it
    // can seed dndWidgets at declaration → the grid renders during SSR.
    //
    // During fresh-install onboarding the built-in (media-dependent) widgets are
    // suppressed, but PLUGIN widgets (e.g. the shoutbox) don't depend on library
    // content, so they still render. Keeping them in dndWidgets (the dnd source of
    // truth) — rather than conditionally skipping inside the {#each} — keeps
    // svelte-dnd-action's items in sync with the DOM.
    function computeDndWidgets(): Widget[] {
        const onboarding = serverHeroState === 'onboarding';
        return widgets.filter(
            (w) =>
                shouldShowWidget(w.id) &&
                !userHiddenWidgets.includes(w.id) &&
                (!onboarding || w.id.startsWith('plugin:')),
        );
    }

    // Separate list for DnD that includes all permission-visible widgets (even empty ones)
    // This ensures the widget containers are rendered so they can report visibility
    // IMPORTANT: This must NOT be a reactive variable ($:) because svelte-dnd-action
    // needs to directly manage the array. Using a reactive variable causes items
    // to disappear during drag because the array gets recalculated.
    // Initialized AT DECLARATION (not in an $effect) so the grid is populated
    // during SSR — the {#if dndWidgets.length > 0} block then renders in the
    // server HTML in the user's saved order.
    let dndWidgets: Widget[] = $state(computeDndWidgets());

    // Keep dndWidgets synced when widgets/hidden change on the client (but not
    // during drag — svelte-dnd-action owns the array mid-drag).
    let isDragging = $state(false);
    $effect(() => {
        if (!isDragging) {
            dndWidgets = computeDndWidgets();
        }
    });

    function handleDndConsider(e: CustomEvent<{ items: DndWidgetItem[] }>) {
        if (savingWidgetOrder) return;
        isDragging = true;
        // CRITICAL: Directly assign e.detail.items to preserve svelte-dnd-action's
        // shadow/placeholder items during drag. Never reconstruct the array here.
        dndWidgets = e.detail.items;
    }

    function handleDndFinalize(e: CustomEvent<{ items: DndWidgetItem[] }>) {
        if (savingWidgetOrder) return;
        const previousWidgets = [...widgets];
        // Get the final order (filter out any shadow placeholder items)
        const finalItems = e.detail.items.filter((item) => !item.isDndShadowItem);
        dndWidgets = finalItems;
        isDragging = false;

        // Update the master widgets list with hidden widgets at the end
        const dndIds = new SvelteSet(finalItems.map((w) => w.id));
        const hiddenWidgets = widgets.filter((w) => !dndIds.has(w.id));
        widgets = [...finalItems, ...hiddenWidgets];

        void saveWidgetOrder(previousWidgets);
    }

    // Persist the drag-reorder result. The DB is canonical now (SSR reads it on
    // the next load), so we only write to the API — no localStorage cache. Hidden
    // widgets are managed via the /settings/home customize UI, which persists both
    // order and hidden to the same DB row; we send only `widgetOrder` here so a
    // reorder doesn't clobber the hidden list.
    async function saveWidgetOrder(previousWidgets: Widget[]): Promise<void> {
        if (!browser) return;
        const order = widgets.map((w) => w.id);
        savingWidgetOrder = true;
        try {
            await saveHomeWidgetOrder(order, () => {
                widgets = previousWidgets;
                dndWidgets = computeDndWidgets();
            });
        } finally {
            savingWidgetOrder = false;
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================
    // Hero refresh state machine (tested in hero-refresh-controller.test.ts)
    let heroState: HeroRefreshState = $state(createInitialState());

    /**
     * Execute a hero section refresh.
     * Returns true on success, false on failure.
     */
    async function executeHeroRefresh(): Promise<boolean> {
        try {
            const result = await buildHeroSection({ ...heroBuildOptions, refresh: true });
            heroSection = result.section;
            return true;
        } catch (e) {
            console.warn('[HomePage] executeHeroRefresh failed', e);
            return false;
        }
    }

    onMount(async () => {
        if (browser) {
            // Generate stars for background — skipped entirely when the user
            // prefers reduced motion (the stars are a purely decorative,
            // continuously-animated layer).
            const prefersReducedMotion =
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!prefersReducedMotion) {
                starLayers = Array.from({ length: STAR_LAYERS }, (_, layer) => ({
                    shadow: Array.from({ length: STARS_PER_LAYER }, () => {
                        const size = Math.random() * 1.5 + 0.5;
                        const alpha = (Math.random() * 0.4 + 0.1) * 1.6;
                        // The layer element is 1px, so spread (size - 1) / 2 gives a `size` dot.
                        return `${(Math.random() * 100).toFixed(2)}vw ${(Math.random() * 100).toFixed(2)}vh 0 ${((size - 1) / 2).toFixed(2)}px rgba(200, 180, 255, ${alpha.toFixed(2)})`;
                    }).join(', '),
                    duration: 2 + layer * 1.1,
                    delay: -layer * 0.7,
                }));
            }

            // Hero section always starts muted on page load. All preview/hero
            // players share one exclusive-audio owner (preview-audio store): at
            // most one may emit audio at a time, and everyone starts muted.
            mute = true;

            // Coarse pointer (touch) devices get drag disabled by default, mirroring
            // the previous svelte-device-info isPhone check without the extra bundle cost.
            // Guard existence: some older TV/embedded WebViews lack matchMedia.
            // Leave dragDisabled at its safe default (true) when unavailable.
            if (typeof window.matchMedia === 'function') {
                dragDisabled = window.matchMedia('(pointer: coarse)').matches;
            }

            // Load hero section data async (don't block other content)
            if (serverHeroState === 'full-metadata') {
                heroState = { ...heroState, refreshInProgress: true };
                buildHeroSection(heroBuildOptions)
                    .then(async (result) => {
                        heroSection = result.section;

                        // Use state machine to determine next action
                        const fetchAction = handleInitialFetchComplete(heroState, {
                            nextUpCached: result.nextUpCached,
                            nextUpCachedAt: result.nextUpCachedAt,
                        });
                        heroState = { ...heroState, ...fetchAction.newState };

                        switch (fetchAction.action.type) {
                            case 'skip_validation':
                                // Fresh data or recent cache - no validation needed
                                break;

                            case 'validate': {
                                // Validate stale-while-revalidate: check if user has new activity
                                const validation = await validateHeroNextUpCache();

                                // Check if a refresh started during validation (from subscription trigger)
                                // If so, skip validation-triggered refresh to avoid concurrent refreshes
                                if (heroState.refreshInProgress) {
                                    break;
                                }

                                const validationAction = handleValidationComplete(
                                    validation.isStale,
                                );
                                heroState = {
                                    ...heroState,
                                    ...validationAction.newState,
                                };

                                if (validationAction.action.type === 'refresh') {
                                    const validationSuccess = await executeHeroRefresh();
                                    heroState = {
                                        ...heroState,
                                        ...handleRefreshComplete(validationSuccess),
                                    };
                                }
                                break;
                            }
                        }
                    })
                    .catch(() => {
                        // If initial fetch fails, allow retries
                        heroState = {
                            ...heroState,
                            refreshInProgress: false,
                            initialFetchComplete: true,
                        };
                    });
            } else if (serverHeroState === 'local-content') {
                buildLocalHeroSection().then((result) => {
                    heroSection = result.section;
                });
            }
        }
    });

    // When SvelteKit re-runs the load (e.g. after player closes and invalidates
    // 'app:watch-state'), kick a hero refresh so the next-up content stays fresh.
    afterNavigate(({ type }) => {
        if (type === 'enter') return; // initial page load already handled in onMount
        if (heroState.initialFetchComplete && !heroState.refreshInProgress) {
            heroState = { ...heroState, refreshInProgress: true };
            void executeHeroRefresh().then((success) => {
                heroState = { ...heroState, ...handleRefreshComplete(success) };
            });
        }
    });

    // Re-fetch watch state when the tab becomes visible / focused again, or
    // when the user returns via bfcache (e.g. mobile back gesture). Catches
    // playback that happened on another device while this tab was idle.
    onMount(() => {
        if (!browser) return;

        const gateFocusRefresh = createMinInterval(10_000);

        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                gateFocusRefresh.run(() => invalidateWhenIdle('app:watch-state'));
            }
        };
        const onFocus = () => gateFocusRefresh.run(() => invalidateWhenIdle('app:watch-state'));
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) gateFocusRefresh.run(() => invalidateWhenIdle('app:watch-state'));
        };

        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);
        window.addEventListener('pageshow', onPageShow);

        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('pageshow', onPageShow);
            // A pending trailing call must not fire after this component has
            // navigated away — that is the exact spurious refetch this gate
            // exists to prevent.
            gateFocusRefresh.cancel();
        };
    });

    // =========================================================================
    // Event Handlers
    // =========================================================================
    // Note: Hero mute state is intentionally NOT persisted to localStorage
    // The hero should always start muted on page load for better UX
    // MediaHoverCard hover tooltips have their own separate mute preference

    function openSearch() {
        isSearchOpen = true;
    }

    function handleKeydown(event: KeyboardEvent) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
            event.preventDefault();
            openSearch();
        }
    }

    function handleMovieSaved(event: CustomEvent<MovieSavedDetail>) {
        const refreshFn = watchlistComponent?.refresh;
        if (refreshFn) {
            setTimeout(() => refreshFn(), 100);
        }
    }

    // =========================================================================
    // Dev Tools
    // =========================================================================
    async function clearAllCaches() {
        if (!browser) return;

        try {
            if ('caches' in window) {
                const cacheNames = await caches.keys();
                await Promise.all(cacheNames.map((name) => caches.delete(name)));
                console.log('[Dev] Cleared service worker caches:', cacheNames);
            }

            // Widget order is canonical in the DB (SSR'd on load), so we no longer
            // preserve any localStorage widget cache here.
            localStorage.clear();
            console.log('[Dev] Cleared localStorage');

            sessionStorage.clear();
            console.log('[Dev] Cleared sessionStorage');

            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(registrations.map((reg) => reg.unregister()));
                console.log('[Dev] Unregistered service workers');
            }

            alert('All caches cleared! The page will reload.');
            window.location.reload();
        } catch (error) {
            console.error('[Dev] Error clearing caches:', error);
            alert('Error clearing caches. Check console for details.');
        }
    }

    // Debug functions for testing (dev-only — never attach these in production)
    if (devMode && typeof window !== 'undefined') {
        window.testWatchlistBinding = () => {
            if (watchlistComponent) {
                const testItem: WatchlistItem = {
                    externalIds: { tmdb: '999999' },
                    mediaType: 'movie' as const,
                    title: 'Test Movie',
                    overview: 'Test Description',
                    rating: '8.0',
                    criticRating: 85,
                    canRequest: false,
                    isAvailable: true,
                    availabilitySource: 'lumastra',
                    savedAt: new SvelteDate().toISOString(),
                };
                const addItemImmediately = watchlistComponent?.addItemImmediately as
                    ((item: WatchlistItem) => void) | undefined;
                if (addItemImmediately) {
                    addItemImmediately(testItem);
                }
            }
        };
        window.testMovieSavedEvent = () => {
            const fakeEvent = new CustomEvent<MovieSavedDetail>('movieSaved', {
                detail: {
                    externalIds: { tmdb: '999999' },
                    title: 'Test Movie from Console',
                    item: {
                        externalIds: { tmdb: '999999' },
                        mediaType: 'movie' as const,
                        title: 'Test Movie from Console',
                        overview: 'Test Description',
                        rating: '8.0',
                        criticRating: 85,
                        canRequest: false,
                        isAvailable: true,
                        availabilitySource: 'lumastra',
                        savedAt: new SvelteDate().toISOString(),
                    },
                },
            });
            handleMovieSaved(fakeEvent);
        };
    }
</script>

<svelte:head>
    <title>{m.nav_home()} - {data?.branding?.appName || 'Lumastra'}</title>
    <!-- Never preload for an audiobook: it has no backdrop art, every candidate
         in this srcset 302s to the popcorn placeholder (a 302 resolves 200, so
         nothing can recover from it), and HeroSection deliberately suppresses its
         own srcset for audiobooks so the slide falls back to the gradient. A
         preload here would put the placeholder in the cache anyway. -->
    {#if heroFirstSlide?.externalIds?.internal && !isAudiobook(heroFirstSlide.mediaType)}
        <!-- Responsive preload (Chromium + recent Safari). Starts the backdrop
             fetch during HTML parse, before hydration. The imagesrcset/imagesizes
             match the <img srcset>/sizes in HeroSection EXACTLY, so this preloads
             the actual candidate the browser will pick (no wasted second download).
             Firefox/old-Safari ignore imagesrcset and simply skip the preload —
             graceful: the <img> still loads and the blurhash LQIP covers the gap. -->
        <link
            rel="preload"
            as="image"
            imagesrcset={getCatalogBackdropSrcSet(heroFirstSlide.externalIds.internal)}
            imagesizes="100vw" />
    {/if}
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

{#if serverHeroState === 'onboarding'}
    <LibrarySetupNotice isAdmin={data.isAdmin} />
{:else if heroSection?.items?.length || heroFirstSlide}
    <div class="relative">
        <HeroSection
            bind:this={heroComponent}
            section={heroSection}
            firstSlide={heroFirstSlide ?? undefined}
            {cwLiveState}
            {muteStore}
            bind:videoHasAudio={previewHasAudio}
            bind:currentIndex={heroCurrentIndex}
            bind:slideCount={heroSlideCount}
            bind:slideTitles={heroSlideTitles}
            bind:userPaused={heroUserPaused}
            bind:autoplayActive={heroAutoplayActive}
            bind:muted={heroMuted} />
    </div>
{:else}
    <div class="h-[550px] lg:h-[465px]"></div>
{/if}

<Search bind:isOpen={isSearchOpen} debounceMs={homepageConfig.searchDebounceMs} syncToUrl={true} />

<!-- Animated stars background (optional feature, FEATURE_STARS_BACKGROUND).
     `app-starfield` lets a theme without a starfield (e.g. a graphite
     "marquee" theme) hide this layer via
     `[data-theme='x'] .app-starfield { display: none }` — the flag itself
     still controls whether it's rendered at all. -->
{#if data.features?.starsBackground}
    <div class="stars-container app-starfield">
        {#each starLayers as layer, i (i)}
            <div
                class="star-layer"
                style="box-shadow: {layer.shadow}; animation-duration: {layer.duration}s; animation-delay: {layer.delay}s;">
            </div>
        {/each}
    </div>
{/if}

<!-- Table of Contents - sticky sidebar for wide screens -->
<TableOfContents items={visibleWidgets} />

<div class="z-40 relative hero-overlap">
    <!-- md:pr-14 reserves room for the fixed TableOfContents dot rail (right-4
         + its ~24px dot column + label popout). Without it, at exactly the
         container's own breakpoint width (1280px has zero side gutter by
         default) the dots sit on top of the last poster column/buttons and
         the hover-out labels cover whatever is beneath them. -->
    <div
        class="container mx-auto p-4 sm:p-8 space-y-8"
        class:home-content--has-toc={visibleWidgets.length > 0}>
        <!-- Account menu trigger (avatar). Rendered as the first element of the
             hero nav row so it reads "avatar · Suchen · Stöbern · Assistent".
             Opens the shared UserMenuPopover (rendered once below). -->
        {#snippet accountButton()}
            <button
                use:popup={accountPopup}
                class="hero-avatar-btn"
                type="button"
                aria-haspopup="dialog"
                aria-label={m.nav_account_menu()}>
                <Avatar
                    src={accountAvatarSrc}
                    alt={m.nav_account_menu()}
                    initials="-"
                    username={data.user?.username}
                    size="md"
                    border="border border-white/15 hover:!border-primary-500 transition-all" />
            </button>
        {/snippet}
        <!-- Navigation Buttons -->
        {#if enabledHeroButtons.length}
            <!-- Admin-configured hero toolbar (HERO_BUTTONS). Same wrapper/classes
                 as the default below so layout + stagger stay identical. -->
            <section class="flex flex-wrap items-center gap-3 justify-start pb-2 ml-8">
                {@render accountButton()}
                {#each enabledHeroButtons as btn (btn.id)}
                    {#snippet heroIcon()}
                        {#if isHeroIconPath(btn.icon)}
                            <img src={btn.icon} alt="" class="hero-btn__icon" />
                        {:else if data.navIcons?.[btn.icon]}
                            <Icon src={data.navIcons[btn.icon]} class="hero-btn__icon" />
                        {/if}
                    {/snippet}
                    {#if btn.action === 'search'}
                        <!-- aria-label: under sm the text is hidden, which left the
                             icon-only button with no accessible name. -->
                        <button class="hero-btn" onclick={openSearch} aria-label={btn.label}>
                            {@render heroIcon()}
                            <span class="hidden sm:inline">{btn.label}</span>
                            <span class="hero-btn__hint hidden sm:inline"
                                >{usesCommandKey ? '(⌘F)' : m.shortcut_ctrl_f()}</span>
                        </button>
                    {:else if btn.action === 'browse'}
                        <a class="hero-btn" href={resolve('/browse')} aria-label={btn.label}>
                            {@render heroIcon()}
                            <span class="hidden sm:inline">{btn.label}</span>
                        </a>
                    {:else if btn.action === 'assistant'}
                        <a
                            class="hero-btn hero-btn--assistant"
                            href={resolve('/assistant')}
                            aria-label={btn.label}>
                            {@render heroIcon()}
                            <span class="hidden sm:inline">{btn.label}</span>
                        </a>
                    {:else if btn.url}
                        <a
                            class="hero-btn"
                            href={resolve(btn.url)}
                            aria-label={btn.label}
                            target={btn.external ? '_blank' : undefined}
                            rel={btn.external ? 'noopener noreferrer' : undefined}>
                            {@render heroIcon()}
                            <span class="hidden sm:inline">{btn.label}</span>
                        </a>
                    {/if}
                {/each}

                <!-- Dev Mode: Clear Cache Button -->
                {#if devMode}
                    <button
                        class="btn variant-ghost-error mt-4 ml-2 text-xs"
                        onclick={clearAllCaches}
                        title={m.misc_clear_cache_title()}>
                        🗑️ {m.misc_clear_cache()}
                    </button>
                {/if}
            </section>
        {:else}
            <section class="flex flex-wrap items-center gap-3 justify-start pb-2 ml-8">
                {@render accountButton()}
                <button class="hero-btn" onclick={openSearch} aria-label={m.search()}>
                    <Icon src={MagnifyingGlass} class="hero-btn__icon" />
                    <span class="hidden sm:inline">{m.search()}</span>
                    <span class="hero-btn__hint hidden sm:inline"
                        >{usesCommandKey ? '(⌘F)' : m.shortcut_ctrl_f()}</span>
                </button>
                <a class="hero-btn" href={resolve('/browse')} aria-label={m.browse()}>
                    <Icon src={RectangleGroup} class="hero-btn__icon" />
                    <span class="hidden sm:inline">{m.browse()}</span>
                </a>
                {#if data.features?.jellyfinCompat === true}
                    <a
                        class="hero-btn"
                        href={resolve(JELLYFIN_CONNECT_URL)}
                        aria-label={m.settings_connections_connect_client()}>
                        <Icon src={ServerStack} class="hero-btn__icon" />
                        <span class="hidden sm:inline"
                            >{m.settings_connections_connect_client()}</span>
                    </a>
                {/if}
                {#if showMoviesAndShows}
                    <a class="hero-btn" href={jellyfinHomeUrl} target="_blank">
                        <Icon src={Film} class="hero-btn__icon" />
                        <span class="hidden sm:inline">{m.allMoviesAndShows()}</span>
                        <span class="sm:hidden">{m.movies()}</span>
                    </a>
                {/if}
                {#if showAudiobooks}
                    <a class="hero-btn" href={audiobookHomeUrl} target="_blank">
                        <Icon src={SpeakerWave} class="hero-btn__icon" />
                        <span class="hidden sm:inline">{m.allAudiobooks()}</span>
                        <span class="sm:hidden">{m.audiobooks()}</span>
                    </a>
                {/if}
                {#if showBooks}
                    <a class="hero-btn" href={resolve(env.PUBLIC_BOOKURL ?? '')} target="_blank">
                        <Icon src={BookOpen} class="hero-btn__icon" />
                        <span class="hidden sm:inline">{m.allBooks()}</span>
                        <span class="sm:hidden">{m.allBooks()}</span>
                    </a>
                {/if}
                {#if data.features?.aiAssistant !== false}
                    <a class="hero-btn hero-btn--assistant" href={resolve('/assistant')}>
                        <!-- Gradient-stroked sparkle (matches btn-assistant.svg); the
                         button's gradient hairline border is drawn in CSS below. -->
                        <svg
                            class="hero-btn__icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true">
                            <defs>
                                <linearGradient id="lumastra-asst" x1="0" y1="1" x2="1" y2="0">
                                    <stop offset="0" stop-color="#006BFF" />
                                    <stop offset="0.5" stop-color="#4540FF" />
                                    <stop offset="1" stop-color="#BE2DFF" />
                                </linearGradient>
                            </defs>
                            <g stroke="url(#lumastra-asst)">
                                <path
                                    d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0Z" />
                                <path d="M20 3v4" />
                                <path d="M22 5h-4" />
                                <path d="M4 17v2" />
                                <path d="M5 18H3" />
                            </g>
                        </svg>
                        <span class="hidden sm:inline">{m.assistant_label()}</span>
                    </a>
                {/if}

                <!-- Hero mute control lives inside the hero's own controls cluster now. -->

                <!-- Dev Mode: Clear Cache Button -->
                {#if devMode}
                    <button
                        class="btn variant-ghost-error mt-4 ml-2 text-xs"
                        onclick={clearAllCaches}
                        title={m.misc_clear_cache_title()}>
                        🗑️ {m.misc_clear_cache()}
                    </button>
                {/if}
            </section>
        {/if}

        <!-- Account menu popover target. Position-fixed (bodyPortal) so its place
             in the tree is irrelevant; rendered once for whichever nav section is
             active above. -->
        <UserMenuPopover id="accountMenu" avatarSrc={accountAvatarSrc} />

        <!-- Hero carousel controls — lifted out of the hero box into their own row.
             Shares the nav section's left edge (ml-8) so PLAY (at the hero content
             edge) sits to the left, and nav + these controls + the footer all line
             up on a common edge slightly to PLAY's right. Only shown for >1 slide.
             The wrapper reserves a min-height (matches HeroControls' 28px circular
             buttons) while the hero is still resolving OR when controls are shown,
             so the async slide-count/audio resolution doesn't shift the content
             below it (CLS). Once the hero has resolved to a genuine single-slide,
             no-audio state, the reservation collapses so there's no permanent gap. -->
        <div
            class="ml-8 -mt-4"
            class:min-h-7={!heroState.initialFetchComplete ||
                heroSlideCount > 1 ||
                previewHasAudio}>
            {#if heroSlideCount > 1 || previewHasAudio}
                <HeroControls
                    slideCount={heroSlideCount}
                    currentIndex={heroCurrentIndex}
                    slideTitles={heroSlideTitles}
                    autoplayActive={heroAutoplayActive}
                    autoplayIntervalMs={heroAutoplayIntervalMs}
                    paused={heroUserPaused}
                    showMute={previewHasAudio}
                    muted={heroMuted}
                    onGoTo={(i) => heroComponent?.goTo(i)}
                    onTogglePause={() => heroComponent?.togglePause()}
                    onToggleMute={() => heroComponent?.toggleMute()} />
            {/if}
        </div>

        <!-- Pinned admin announcements: same "below-hero" content band as the
             plugin banner slot just below (directly under the hero + nav
             buttons, above the widget grid — so above Active Streams and
             everything else in it), not above the hero itself. Ahead of the
             plugin slot: an admin-pinned announcement is a system-level
             message, not a plugin's own banner. -->
        {#if data.pinnedAnnouncements?.length}
            <div class="ml-8 mr-4">
                <PinnedAnnouncementsBanner announcements={data.pinnedAnnouncements} />
            </div>
        {/if}

        <!-- Plugin banner slot: 'below-hero'-placement widgets (e.g. the admin
             announcement) render at the top of the content — directly under the
             hero + nav buttons, which overlap the hero by design — so they don't
             collide with those buttons. -->
        {#if belowHeroWidgets.length > 0}
            <div class="ml-8 mr-4 flex flex-col gap-3">
                {#each belowHeroWidgets as pw (pw.id)}
                    <PluginWidgetSlot
                        widget={{
                            featureId: pw.featureId,
                            id: pw.widgetId,
                            title: pw.title,
                            entry: pw.entry,
                        }}
                        context={{ surface: pw.placement ?? 'home' }}
                        user={data?.pluginUser ?? null} />
                {/each}
            </div>
        {/if}

        {#if serverHeroState === 'local-content' && isAdmin() && !tmdbNudgeDismissed && !tmdbConfigured}
            <div
                class="bg-surface-800/90 backdrop-blur-sm px-4 py-2.5 rounded-lg flex items-center justify-between border border-surface-700/50 ml-8 mr-4">
                <p class="text-sm text-surface-300">
                    {m.home_tmdb_nudge_text()}
                    <a
                        href={url('/admin/settings/providers')}
                        class="text-primary-400 hover:text-primary-300 ml-1"
                        >{m.home_tmdb_nudge_link()}</a>
                </p>
                <button
                    class="text-xs text-surface-500 hover:text-surface-300"
                    onclick={handleDismissTmdbNudge}>{m.a11y_dismiss()}</button>
            </div>
        {/if}
    </div>

    <!-- Draggable Widgets Section. During fresh-install onboarding the built-in
         media widgets are suppressed (dndWidgets is filtered to plugin widgets only,
         see the $effect above), so the section renders whenever there's anything to
         show — i.e. plugin widgets like the shoutbox appear from day one. -->
    {#if dndWidgets.length > 0}
        <section
            class="container mx-auto px-4"
            use:dragHandleZone={{
                items: dndWidgets,
                flipDurationMs,
                dragDisabled: dragDisabled || savingWidgetOrder,
                type: 'widget',
            }}
            onconsider={handleDndConsider}
            onfinalize={handleDndFinalize}>
            {#each dndWidgets as widget (widget.id)}
                <!-- Content-conditional widgets (watch-parties, streaming-sessions,
                     holiday-recommendations, live-tv) mount eagerly and self-report
                     visibility once they know whether they have anything to show.
                     Collapsing them with `hidden` (display:none) is instant, so a
                     hidden→visible flip after initial paint yanks everything below
                     it — the CLS this reports. `widget-collapsible` swaps that for a
                     max-height/opacity transition instead, so the push is animated.
                     Widgets NOT in widgetContentVisible never get either class. -->
                <div
                    class="widget-container mb-16 relative group"
                    class:widget-collapsible={widget.id in widgetContentVisible}
                    class:widget-collapsed={widget.id in widgetContentVisible &&
                        !widgetContentVisible[widget.id]}
                    data-toc-id={widget.id}
                    id="widget-{widget.id}"
                    animate:safeFlip={{ duration: flipDurationMs }}>
                    <!-- Drag Handle -->
                    <div
                        use:dragHandle
                        aria-label={m.a11y_drag_handle({ name: widget.name })}
                        class="drag-handle opacity-0 group-hover:opacity-100 transition-opacity duration-200 absolute -left-8 top-4 cursor-grab active:cursor-grabbing z-10"
                        tabindex="0"
                        role="button">
                        <svg
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            class="text-gray-400 hover:text-white">
                            <circle cx="8" cy="6" r="2" />
                            <circle cx="8" cy="12" r="2" />
                            <circle cx="8" cy="18" r="2" />
                            <circle cx="16" cy="6" r="2" />
                            <circle cx="16" cy="12" r="2" />
                            <circle cx="16" cy="18" r="2" />
                        </svg>
                    </div>

                    <div class="widget-content">
                        <!-- Render widgets - use explicit components to ensure proper mounting -->
                        {#if widget.id === 'watch-parties'}
                            <WatchParties
                                userId={data?.user?.userId || ''}
                                onvisibilityChange={handleWatchPartiesVisibility} />
                        {:else if widget.id === 'streaming-sessions'}
                            <LiveSessionSection
                                {data}
                                initialSessions={data.initialSessions}
                                initialSessionsCacheTimestamp={data.initialSessionsCacheTimestamp}
                                onvisibilityChange={(d) =>
                                    handleWidgetVisibility('streaming-sessions', d.visible)} />
                        {:else if widget.id === 'for-you'}
                            <!-- Eager: SSR-seeded continue-watching / for-you strip. -->
                            <ForYou />
                        {:else if widget.id === 'trending'}
                            <!-- Deferred: below-the-fold, self-fetches on mount. -->
                            <LazyMount minHeight="360px">
                                <Trending
                                    type="all"
                                    source="tmdb"
                                    limit={homepageConfig.trendingLimit} />
                            </LazyMount>
                        {:else if widget.id === 'holiday-recommendations'}
                            <HolidayRecommendations onvisibilityChange={handleHolidayVisibility} />
                        {:else if widget.id === 'live-tv'}
                            <LiveTvWidget
                                initialSection={ssrSeedFresh ? data.liveTvSection : null}
                                onvisibilityChange={(d) =>
                                    handleWidgetVisibility('live-tv', d.visible)} />
                        {:else if widget.id === 'watchlist'}
                            <Watchlist bind:this={watchlistComponent} />
                        {:else if widget.id === 'upcoming-episodes'}
                            <!-- Deferred: below-the-fold, self-fetches on mount. Renders
                                 a header plus a grouped-by-day episode list that
                                 routinely runs 600-700px — raised from 360px, which
                                 under-reserved and let the section grow after mount. -->
                            <LazyMount minHeight="700px">
                                <UpcomingEpisodes />
                            </LazyMount>
                        {:else if widget.id === 'calendar'}
                            <!-- Deferred: below-the-fold; self-fetches on mount. The
                                 home embed starts the calendar in its one-row week
                                 view (variant="agenda"); the viewer can switch to the
                                 month grid via the calendar's own toolbar. Reserve
                                 matches toolbar + week row. -->
                            <LazyMount minHeight="520px">
                                <CollapsibleSection
                                    storageKey="calendar-collapsed"
                                    title={m.seriesCalendar()}>
                                    <MovieCalendar variant="agenda" />
                                </CollapsibleSection>
                            </LazyMount>
                        {:else if widget.id.startsWith('plugin:')}
                            {@const pw = (data.pluginWidgets ?? []).find((w) => w.id === widget.id)}
                            {#if pw}
                                <!-- Reserve typical widget-card space until the plugin's
                                     dynamically-imported module mounts, so plugin
                                     widgets in the reorderable grid don't pop in with
                                     zero reserved height like the others here. -->
                                <PluginWidgetSlot
                                    widget={{
                                        featureId: pw.featureId,
                                        id: pw.widgetId,
                                        title: pw.title,
                                        entry: pw.entry,
                                    }}
                                    context={{ surface: 'home' }}
                                    user={data?.pluginUser ?? null}
                                    minHeight="220px" />
                            {/if}
                        {/if}
                    </div>
                </div>
            {/each}
        </section>
    {/if}

    <!-- Footer — left edge aligned with the nav section + hero controls row.
         The nav section lives in a `container mx-auto p-4 sm:p-8` wrapper and is
         further indented `ml-8`; mirroring that padding + ml-8 here puts the
         footer's left edge on the same common edge (just right of the hero PLAY
         button). Rendered at the bottom of the page content (after the widget
         grid) rather than between the nav row and the widgets, so it reads as
         an actual page footer instead of an orphaned fragment. -->
    {#if data.showFooter !== false && (data.footerLinks?.length ?? 0) > 0}
        <div class="container mx-auto mt-4 mb-8 p-4 sm:p-8">
            <div class="ml-8">
                <Footer />
            </div>
        </div>
    {/if}
</div>

<style lang="postcss">
    /* Reserves room for the fixed TableOfContents dot rail (see the comment
       where this class is applied) so its dots/labels never sit on top of a
       poster column or a section's action button — most visible right at the
       `container` class's own breakpoint, where it has zero side gutter. */
    @media (min-width: 768px) {
        .home-content--has-toc {
            padding-right: 3.5rem;
        }
    }

    /* Stars background */
    .stars-container {
        position: fixed;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
        z-index: 0;
    }

    .star-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 1px;
        height: 1px;
        border-radius: 50%;
        animation: twinkle 3s ease-in-out infinite alternate;
    }

    @keyframes twinkle {
        0% {
            opacity: 0.25;
        }
        100% {
            opacity: 1;
        }
    }

    a {
        font-variation-settings: 'wght' 500;
    }

    /* Hero overlap effect - content overlaps the hero section image.
       Keep the overlap small so the full-width overlap layer (z-40) does not
       cover the hero's PLAY button and steal its clicks. */
    .hero-overlap {
        margin-top: 0;
        position: relative;
        z-index: 40;

        @media (min-width: 1024px) {
            margin-top: -8px;
        }
    }

    .widget-container {
        transition: transform 0.2s ease;
    }

    /* Content-conditional widgets only (see class:widget-collapsible above).
       max-height is a generous cap, not a real measurement — svelte-dnd-action
       transitions can't animate to `height: auto`, so this is the standard
       "big enough max-height" collapse trick. None of the four widgets that use
       this (watch-parties, streaming-sessions, holiday-recommendations, live-tv)
       render anywhere near this tall. */
    .widget-collapsible {
        max-height: 2400px;
        opacity: 1;
        overflow: hidden;
        transition:
            transform 0.2s ease,
            max-height 0.35s ease,
            opacity 0.25s ease,
            margin-bottom 0.35s ease;
    }

    .widget-collapsible.widget-collapsed {
        max-height: 0;
        opacity: 0;
        margin-bottom: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .widget-collapsible {
            transition: none;
        }
    }

    .drag-handle {
        touch-action: none;
        user-select: none;
    }

    @media (max-width: 768px) {
        .drag-handle {
            display: none;
        }
    }

    /* ---- Lumastra hero button system (see lumastra-branding/buttons) ----
       Uniform dark-glass secondary buttons; the Assistant button adds a
       gradient hairline border (mask trick) + gradient-stroked sparkle icon. */
    .hero-btn {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        height: 48px;
        padding: 0 16px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        background: rgb(var(--color-surface-950-rgb) / 0.82);
        color: var(--color-surface-50);
        font-weight: 500;
        font-size: 0.875rem;
        letter-spacing: 0.1px;
        white-space: nowrap;
        cursor: pointer;
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
        transition:
            background 0.15s ease,
            border-color 0.15s ease,
            transform 0.12s ease,
            box-shadow 0.15s ease;
    }

    @media (min-width: 640px) {
        .hero-btn {
            height: 56px;
            padding: 0 22px;
            gap: 12px;
            font-size: 1rem;
        }
    }

    /* Round account-menu trigger. 56px matches the desktop hero-btn (pill) height
       so the avatar sits level with Search/Browse. The inner <Avatar> md preset is
       only 48px, so it's forced to fill the button below. flex:none keeps it from
       shrinking when the row wraps on mobile. */
    .hero-avatar-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 56px;
        width: 56px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: 9999px;
        flex: none;
        cursor: pointer;
        transition: transform 0.12s ease;
    }

    /* Force the inner Avatar (md preset = 48px) up to the 56px button. */
    .hero-avatar-btn :global(.avatar) {
        width: 56px;
        height: 56px;
    }

    .hero-avatar-btn:active {
        transform: translateY(1px);
    }

    .hero-avatar-btn:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
        .hero-avatar-btn {
            transition: none;
        }
        .hero-avatar-btn:active {
            transform: none;
        }
    }

    .hero-btn :global(.hero-btn__icon) {
        width: 20px;
        height: 20px;
        flex: none;
        color: var(--color-surface-200);
        transition: color 0.15s ease;
    }

    .hero-btn__hint {
        color: var(--color-surface-400);
        font-size: 13px;
        margin-left: 2px;
    }

    .hero-btn:hover {
        background: rgb(var(--color-surface-800-rgb) / 0.92);
        border-color: rgba(255, 255, 255, 0.24);
    }

    .hero-btn:hover :global(.hero-btn__icon) {
        color: var(--color-surface-50);
    }

    .hero-btn:active {
        transform: translateY(1px);
    }

    .hero-btn:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 2px;
    }

    .hero-btn--assistant {
        position: relative;
        border-color: transparent;
        font-weight: 600;
    }

    .hero-btn--assistant::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        padding: 1.5px;
        background: linear-gradient(135deg, #006bff 0%, #4540ff 50%, #be2dff 100%);
        -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
        mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
    }

    .hero-btn--assistant:hover {
        border-color: transparent;
    }

    @media (prefers-reduced-motion: reduce) {
        .hero-btn {
            transition: none;
        }
        .hero-btn:active {
            transform: none;
        }
    }
</style>
