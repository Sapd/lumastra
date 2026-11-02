<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { onMount, untrack } from 'svelte';
    import { page } from '$app/stores';
    import { updated } from '$app/state';
    import { afterNavigate, beforeNavigate } from '$app/navigation';
    import { createScrollRestorer } from '$lib/utils/scroll-restoration';

    // Finally, your application's global stylesheet (sometimes labeled 'app.css')
    import '../app.css';

    // New modal system
    import NavigationProgressBar from '$lib/components/ui/NavigationProgressBar.svelte';
    import { isModalLoading } from '$lib/stores/modal-loading.store';
    import { modals, hasModals } from '$lib/stores/modal.store';
    import '$lib/stores/modal-url-sync';
    import { openModalFromUrl, reconcileModalsFromUrl } from '$lib/stores/modal-url-sync';
    import { addToPlaylistModal } from '$lib/stores/playlists';
    import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
    import MaintenanceBanner from '$lib/components/MaintenanceBanner.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import {
        registerServiceWorker,
        setupPWAInstall,
        applyPendingUpdate,
        hasPendingUpdate,
    } from '$lib/pwa';
    import { base } from '$app/paths';
    import { url } from '$lib/paths';
    import { startAuthMonitoring } from '$lib/auth-monitor.js';
    import { installFetchInterceptor } from '$lib/fetch-interceptor.js';
    import { updateLastBrowsePage, clearNavigatingToPlayer } from '$lib/stores/playerNavigation';
    import type { LayoutData } from './$types';
    import {
        registerModalComponents,
        modalRegistrationRequested,
        waitForModals,
    } from '$lib/stores/modal-registry.store';
    import { uiPreferences } from '$lib/stores/uiPreferences';
    import { dockVisible, dockLabels, seedDockMode, parseDockMode } from '$lib/stores/dock.store';
    import { browser } from '$app/environment';
    import { hydrateAppConfig } from '$lib/stores/appConfig';
    import { hydrateClientTuning } from '$lib/stores/client-tuning';
    import {
        setClientDiagnosticsEnabled,
        setClientDiagnosticsRoute,
    } from '$lib/client-diagnostics/web-reporter';
    import { LazyPlayerLoader } from '$lib/components/players/lazy-player-loader.svelte';
    import { RunOnceWhenTrue } from '$lib/components/players/run-once-when-true';
    import { BoundedRetryLoader } from '$lib/components/players/bounded-retry-loader.svelte';
    import {
        afterFirstVideoFrame,
        shouldBootstrapWatchModals,
    } from '$lib/components/players/watch-startup-work';
    import { isAppShellRoute, isAuthRoute, isShowcaseRoute } from '$lib/utils/app-shell-route';
    import { isWatchRoute } from '$lib/utils/watch-route';
    import { getEagerAppChrome } from '$lib/components/app-shell/available';
    import { isMinPlayerVisible, musicPlayerStore } from '$lib/stores/music-player.store';
    import { isMusicBottomNavRoute } from '$lib/utils/music-bottom-nav';
    import { debounce } from '$lib/utils/debounce';
    import { watchStateSSE } from '$lib/services/sse/watch-state-sse';
    import { notificationDrawerOpen } from '$lib/stores/notification-drawer.js';
    import { notificationInbox } from '$lib/stores/notification-inbox.js';
    import { init as initDesktopNotifications } from '$lib/notifications-desktop.js';
    import { scheduleWatchlistHydration } from '$lib/services/watchlist-hydrate.service';
    import { manualRuns } from '$lib/stores/manual-runs.svelte';

    // Import splash screen assets - vector SVG (defaults)
    import flyUrlSvg from '$lib/assets/branding/lumastra-icon.svg';
    import fullUrlSvg from '$lib/assets/branding/lumastra-logo-horizontal-ondark.svg';

    // Lazy-load modal components — code-split into separate chunks
    async function loadAndRegisterModals(): Promise<void> {
        const [
            ,
            { default: ModalMovie },
            { default: ActorModal },
            { default: RequestModal },
            { default: SeasonSelectorModal },
            { default: SimilarMoviesModal },
            { default: ConfirmModal },
            { AlbumModal, ArtistModal },
        ] = await Promise.all([
            ensureAppChrome(),
            import('$lib/ModalMovie.svelte'),
            import('$lib/components/modal/ActorModal.svelte'),
            import('$lib/components/RequestModal.svelte'),
            import('$lib/components/SeasonSelectorModal.svelte'),
            import('$lib/components/SimilarMoviesModal.svelte'),
            import('$lib/components/ui/ConfirmModal.svelte'),
            import('$lib/components/modal'),
        ]);
        registerModalComponents({
            movie: ModalMovie,
            actor: ActorModal,
            request: RequestModal,
            seasonSelector: SeasonSelectorModal,
            similarMovies: SimilarMoviesModal,
            confirm: ConfirmModal,
            album: AlbumModal,
            artist: ArtistModal,
        });
    }

    // Lazy-loads MiniPlayer/FullScreenPlayer/AudiobookMiniPlayer/
    // AudiobookFullScreen (Task 8) — see lazy-player-loader.svelte.ts for why
    // this is a shared class rather than inline $effects (testability without
    // mounting the whole app shell). Mirrors loadAndRegisterModals() above:
    // load on demand, keep loaded forever once loaded.
    const playerLoader = new LazyPlayerLoader();
    // Gates the music-store bootstrap below to fire exactly once, the first
    // time the app-shell branch is active — see run-once-when-true.ts and the
    // $effect near isShowcasePage further down (fix round 1, Critical 1).
    const musicStoreBootstrapGate = new RunOnceWhenTrue();

    // Install fetch interceptor early for subfolder deployment support
    installFetchInterceptor();

    interface Props {
        data: LayoutData;
        children?: import('svelte').Snippet;
    }

    let { data, children }: Props = $props();

    type AppChrome = typeof import('$lib/components/app-shell');
    // Non-watch layouts put chrome in their static import graph. Watch SSR must
    // ignore the server's module cache (another request may have loaded catalog
    // chrome), while the browser retains mounted chrome across SPA navigation.
    // Error branches also omit catalog entries, so a cold error must ignore any
    // constructor registered by another server request to keep hydration stable.
    let retainedChrome = $state.raw<AppChrome | null>(
        untrack(() => (isWatchRoute($page.route.id) || $page.error ? null : getEagerAppChrome())),
    );
    let appChrome = $derived(
        isWatchRoute($page.route.id) || $page.error
            ? retainedChrome
            : (getEagerAppChrome() ?? retainedChrome),
    );
    let chromeRequest: Promise<AppChrome> | null = null;
    $effect(() => {
        if (appChrome) retainedChrome = appChrome;
    });

    async function ensureAppChrome(): Promise<void> {
        if (appChrome) return;
        const request = (chromeRequest ??= import('$lib/components/app-shell'));
        try {
            retainedChrome = await request;
        } finally {
            if (chromeRequest === request) chromeRequest = null;
        }
    }

    // Automatic diagnostics (js_error / api_failures): the admin switch, and off
    // when signed out (anonymous pages get an empty feature map). Reports name
    // the route TEMPLATE, never the visited path.
    $effect(() => {
        setClientDiagnosticsEnabled(data.features?.clientDiagnostics === true);
    });
    $effect(() => {
        setClientDiagnosticsRoute($page.route.id);
    });

    // Note: AddToPlaylistModal is rendered separately outside the modal system
    // to ensure proper z-index stacking when opened from within another modal

    let sidebarOpen = $state(false);
    let isMobile = $state(false);
    // False during SSR + first paint; flipped true in onMount. Gates the
    // main-content margin transition so the (correct) server-rendered sidebar
    // gutter doesn't animate into place after hydration.
    let mounted = $state(false);
    let showSplash = $state(false); // Temporarily disabled

    function hideSplash() {
        showSplash = false;
    }

    // Back/Forward scroll position for the app-shell scroller (.main-content on
    // desktop), which SvelteKit's window-only restoration never touches.
    const scrollRestorer = createScrollRestorer();

    // Update header visibility on SvelteKit navigation
    afterNavigate(({ from, to, type }) => {
        if (browser && to?.url) scrollRestorer.afterNavigate(from?.url ?? null, to.url, type);

        // Dispatch custom event for app.html to update header visibility
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('sveltekit-navigate'));
        }

        // Track last browse page for player back button fallback
        // This remembers when user was last on / or /browse (persists across sessions)
        if (to?.url) {
            const fullPath = to.url.pathname + to.url.search;
            updateLastBrowsePage(fullPath);
        }

        // Sync modal state with URL on every client-side navigation.
        // Handles browser back (close modal) and forward (reopen modal).
        // Skip on initial page load (from === null) — onMount handles that via loadAndRegisterModals.
        if (from !== null) {
            if (type === 'popstate') {
                // Browser Back/Forward (incl. mobile edge-swipe): reconcile the
                // trail to the URL precisely — pop to the step the URL names,
                // or close/rebuild. This keeps browser Back ≡ in-modal ← ≡
                // Escape (one gesture = one trail step).
                void waitForModals().then(() => reconcileModalsFromUrl());
            } else {
                // Programmatic navigation (link/goto). Internal modal opens run
                // through here as type 'goto' with the modal already present —
                // no-op. Only act on the two safety cases: leaving the page with
                // a modal open, or deep-linking into a modal from a modal-less
                // state.
                const toHasModal = to?.url
                    ? to.url.searchParams.has('modal') ||
                      to.url.searchParams.has('actor') ||
                      to.url.searchParams.has('artist') ||
                      to.url.searchParams.has('album')
                    : false;

                if (!toHasModal && modals.hasAny) {
                    void modals.closeAll();
                } else if (toHasModal && !modals.hasAny) {
                    void waitForModals().then(() => openModalFromUrl());
                }
            }
        }

        // Apply pending PWA update when leaving watch page
        // Check if we navigated FROM a watch page TO a non-watch page
        // Account for base path in subfolder deployments
        const wasOnWatch = isWatchRoute(from?.route.id ?? null);
        const nowOnWatch = isWatchRoute(to?.route.id ?? null);

        // Clear the play-navigation guard once we land on the watch page so
        // the search reopen $effect is unblocked for future modal opens.
        if (nowOnWatch) {
            clearNavigatingToPlayer();
        }

        if (wasOnWatch && !nowOnWatch) {
            if (hasPendingUpdate()) {
                console.log('[Layout] Left watch page, applying pending PWA update');
                applyPendingUpdate();
            }
        }
    });

    beforeNavigate(({ from, to, willUnload }) => {
        if (browser && from?.url && !willUnload) scrollRestorer.save(from.url);

        // After a deploy, turn the next client-side navigation into a full page
        // load so the browser picks up the new build instead of 404ing on
        // old hashed chunks.
        if (updated.current && to?.url && !willUnload) {
            location.href = to.url.href;
        }
    });

    onMount(() => {
        // Enable the layout transitions only AFTER first paint, so the
        // server-rendered margin doesn't animate into place on hydration.
        mounted = true;
        // Register service worker for PWA (caches static assets only, respects auth)
        registerServiceWorker();

        // Setup PWA install prompt handling
        setupPWAInstall();

        const checkMobile = () => {
            isMobile = window.innerWidth < 768;
            // On mobile, close sidebar by default unless explicitly opened
            if (isMobile && !isIframePage) {
                sidebarOpen = false;
            }
        };

        checkMobile();
        const debouncedCheckMobile = debounce(checkMobile, 150);
        window.addEventListener('resize', debouncedCheckMobile);

        // Start authentication monitoring — but NOT on the standalone auth /
        // onboarding pages. Those are intentionally reachable while
        // unauthenticated, so /api/auth/check would 401 and the monitor's
        // reload logic would thrash.
        if (!isAuthPage) startAuthMonitoring();

        // Start user-scoped SSE for live cross-device watch-state sync
        if (data?.user) watchStateSSE.start();

        // Initialize the notification inbox (durable rows + live SSE frames)
        // and resume any prior OS-notification grant, ONCE at the layout
        // level — never per component (docs/architecture/user-events.md,
        // "Build — the in-app inbox"). Both are no-ops for an unauthenticated
        // visitor. `initDesktopNotifications()` never prompts — it only
        // resumes a permission the browser already remembers; the actual
        // permission prompt lives behind the explicit toggle in
        // DisplaySection.svelte (settings/display), gated on a user gesture.
        let stopNotificationInboxLive: (() => void) | undefined;
        let stopDesktopNotificationsListener: (() => void) | undefined;
        if (data?.user) {
            stopNotificationInboxLive = notificationInbox.init();
            stopDesktopNotificationsListener = initDesktopNotifications();
            // Fill the watchlist membership index ONCE, app-wide, so every
            // card's add/remove affordance knows saved from unsaved — the
            // store used to be filled only by the /watchlist page, so
            // everywhere else silently rendered "not saved". Parked on idle:
            // the GET is a full unpaginated enrichment query and nothing on
            // first paint reads it.
            scheduleWatchlistHydration();
            // Progress + success/failure of the user's manual actions, on every
            // page and across reloads (server-backed; see the store's header).
            if (data.user.username) manualRuns.start(data.user.username.toLowerCase());
        }

        // Keep unrequested modal chunks out of the player's startup network queue.
        // The effect below still gives explicit modal requests immediate priority.
        const stopModalStartupWait = isWatchPage
            ? afterFirstVideoFrame(document, () => {
                  watchFrameReady = true;
              })
            : undefined;

        // Start the player loader (see lazy-player-loader.svelte.ts): begins
        // watching every trigger, including dynamically loading the audiobook
        // stores it needs for its own audiobook triggers.
        let stopPlayerLoader: (() => void) | undefined;
        void playerLoader.start().then((stop) => {
            stopPlayerLoader = stop;
        });

        // Initialize UI preferences from localStorage
        uiPreferences.init();

        // Auto-hide splash after animation completes and add keyboard support
        const timer = setTimeout(() => {
            hideSplash();
        }, 2000); // 2 seconds for full animation

        // Add escape key listener
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                hideSplash();
                document.removeEventListener('keydown', handleKeydown);
                clearTimeout(timer);
            }
        };

        document.addEventListener('keydown', handleKeydown);

        // svelte.config.js polls /_app/version.json only every 5 minutes (it
        // used to be 60s in every tab, hidden or not). A tab coming back to the
        // foreground is the moment a missed deploy matters — the next click
        // must full-load (see beforeNavigate) — so check right then.
        const checkVersionOnVisible = () => {
            if (document.visibilityState === 'visible') void updated.check().catch(() => {});
        };
        document.addEventListener('visibilitychange', checkVersionOnVisible);

        // Cleanup function
        const cleanup = () => {
            clearTimeout(timer);
            document.removeEventListener('keydown', handleKeydown);
        };

        return () => {
            stopModalStartupWait?.();
            watchStateSSE.stop();
            manualRuns.stop();
            stopNotificationInboxLive?.();
            stopDesktopNotificationsListener?.();
            stopPlayerLoader?.();
            window.removeEventListener('resize', debouncedCheckMobile);
            document.removeEventListener('visibilitychange', checkVersionOnVisible);
            cleanup();
        };
    });
    // Use configurable logos from server, with fallback to bundled SVG assets
    let flyUrl = $derived(data?.branding?.logoSmall || flyUrlSvg);
    let fullUrl = $derived(data?.branding?.logoFull || fullUrlSvg);
    let appName = $derived(data?.branding?.appName || (m.nav_dashboard() as string));
    let backgroundImage = $derived(data?.branding?.backgroundImage || '');

    // Hydrate the appConfig store from server page data so derived
    // `$feature*` flags reflect the shared server feature matrix.
    //
    // `hydrateClientTuning` rides along for the two consumers that are plain
    // modules and so cannot reach page data: the toast store and the
    // watch-together SSE store. Both read their value at call time — showing a
    // toast, opening a party stream — which is always long after this effect
    // has flushed. Consumers that read at MOUNT time (WatchParties,
    // PlaylistChat) must not depend on this ordering, so they read
    // `page.data.clientTuning` directly instead.
    // With no universal root loader, this reference changes only when the
    // server layout is invalidated, rather than on chrome-only navigations.
    $effect(() => {
        hydrateAppConfig(data);
        hydrateClientTuning(data?.clientTuning);
    });

    // Apply branding bg to <body> (not .app-layout) so the navbar, which sits
    // outside .app-layout in app.html, shares the same background as the content
    // beneath it. Otherwise the navbar shows the hardcoded body bg from app.css
    // while content shows the branding bg — a visible seam on non-hero pages.
    $effect(() => {
        if (typeof document === 'undefined') return;
        if (backgroundImage) {
            document.body.style.backgroundImage = `url('${url(backgroundImage)}')`;
        } else {
            document.body.style.removeProperty('background-image');
        }
    });
    // The internal player is the only player.
    // Check if we're on an iframe page (don't show sidebar)
    // Account for base path in subfolder deployments
    let isIframePage = $derived($page.url.pathname.startsWith(base ? `${base}/app/` : '/app/'));
    // Initialize inside the client effect so SvelteKit does not treat lazy
    // dialog stylesheets as SSR dependencies of every route.
    let modalBootstrap: BoundedRetryLoader<boolean> | undefined;
    let watchFrameReady = $state(false);

    // Check if we're on the watch/player page (hide sidebar completely)
    let isWatchPage = $derived(isWatchRoute($page.route.id));
    $effect(() => {
        const requested = shouldBootstrapWatchModals(
            isWatchPage,
            watchFrameReady,
            $hasModals ||
                $modalRegistrationRequested ||
                !!$addToPlaylistModal ||
                $notificationDrawerOpen,
            $page.url.searchParams,
        );
        const bootstrap = untrack(() => {
            modalBootstrap ??= new BoundedRetryLoader(
                async () => {
                    await loadAndRegisterModals();
                    await openModalFromUrl();
                    return { default: true };
                },
                {
                    onAttemptFailed(attempt, maxAttempts, error) {
                        console.warn('[Layout] Failed to register modal components', error);
                        if (attempt === maxAttempts) {
                            // A fresh document also recovers cached failed module fetches.
                            toasts.error(m.error_default(), {
                                action: {
                                    label: m.retry(),
                                    onClick: () => window.location.reload(),
                                },
                            });
                        }
                    },
                },
            );
            return modalBootstrap;
        });
        bootstrap.notify(requested);
    });

    // Check if we're on the /rate swipe trainer (full-screen, no sidebar/miniplayer
    // chrome — same treatment as the watch page). Matched on `$page.route.id`
    // (canonical, base-independent) NOT on a base-prefixed pathname: with
    // SvelteKit's relative paths (`paths.relative` default), `base` from
    // $app/paths is RELATIVIZED during SSR (e.g. `'.'` on a depth-1 page), so
    // `pathname === `${base}/rate`` compares '/rate' against './rate' and the
    // suppression silently never fires server-side. route.id is '/rate' in
    // every environment. Boundary-safe: exact route or nested routes only.
    let isRatePage = $derived(
        $page.route.id === '/rate' || ($page.route.id?.startsWith('/rate/') ?? false),
    );
    // Check if we're on the device auth page (hide notifications)
    let isDevicePage = $derived($page.url.pathname.startsWith(base ? `${base}/device` : '/device'));
    // The admin shell mounts its own ToastContainer (bottom-left, so it never
    // overlaps the right slide-in DetailPanel). Suppress this root instance
    // there — otherwise every admin toast rendered twice, once in each corner.
    let isAdminPage = $derived($page.url.pathname.startsWith(base ? `${base}/admin` : '/admin'));

    /**
     * /admin renders its OWN 220px labelled sidebar (AdminSidebar.svelte), so a
     * labelled dock beside it would stack 440px of navigation before any admin
     * content. The dock drops to its icon rail there — tooltips and all —
     * without touching the viewer's saved preference.
     *
     * Route-derived rather than read from the admin layout's `navStyle` (which
     * is not in root-layout data): this keeps the server render and the first
     * client render identical, which a store write could not. The cost is
     * suppressing labels on /admin even under the 'mega' nav style, where there
     * is no second sidebar to collide with.
     */
    // Dock mode. `data.dockMode` is the per-request cookie value and is what SSR
    // renders both gutter classes from; the store carries in-session changes.
    //
    // The seed is top-level component script, so it runs ONCE per app boot: a
    // later navigation's `data.dockMode` cannot overwrite a change made since.
    // (`untrack` only silences `state_referenced_locally`; the once-ness comes
    // from where the line sits, not from untrack.) It is client-only, because a
    // module-level store written during SSR is shared across concurrent
    // requests and would hand one viewer's dock to the next.
    //
    // Reading the store only under `browser` is what keeps the first client
    // render identical to the server's: effects run after that render, so an
    // effect-based seed would drop the class the server just sent and slide the
    // page 150px on every load.
    let ssrDockMode = $derived(parseDockMode(data?.dockMode));
    if (browser) seedDockMode(parseDockMode(untrack(() => data?.dockMode)));
    let dockIsVisible = $derived(browser ? $dockVisible : ssrDockMode !== 'hidden');
    let dockIsLabelled = $derived(
        !isAdminPage && (browser ? $dockLabels : ssrDockMode === 'labels'),
    );
    // Only show splash on main dashboard page
    let isDashboardPage = $derived($page.url.pathname === (base || '/'));
    // Native-login / first-run onboarding pages render standalone (no app shell):
    // they are reachable by unauthenticated visitors and must not show the
    // sidebar/footer/player chrome. Predicate lives in app-shell-route.ts —
    // the single source of truth both this and the music-store bootstrap
    // gate below derive from (fix round 2).
    let isAuthPage = $derived(isAuthRoute($page.url.pathname, base));
    // The public product showcase supplies its OWN chrome-less +layout (full-screen,
    // black bg, minimal branding header, kiosk mode). It's reachable by anonymous
    // visitors and must NOT get the app sidebar/header shell — otherwise the app
    // chrome bleeds through behind it (sidebar visible, title colliding with the
    // logo, a hard background seam). Render it standalone like the auth pages.
    let isShowcasePage = $derived(isShowcaseRoute($page.url.pathname, base));

    // Bootstrap the music store the first time — and only the first time —
    // the app-shell branch below ({:else}) is active (fix round 1,
    // Critical 1). That bootstrap (musicPlayerStore.init() +
    // hydrateFromPersistence(), which creates the audio backend and can
    // RESUME PLAYBACK from a persisted "was playing" session) used to live in
    // MiniPlayer.svelte's own mount effect, which only ever mounted inside
    // this same {:else} branch — i.e. never on /login, /setup, or /showcase*.
    // Running it unconditionally from onMount would run it there too: land
    // on /login with a session that expired mid-playback and the app would
    // silently resume audio, MediaSession and a wake lock with no player UI
    // anywhere on screen.
    //
    // Can't just gate the onMount call with an `if`, either — the root
    // layout persists across client-side navigation, so onMount runs exactly
    // once. A user who lands on /login and then navigates into the app would
    // then never get init()/hydrate() at all. RunOnceWhenTrue (see that
    // file's own doc comment) is what makes this re-evaluate on every route
    // change (via this $effect) while still firing the bootstrap exactly
    // once — on first paint for the common case (landing directly on an app
    // route), or on the first later transition into the app-shell branch
    // otherwise.
    //
    // Gate condition is isAppShellRoute() directly (fix round 2) — NOT a
    // hand-composed `!isAuthPage && !isShowcasePage` here: that expression
    // was exercised by no test, so a dropped `!` or a swapped `&&`/`||`
    // would have silently reintroduced Critical 1 with everything else
    // green. isAppShellRoute is the same predicate the template's
    // {#if isAuthPage}...{:else if isShowcasePage}...{:else} branches below
    // are ultimately built from (via isAuthPage/isShowcasePage above), so
    // there's one source of truth — see app-shell-route.ts.
    $effect(() => {
        musicStoreBootstrapGate.run(isAppShellRoute($page.url.pathname, base), () => {
            void musicPlayerStore.init().then(() => musicPlayerStore.hydrateFromPersistence());
        });
    });

    // On desktop, sidebar is always open for main pages
    $effect(() => {
        if (!isMobile && !isIframePage) {
            sidebarOpen = true;
        }
    });

    // The /settings overlay (own route) renders into THIS layout's <main> via
    // {@render children()} — i.e. INSIDE .app-layout, not above it. So we must
    // NOT mark .app-layout inert (that would disable the settings overlay itself
    // → nothing clickable). Instead inert only the genuine "page-behind": the
    // Sidebar. (a11y spec #2 — AT/Tab can't reach the hidden sidebar.)
    // Exception: when the overlay is launched on top of the player, keep the
    // player interactive — so we only inert when NOT on the watch/player page.
    const settingsOverlayOpen = $derived(
        $page.url.pathname.startsWith(base ? `${base}/settings` : '/settings') && !isWatchPage,
    );

    // Mobile music bottom nav: route-scoped (CSS handles the < lg gating) and
    // suppressed while the FullScreenPlayer covers the viewport (it hides the
    // bar anyway). This flag ALSO drives the --music-bottom-nav-h-raw var in
    // Task 3 — keep the two in sync.
    const musicBottomNavVisible = $derived(
        isMusicBottomNavRoute(
            $page.route.id ?? null,
            $page.url.searchParams,
            $page.data?.playlist?.playlistType,
        ) && !$musicPlayerStore.isFullScreen,
    );

    // Publish --music-bottom-nav-h-raw on the real <html> root (not on
    // .app-layout) so app.css's `:root { --music-bottom-nav-h: var(--music-
    // bottom-nav-h-raw, 0px) }` media-query rule — which only ever matches the
    // :root element itself — actually sees a non-fallback value. CSS custom
    // properties inherit downward only; a rule scoped to `:root` resolves
    // var() references using :root's OWN value of the referenced property,
    // not a descendant's. Setting the raw var on .app-layout's inline style
    // (as originally written) is therefore invisible to that rule, so
    // --music-bottom-nav-h silently stayed 0px everywhere, for every
    // consumer (MiniPlayer, QueuePanel, ModalContainer, .main-content) at
    // every viewport width — verified empirically in a real browser.
    // Mirrors the existing --miniplayer-height JS-effect pattern in
    // MiniPlayer.svelte (same cross-sibling-boundary problem, same fix).
    // MusicBottomNav separately measures its border-box, including safe-area
    // padding and any growth for larger text. Keep that measurement independent
    // of visibility so navigation cannot overwrite it with the 56px fallback.
    $effect(() => {
        document.documentElement.style.setProperty(
            '--music-bottom-nav-h-raw',
            musicBottomNavVisible
                ? 'var(--music-bottom-nav-measured-h, calc(3.5rem + env(safe-area-inset-bottom)))'
                : '0px',
        );
    });
</script>

<!-- Default tab title for every page (SEO pattern: root-layout title from
     page.data). Pages override it with their own <svelte:head><title>; SvelteKit
     keeps only the deepest title, so there's no duplicate <title> and no
     pre-hydration flash. Kept out of app.html for exactly that reason. -->
<svelte:head>
    <title>{appName}</title>
</svelte:head>

<!-- Decorative starfield/nebula background — fixed, full-viewport, behind all
     content on every page (auth, showcase, and the main app shell alike).
     Theme-scoped CSS can turn it off per-theme via
     `[data-theme='x'] .app-starfield { display: none }` (see src/app.css). -->
<div class="app-starfield app-starfield-image" aria-hidden="true"></div>

{#if !isAdminPage}
    <ToastContainer />
{/if}
{#if appChrome}
    {@const GlobalChrome = appChrome.GlobalChrome}
    <GlobalChrome {data} {isAdminPage} {isDevicePage} isStandalone={isAuthPage || isShowcasePage} />
{/if}

{#if isAuthPage}
    <!-- Standalone full-page auth / first-run onboarding shell (no app chrome).
         A plain <div>: /login, /setup and /setup/locked each render their own
         <main>, and nesting two main landmarks confuses screen readers. -->
    <NavigationProgressBar active={$isModalLoading} />
    <div class="auth-shell">
        {@render children?.()}
    </div>
{:else if isShowcasePage}
    <!-- Public product showcase: its own +layout supplies the full-screen chrome.
         Render bare — no app sidebar/header/footer/player. -->
    <NavigationProgressBar active={$isModalLoading} />
    {@render children?.()}
{:else}
    <MaintenanceBanner />
    <NavigationProgressBar active={$isModalLoading} />

    <!-- Splash screen with proper SvelteKit asset references -->
    {#if showSplash && isDashboardPage}
        <div
            id="splash-screen"
            class="splash-overlay"
            role="button"
            tabindex="0"
            onclick={hideSplash}
            onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') hideSplash();
            }}>
            <div class="stage">
                <!-- Flying button -->
                <img class="fly" src={flyUrl} alt={m.layout_button_alt({ appName })} />
                <!-- Full logo fades in -->
                <img class="full" src={fullUrl} alt={m.layout_logo_alt({ appName })} />
            </div>

            <!-- Skip button -->
            <div class="skip-hint">
                <p class="text-surface-400 text-sm">{m.layout_skip_intro()}</p>
            </div>
        </div>
    {/if}

    <!-- Show sidebar for all pages except watch/player -->
    <!-- --music-bottom-stack = nav-h + miniplayer-h + max(0, safe-area - nav-h).
         The 3rd term is only nonzero when the MiniPlayer is visible AND the bar
         isn't reserving the safe-area for it already (bar height already
         includes env(safe-area-inset-bottom) when shown, so nav-h >= safe-area
         whenever the bar is present and the term collapses to 0 — see
         MiniPlayer.svelte's matching `padding-bottom:
         max(0px, calc(safe-area - var(--music-bottom-nav-h)))`). Keeps the two
         in sync so content padding always matches the MiniPlayer's real
         footprint, in every bar/player combination, without double-counting
         the safe-area. -->
    <div
        class="app-layout"
        style="--music-bottom-stack: calc({$isMinPlayerVisible && !isWatchPage && !isRatePage
            ? 'var(--miniplayer-h)'
            : '0px'} + var(--music-bottom-nav-h) + {$isMinPlayerVisible &&
        !isWatchPage &&
        !isRatePage
            ? 'max(0px, calc(env(safe-area-inset-bottom) - var(--music-bottom-nav-h, 0px)))'
            : '0px'});">
        {#if appChrome}
            {@const SidebarChrome = appChrome.SidebarChrome}
            <SidebarChrome
                {data}
                {isAdminPage}
                {isWatchPage}
                {isRatePage}
                {dockIsVisible}
                {settingsOverlayOpen}
                bind:sidebarOpen />
        {/if}

        <main
            class="main-content {!isAdminPage && !isWatchPage && !isRatePage && dockIsVisible
                ? 'with-sidebar'
                : ''} {dockIsLabelled ? 'with-dock-labels' : ''} {$isMinPlayerVisible &&
            !isWatchPage &&
            !isRatePage
                ? 'with-miniplayer'
                : ''} {musicBottomNavVisible ? 'with-bottom-nav' : ''} {mounted
                ? 'transitions'
                : ''}">
            {@render children?.()}
        </main>
        {#if !isAdminPage && !isWatchPage && !isRatePage && !isDevicePage && appChrome}
            <!-- Inside .app-layout so it can sit above --music-bottom-stack. -->
            {@const AppInstallHint = appChrome.AppInstallHint}
            <AppInstallHint enabled={data?.appInstallHint === true} />
        {/if}
    </div>

    {#if playerLoader.miniPlayer}
        {@const MiniPlayer = playerLoader.miniPlayer}
        <MiniPlayer />
    {/if}
    <!-- Docks in the same place as MiniPlayer, above the unchanged
         MusicBottomNav. Only one of the two bars is ever mounted: starting a
         book claims audio, which stops the music store, which resets its state
         and unmounts MiniPlayer (and vice versa). -->
    {#if playerLoader.audiobookMiniPlayer}
        {@const AudiobookMiniPlayer = playerLoader.audiobookMiniPlayer}
        <AudiobookMiniPlayer />
    {/if}
    {#if musicBottomNavVisible && appChrome}
        {@const MusicBottomNav = appChrome.MusicBottomNav}
        <MusicBottomNav />
    {/if}
    {#if playerLoader.fullScreenPlayer}
        {@const FullScreenPlayer = playerLoader.fullScreenPlayer}
        <FullScreenPlayer />
    {/if}
    {#if playerLoader.audiobookFullScreen}
        {@const AudiobookFullScreen = playerLoader.audiobookFullScreen}
        <AudiobookFullScreen />
    {/if}
{/if}

<style>
    .auth-shell {
        min-height: 100vh;
        min-height: 100dvh;
        width: 100%;
    }

    .splash-overlay {
        position: fixed;
        inset: 0;
        z-index: 10100; /* Z.SYSTEM_OVERLAY */
        background: rgb(15 23 42);
        display: grid;
        place-items: center;
        cursor: pointer;
    }

    .stage {
        position: relative;
        width: 900px;
        max-width: 90vw;
    }

    .fly {
        position: absolute;
        top: 50%;
        left: 0;
        width: 190px;
        transform: translate(0px, -50%);
        z-index: 2;
        animation: moveRight 1.25s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
    }

    .full {
        width: 100%;
        opacity: 0;
        position: relative;
        z-index: 1;
        visibility: hidden;
        animation: showLogo 0.55s ease-out forwards;
        animation-delay: 1.25s;
    }

    .skip-hint {
        position: absolute;
        bottom: 2rem;
        left: 50%;
        transform: translateX(-50%);
        text-align: center;
        opacity: 0;
        animation: fadeIn 0.3s ease-out forwards;
        animation-delay: 1.8s;
    }

    /* Fixed keyframes - no CSS variables to avoid conflicts */
    @keyframes moveRight {
        0% {
            transform: translate(0, -50%) scale(1);
            opacity: 1;
            filter: blur(0);
        }
        70% {
            transform: translate(640px, -50%) scale(1.05);
            opacity: 1;
            filter: blur(0.2px);
        }
        100% {
            transform: translate(620px, -50%) scale(1);
            opacity: 0;
            filter: blur(0);
        }
    }

    @keyframes fadeIn {
        to {
            opacity: 1;
        }
    }

    @keyframes showLogo {
        0% {
            visibility: hidden;
            opacity: 0;
        }
        1% {
            visibility: visible;
            opacity: 0;
        }
        100% {
            visibility: visible;
            opacity: 1;
        }
    }

    /* Mobile responsive - just sizing, no animation changes */
    @media (max-width: 768px) {
        .fly {
            width: 120px;
        }

        .stage {
            width: 600px;
        }

        .skip-hint {
            bottom: 1rem;
        }
    }

    @media (max-width: 480px) {
        .fly {
            width: 80px;
        }

        .stage {
            width: 400px;
        }
    }

    /* App layout styles */
    .app-layout {
        display: flex;
        /* 100lvh = large viewport (URL bar hidden state). Extends content into
           iOS Safari's bottom safe-area so the translucent URL pill tints the
           actual page content instead of a theme-color solid fill. */
        min-height: 100lvh;
    }

    .main-content {
        flex: 1;
        min-width: 0; /* Prevent flex item from overflowing */
        overflow-x: hidden; /* Prevent horizontal scrolling */
        width: 100%; /* Ensure content takes full width but doesn't exceed */
    }

    /* Transition is enabled only after first paint (via the `transitions` class
       added in onMount) so the server-rendered sidebar gutter does NOT animate
       into place on hydration — that caused a ~70px rightward slide on load. */
    .main-content.transitions {
        transition: margin-left 0.3s ease-in-out;
    }

    /* Desktop: main-content owns vertical scroll (app-shell pattern).
       Mobile (< 1024px) lets the document scroll so iOS Safari's URL bar
       minimizes on scroll and the navbar scrolls off with it. */
    @media (min-width: 1024px) {
        .main-content {
            overflow-y: auto;
            max-height: 100dvh;
        }
    }

    /* The sidebar gutter is viewport-governed (CSS), NOT JS `isMobile`, so the
       server render matches the client's first paint on BOTH desktop and mobile
       (mobile must get 0 — a 70px SSR margin would jump ~20% of a phone width).
       The `with-sidebar` class itself is SSR-stable (!isWatchPage && !isRatePage && dockVisible). */
    .main-content.with-sidebar {
        margin-left: 0;
    }

    @media (min-width: 768px) {
        .main-content.with-sidebar {
            margin-left: 70px;
        }

        /* Labelled rail. Seeded from the dock-labels cookie during layout init,
           so this width is already on the server-rendered markup and the page
           does not slide when the store hydrates. Must stay in lockstep with
           `.icon-dock.labeled` in src/lib/Sidebar.svelte (220px). */
        .main-content.with-sidebar.with-dock-labels {
            margin-left: 220px;
        }
    }

    /* Bottom chrome height driven by --music-bottom-stack (MiniPlayer +
       mobile bottom nav). Default 56px keeps SSR desktop stable before the
       reactive var lands. */
    .main-content.with-miniplayer {
        padding-bottom: var(--music-bottom-stack, 56px);
    }

    /* Music routes with the bar but no active MiniPlayer still need clearance. */
    .main-content.with-bottom-nav {
        padding-bottom: var(--music-bottom-stack, 0px);
    }

    /* Mobile adjustments */
    @media (max-width: 767px) {
        .main-content.with-sidebar {
            margin-left: 0; /* No margin on mobile, sidebar overlays */
        }
    }
</style>
