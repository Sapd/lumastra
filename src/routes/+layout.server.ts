// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Root layout server load function
 *
 * Provides server-side config (branding, features, sidebar links) to all pages.
 */

import { getLocale } from '$lib/paraglide/runtime.js';
import { localizeItems, type LocalizedLabels } from '$lib/shared/localized-label';
import { heroButtonLabel, userMenuLinkLabel } from '$lib/config/hero-button-labels';
import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { getServerBranding, getServerFeatures } from '$lib/server/server-branding.js';
import { getConfiguredMetadataAttributions } from '$lib/server/services/metadata-attributions.service.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { get as getConfigValue } from '$lib/server/config/config.service.js';
import { operationMode } from '$lib/server/operation-mode.js';
import type { ClientOperationMode } from '$lib/schemas/operation-mode';
import { getDb } from '$lib/server/database/connection.js';
import {
    getActiveNonEntertainmentLibraries,
    getActiveLibraryTypes,
} from '$lib/server/database/queries/library-types.queries.js';
import {
    boundaryCacheKey,
    denyAllAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import type { UserContext } from '$lib/server/types.js';
import { loadFeedPrefsForUser } from '$lib/server/database/queries/user-preferences.queries.js';
import { DEFAULT_FEED_PREFS } from '$lib/shared/feed-section-kinds';
import { getEnabledThemes, resolveActiveThemeId } from '$lib/server/theme/enabled-themes.js';
import { THEME_COOKIE } from '$lib/shared/theme/theme-model';
import { DOCK_COOKIE, parseDockMode } from '$lib/stores/dock.store';
import {
    listPluginWidgets,
    listPluginNavEntries,
} from '$lib/server/plugins/runtime/widget-metadata.js';
import { resolveNavIcons } from '$lib/server/resolve-nav-icons.js';
import { visibleNavItems } from '$lib/server/navigation/visible-nav-items.js';
import { LIBRARY_TYPE_TEMPLATES } from '$lib/shared/library-type-templates.js';
import { localsIsAdmin, localsIsAdminOrArrManager } from '$lib/server/auth/locals-admin.js';

export interface SidebarLink {
    label: string;
    url: string;
    icon?: string; // Icon name (e.g., 'film', 'book-open') or path to SVG
    outline?: boolean; // True for outline-style icons (Hero Icons), false for service icons with backgrounds
    external?: boolean;
    groups?: string[]; // Required groups to see this item
    section?: string; // Optional section ID to group this link under a collapsible section
    displayOrder?: number; // Position in navigation (only for top-level links; interleaved with sections)
    labels?: LocalizedLabels; // Optional per-language labels; `label` is the fallback
}

export interface SidebarSection {
    id: string; // Unique identifier for the section
    label: string; // Display label
    icon?: string; // Icon for the section header
    collapsed?: boolean; // Initial collapsed state (default: true)
    groups?: string[]; // Required groups to see this section (empty = visible to all)
    displayOrder?: number; // Position in navigation (interleaved with top-level links)
    labels?: LocalizedLabels; // Optional per-language labels; `label` is the fallback
}

export interface UserMenuLink {
    label: string;
    url: string;
    icon?: string; // Icon name (e.g., 'cog-6-tooth', 'key') or path to SVG/image
    external?: boolean; // Open in new tab (default: true)
    labels?: LocalizedLabels; // Optional per-language labels; `label` is the fallback
}

export interface FooterLink {
    id: string; // Unique identifier (e.g., 'request', 'chat', 'wiki', 'quickconnect')
    label: string;
    url?: string; // URL for link buttons (not needed for special buttons like quickconnect)
    icon?: string; // Icon name or path to SVG/image
    external?: boolean; // Open in new tab (default: true for URLs)
    variant?: string; // Button variant (e.g., 'ghost-secondary', 'ghost-primary')
    labels?: LocalizedLabels; // Optional per-language labels; `label` is the fallback
}

export interface HeroButton {
    id: string; // Unique identifier
    action: 'search' | 'browse' | 'assistant' | 'link'; // Built-in action or custom link
    label: string;
    icon: string; // Icon name (navigationIconMap key) or path to SVG/image
    url?: string; // URL (only for action === 'link')
    external?: boolean; // Open in new tab (only for action === 'link')
    enabled: boolean; // Show/hide toggle
    labels?: LocalizedLabels; // Optional per-language labels; `label` is the fallback
}

// Cache non-entertainment libraries for sidebar (changes very rarely).
//
// Keyed by access boundary. It used to be a single unkeyed module-level array
// holding the UNFILTERED library list, which every user's sidebar then rendered
// — the sidebar disclosed the operator's personal/home_video library names to
// users denied those groups. Keying by boundary keeps the cache while making a
// restricted user's entry physically distinct from an unrestricted one.
type NonEntLibraries = Array<{
    media_type: string;
    library_group_id: string;
    display_name: string | null;
    sidebar_visible: boolean;
    icon: string | null;
    sort_order: number;
}>;
const _nonEntCache = new Map<string, { libraries: NonEntLibraries; expiry: number }>();
let _activeLibTypesCache: string[] = [];
let _activeLibTypesCacheExpiry = 0;
// 5 s: short enough that sidebar reflects settings changes promptly on all
// cluster nodes (cross-node invalidation via pub/sub is not wired here; the
// in-process _invalidateNonEntLibraryCache() only resets the local node).
const NON_ENT_CACHE_TTL_MS = 5_000;

/** Invalidate the cached non-entertainment libraries (e.g. after settings change). */
export function _invalidateNonEntLibraryCache(): void {
    _nonEntCache.clear();
    _activeLibTypesCacheExpiry = 0;
}

/**
 * Access boundary for this request's sidebar.
 *
 * Closed by default: an anonymous visitor (only /login and /setup, whose chrome
 * lives outside the app shell) gets `denyAll` rather than the operator's full
 * library list, and so does a request whose permission lookup fails.
 */
async function resolveSidebarAccess(user: UserContext | undefined): Promise<MediaAccessBoundary> {
    const sql = getDb();
    if (!sql || !user) return denyAllAccess();
    try {
        // L1-cached library-group permission lookup — cheap enough for a layout load.
        return searchAccessBoundary(await buildSearchAccessContext(sql, user));
    } catch {
        // Non-critical — sidebar just won't show non-entertainment entries.
        return denyAllAccess();
    }
}

async function getCachedNonEntLibraries(access: MediaAccessBoundary): Promise<NonEntLibraries> {
    const key = boundaryCacheKey(access);
    const entry = _nonEntCache.get(key);
    if (entry && Date.now() < entry.expiry) return entry.libraries;
    try {
        const sql = getDb();
        if (sql) {
            const libraries = await getActiveNonEntertainmentLibraries(sql, access);
            // Drop expired keys before inserting. Boundaries are per-user now, so
            // unlike the old single-slot cache this Map would otherwise grow with
            // the number of distinct {denied groups, age limit} tuples seen.
            const now = Date.now();
            for (const [k, v] of _nonEntCache) {
                if (now >= v.expiry) _nonEntCache.delete(k);
            }
            _nonEntCache.set(key, { libraries, expiry: now + NON_ENT_CACHE_TTL_MS });
            return libraries;
        }
    } catch {
        // Non-critical — sidebar just won't show non-entertainment entries
    }
    return entry?.libraries ?? [];
}

async function getCachedActiveLibraryTypes(): Promise<string[]> {
    if (Date.now() < _activeLibTypesCacheExpiry) return _activeLibTypesCache;
    try {
        const sql = getDb();
        if (sql) {
            _activeLibTypesCache = await getActiveLibraryTypes(sql);
            _activeLibTypesCacheExpiry = Date.now() + NON_ENT_CACHE_TTL_MS;
        }
    } catch {
        // Non-critical
    }
    return _activeLibTypesCache;
}

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
    const ai = getAiConfig();

    // Theme picker payload — the minimal set a client picker needs (id + display
    // name) plus the currently-active id (cookie → configured default → 'warp').
    // Knob/hex values stay server-side; the generated token CSS is injected into
    // <head> by hooks.server.ts, so the client never needs the seed colors.
    const enabledThemes = getEnabledThemes();
    const themes = {
        enabled: enabledThemes.map((t) => ({ id: t.id, name: t.name })),
        active: resolveActiveThemeId(cookies.get(THEME_COOKIE), enabledThemes),
    };
    // Load active non-entertainment library types for sidebar (cached 60s)
    // and resolve the AI-assistant module license gate in parallel (fail-open).
    // Anonymous visitors only ever reach the standalone /login and /setup pages,
    // whose chrome lives outside the app shell and which source the available
    // sign-in methods from their OWN +page.server.ts (nativeEnabled/oidcEnabled) —
    // NOT from the layout. So the full feature-flag matrix, operation mode, app
    // version and chatbot persona have no pre-auth client use and would only hand
    // a scanner an integration-presence oracle + version disclosure. Gate them on
    // an authenticated session; keep safe-shaped defaults so logged-in consumers
    // (which all use optional chaining + `!== false` / `=== true` / `|| fallback`
    // defaults) never crash, and branding stays fully public for the login UI.
    const isAuthed = Boolean(locals.user);

    const [nonEntertainmentLibraries, activeLibraryTypes, brand, webFeatures, feedPreferences] =
        await Promise.all([
            resolveSidebarAccess(locals.user as UserContext | undefined).then(
                getCachedNonEntLibraries,
            ),
            getCachedActiveLibraryTypes(),
            getServerBranding(),
            isAuthed ? getServerFeatures() : Promise.resolve({}),
            isAuthed
                ? loadFeedPrefsForUser(getDb(), locals.user?.userId)
                : Promise.resolve(DEFAULT_FEED_PREFS),
        ]);

    // Navigation config (from config service: ENV > JSON > Default). Hoisted
    // into consts (rather than read inline below) so the icon names they
    // carry can be collected once here, before the resolved-icon map is
    // computed — reading `getConfigValue` a second time inside the return
    // object below would risk it disagreeing with the copy used for name
    // collection if the config changed between the two reads.
    // Filtered to what THIS viewer may see (nothing when anonymous) before they
    // leave the server: the browser-side group filter is presentation, not access.
    // Admin-only links follow the credential's verdict, not the owner flag.
    const navViewer = locals.user ? { ...locals.user, isAdmin: localsIsAdmin(locals) } : undefined;
    const sidebarLinks = visibleNavItems(
        getConfigValue<SidebarLink[]>('SIDEBAR_LINKS') ?? [],
        navViewer,
    );
    const sidebarSections = visibleNavItems(
        getConfigValue<SidebarSection[]>('SIDEBAR_SECTIONS') ?? [],
        navViewer,
    );
    const userMenuLinks = visibleNavItems(
        getConfigValue<UserMenuLink[]>('USER_MENU_LINKS') ?? [],
        navViewer,
    );
    const footerLinks = visibleNavItems(
        getConfigValue<FooterLink[]>('FOOTER_LINKS') ?? [],
        navViewer,
    );
    const heroButtons = visibleNavItems(
        getConfigValue<HeroButton[]>('HERO_BUTTONS') ?? [],
        navViewer,
    );
    // Admin-typed labels, resolved for this viewer's language here, once, so no
    // renderer has to know about `labels` (see $lib/shared/localized-label).
    const viewerLocale = getLocale();
    const pluginNavEntries = listPluginNavEntries({
        userGroups: locals.user?.userGroups,
        isAdmin: localsIsAdmin(locals),
    });

    // Resolve every admin-configured navigation icon NAME to its IconSource
    // object HERE, on the server, instead of shipping the full 212-icon admin
    // nav picker catalog to every client (see resolve-nav-icons.ts for the
    // full rationale). Only names actually referenced by this viewer's
    // navigation make it into `navIcons` below.
    //
    // The library-type templates' `icon` values (a fixed, code-defined set —
    // see LIBRARY_TYPE_TEMPLATES) are included unconditionally alongside each
    // non-entertainment library's own DB-stored override: Sidebar.svelte
    // falls back to the template's icon when a library has none set
    // (`lib.icon ?? template?.icon ?? 'folder'`), and that fallback can't be
    // pre-computed here without duplicating Sidebar's per-library matching —
    // cheaper to just always resolve the (small, fixed) template set.
    const navIcons = resolveNavIcons([
        ...sidebarLinks.map((l) => l.icon),
        ...sidebarSections.map((s) => s.icon),
        ...userMenuLinks.map((l) => l.icon),
        ...heroButtons.map((b) => b.icon),
        ...pluginNavEntries.map((e) => e.icon),
        ...nonEntertainmentLibraries.map((lib) => lib.icon),
        ...Object.values(LIBRARY_TYPE_TEMPLATES).map((t) => t.icon),
        'folder',
    ]);

    return {
        publicBaseUrl: config.PUBLIC_BASE_URL,
        // Dock display mode ('labels' | 'icons' | 'hidden'). Server-read because
        // the rail's width is the main content's left gutter: deciding it on the
        // client paints the wrong gutter first and slides the page on hydration.
        dockMode: parseDockMode(cookies.get(DOCK_COOKIE)),
        // Plugin widget metadata for surfaces that are not the home page — the
        // detail modal opens from EVERY route, so its list cannot come from
        // `+page.server.ts`. Same shared, de-duplicated helper the home page
        // uses, so the two never disagree about a composite-id collision.
        // Installed-plugin metadata is nothing an anonymous visitor's bare page uses.
        pluginWidgets: isAuthed ? listPluginWidgets() : [],
        // Sidebar entries for plugin-owned pages this viewer may open. The page
        // load re-checks access — this only decides what the sidebar advertises.
        pluginNavEntries,
        // The viewer, in the exact shape the plugin SDK defines, built ONCE
        // here rather than reassembled in each component. `locals.user` carries
        // `userId`/`isAdmin`; the client-side `PageData['user']` type does not,
        // so a component reconstructing this would be guessing.
        pluginUser: locals.user?.username
            ? {
                  userId: String(locals.user.userId ?? ''),
                  username: locals.user.username,
                  groups: locals.user.userGroups ?? [],
                  isAdmin: localsIsAdmin(locals),
              }
            : null,
        mediaLanguagePriority: [
            config.TMDB_LANGUAGE ?? 'en-US',
            ...(config.METADATA_ADDITIONAL_LANGUAGES ?? []),
        ],
        nonEntertainmentLibraries,
        // Which library kinds exist is instance inventory; anonymous pages render no sidebar.
        activeLibraryTypes: isAuthed ? activeLibraryTypes : [],
        metadataAttributionProviders: isAuthed
            ? await getConfiguredMetadataAttributions(getDb(), activeLibraryTypes.includes('music'))
            : [],
        // Enabled themes (id + name) and the active theme id for client pickers.
        themes,
        // The client reads user.isAdmin: give it the credential's verdict.
        user: locals.user ? { ...locals.user, isAdmin: localsIsAdmin(locals) } : locals.user,
        // Per-user For You feed section visibility (mode + hidden kinds).
        feedPreferences,
        // Authentication method for this request — lets the client conditionally
        // show native-only account actions (change password / logout) to session
        // users while hiding them from forward-auth / IdP-managed users.
        authMethod: locals.authMethod,
        // Whether MyAnimeList OAuth is configured on this deployment (deployment-
        // level, not a per-user secret). Lets the /settings Connections section
        // gate render server-side without a client round-trip, so a MAL-only
        // install (Jellyfin/Subsonic compat off) can still reach it. Authed-only.
        malConfigured: isAuthed ? Boolean(config.MAL_CLIENT_ID && config.MAL_CLIENT_SECRET) : false,
        // IdP group NAMES are internal identifiers used only by authenticated
        // client-side nav/permission gating (intersected with user.userGroups).
        // Never ship them to anonymous visitors (/login, /setup) — pre-auth they
        // have no client use and only give a scanner recon/phishing value. Empty
        // arrays keep the field shape (consumers already default to []).
        // NOTE: logged-in users still receive them; fully removing that would
        // require refactoring ~15 consumers to server-computed capability
        // booleans (deferred — low-sensitivity residual, high regression risk).
        adminGroups: locals.user ? config.ADMIN_GROUPS : [],
        watchPermissionGroups: locals.user ? config.WATCH_PERMISSION_GROUPS : [],
        arrManagerGroups: locals.user ? config.ARR_MANAGER_GROUPS : [],
        liveTvGroups: locals.user ? config.LIVETV_GROUPS : [],
        requestGroups: locals.user ? config.REQUEST_GROUPS : [],
        socialReviewGroups: locals.user ? config.SOCIAL_REVIEW_GROUPS : [],
        mediaAnnotationGroups: locals.user ? config.MEDIA_ANNOTATION_GROUPS : [],
        navigationAvailableGroups: locals.user ? config.NAVIGATION_AVAILABLE_GROUPS : [],
        playlistPublicGroups: locals.user ? config.PLAYLIST_PUBLIC_GROUPS : [],
        // Version disclosure — gate to authenticated sessions (AboutModal defaults
        // to 'unknown'; the admin System → Instance page that reads it requires
        // auth anyway).
        appVersion: isAuthed ? config.APP_VERSION : '',
        // Branding flows through the operator's config ONLY when the
        // 'branding_removal' module is licensed (or enforcement is off). Otherwise
        // `brand` is the default Lumastra identity — computed above.
        branding: brand,
        // Admin switch for the iPhone/iPad "Get the app" hint (AppInstallHint);
        // the device/HTTPS/dismiss rules are decided client-side after mount.
        appInstallHint: config.WEB_APP_INSTALL_HINT,
        // Chatbot persona — only used by authenticated AI surfaces (Footer, AI
        // assistant, dashboard). Empty-but-shaped for anonymous so consumers'
        // `|| 'fallback'` defaults kick in without leaking the configured persona.
        chatbot: isAuthed
            ? {
                  name: ai.assistantName,
                  avatar: ai.assistantAvatar,
                  persona: ai.assistantPersona,
                  dailyLimitUser: ai.assistantDailyLimitUser,
                  dailyLimitAdmin: ai.assistantDailyLimitAdmin,
              }
            : { name: '', avatar: '', persona: '', dailyLimitUser: 0, dailyLimitAdmin: 0 },
        // Feature-flag matrix is an integration-presence oracle (e.g. jellyfinCompat,
        // subsonicCompat, requests). The unauthenticated /login + /setup UIs read
        // none of it — they derive the sign-in buttons from their own page loads —
        // so anonymous gets an empty object. Consumers default appropriately
        // (`?.flag === true` → false, `?.flag !== false` → true) on the empty map.
        // The `as` is load-bearing: without it the value's type is the UNION of the
        // authed map and the anonymous `{}`, and a property access on the `{}` half
        // fails — so `data.features.<flag>` did not resolve on ANY consumer (26 of
        // the errors in this pass). That was a type-level lie: consumers already
        // guard with `?.flag === true` / `?.flag !== false`, which is exactly what
        // an all-optional AppFeatures models.
        features: ('liveTV' in webFeatures
            ? {
                  ...webFeatures,
                  liveTV: webFeatures.liveTV === true && locals.user?.hasLiveTvPermission === true,
              }
            : webFeatures) as NonNullable<App.PageData['features']>,
        // Homepage hero (client-side carousel needs these literally)
        hero: {
            autoplayEnabled: config.HERO_AUTOPLAY_ENABLED,
            autoplayIntervalMs: config.HERO_AUTOPLAY_INTERVAL_MS,
            transitionMs: config.HERO_TRANSITION_MS,
            maxSlides: config.HERO_MAX_SLIDES,
        },
        // Hover preview configuration
        hover: {
            liveTvDelayMs: config.PREVIEW_HOVER_DELAY_LIVETV_MS,
            videoDelayMs: config.PREVIEW_HOVER_VIDEO_DELAY_MS,
            // Total cap (seconds) on how long MediaPreviewPlayer keeps looping
            // a hovered preview before reverting to the backdrop image (unless
            // still actively hovered, in which case it re-arms).
            maxSeconds: config.PREVIEW_HOVER_MAX_SECONDS,
        },
        // ForYou/Recommendations configuration (client-side limits)
        forYou: {
            defaultLimit: config.FORYOU_DEFAULT_LIMIT,
            sourcesLimit: config.FORYOU_SOURCES_LIMIT,
            similarPerSource: config.FORYOU_SIMILAR_PER_SOURCE,
            keywordRows: config.FORYOU_KEYWORD_ROWS,
            keywordItems: config.FORYOU_KEYWORD_ITEMS,
            moodLimit: config.FORYOU_MOOD_LIMIT,
            secondBecauseSection: config.FORYOU_SECOND_BECAUSE_SECTION,
            secondBecauseLimit: config.FORYOU_SECOND_BECAUSE_LIMIT,
        },
        // Player / Video Quality Settings
        annotations: {
            maxPins: config.ANNOTATIONS_MAX_PINS,
        },
        player: {
            nextEpisodePromptLeadSeconds: config.NEXT_EPISODE_PROMPT_LEAD_SECONDS,
            defaultQualityMode: config.PLAYER_DEFAULT_QUALITY_MODE,
            hlsVodBufferSettings: {
                maxBufferSize: config.PLAYER_HLS_JS_VOD_MAX_BUFFER_SIZE_BYTES,
                maxBufferLength: config.PLAYER_HLS_JS_VOD_MAX_BUFFER_LENGTH_SECONDS,
                maxMaxBufferLength: config.PLAYER_HLS_JS_VOD_MAX_MAX_BUFFER_LENGTH_SECONDS,
                backBufferLength: config.PLAYER_HLS_JS_VOD_BACK_BUFFER_LENGTH_SECONDS,
            },
            // Subtitle scaling
            subtitleSizeMultiplier: config.PLAYER_SUBTITLE_SIZE_MULTIPLIER,
            subtitlePgsScale: config.PLAYER_SUBTITLE_PGS_SCALE,
            subtitleSrtScale: config.PLAYER_SUBTITLE_SRT_SCALE,
            volumeCurve: config.PLAYER_VOLUME_CURVE,
        },
        // Browse Page Settings
        browse: {
            searchDebounceMs: config.BROWSE_SEARCH_DEBOUNCE_MS,
            azPageSize: config.BROWSE_AZ_PAGE_SIZE,
            keywordsInitial: config.BROWSE_KEYWORDS_INITIAL,
            keywordsPageSize: config.BROWSE_KEYWORDS_PAGE_SIZE,
            scrollMargin: config.BROWSE_SCROLL_MARGIN,
        },
        // Homepage Widget Settings
        homepage: {
            trendingLimit: config.HOMEPAGE_TRENDING_LIMIT,
            holidayLimit: config.HOMEPAGE_HOLIDAY_LIMIT,
            dndAnimationMs: config.HOMEPAGE_DND_ANIMATION_MS,
            searchDebounceMs: config.HOMEPAGE_SEARCH_DEBOUNCE_MS,
            // Admin-controlled widget configuration (from config service: ENV > JSON > Default)
            widgetOrder: getConfigValue<string[]>('HOMEPAGE_WIDGET_ORDER') ?? [],
            widgetVisibility:
                getConfigValue<Record<string, string>>('HOMEPAGE_WIDGET_VISIBILITY') ?? {},
        },
        // Trending Widget Settings (MDBList dropdown configuration)
        trending: {
            dropdownGroups: getConfigValue<{
                groups: Array<{ id: string; label: string; listIds: string[] }>;
                hiddenLists: string[];
            }>('TRENDING_DROPDOWN_GROUPS'),
            listNames: getConfigValue<Record<string, string>>('TRENDING_LIST_NAMES') ?? {},
        },
        // Sessions polling interval (client-side)
        sessions: {
            pollIntervalMs: config.SESSIONS_POLL_INTERVAL_MS,
            liveTvRefreshMs: config.LIVETV_REFRESH_INTERVAL_MS,
        },
        // Device auth settings (for OAuth device flow)
        deviceAuth: {
            pollIntervalSeconds: config.DEVICE_CODE_POLL_INTERVAL_SECONDS,
        },
        // Locale settings
        forceLocale: config.FORCE_LOCALE,
        // Service URLs (for admin debug panel) — gated to admin/arrManager only
        serviceUrls: localsIsAdminOrArrManager(locals)
            ? {
                  jellyfin: config.JELLYFINURL,
                  sonarr: config.SONARRURL,
                  radarr: config.RADARRURL,
                  jellyseerr: config.SEERRURL,
              }
            : undefined,
        // Episode display settings
        episodes: {
            progressBarThreshold: config.EPISODE_PROGRESS_BAR_THRESHOLD,
        },
        // Browser-side tuning knobs. This payload is `private, no-store`, so
        // every key here is re-serialized on every client-side navigation —
        // a key only earns its place once something reads it. Each of these
        // four is consumed through `$lib/stores/client-tuning`; the three
        // watch-together poll intervals, `ADMIN_TASKS_REFRESH_MS` and
        // `IMAGE_THUMB_MAX_WIDTH` that used to sit in this block described
        // behaviour that no longer exists (or never could be a knob) and were
        // retired from the schema rather than shipped again.
        clientTuning: {
            partiesRefreshMs: config.WATCH_PARTIES_REFRESH_MS,
            watchTogetherMaxReconnectMs: config.WATCH_TOGETHER_MAX_RECONNECT_MS,
            playlistChatPollMs: config.PLAYLIST_CHAT_POLL_MS,
            toastDefaultTimeoutMs: config.TOAST_DEFAULT_TIMEOUT_MS,
            playerSkipSeconds: config.PLAYER_SKIP_SECONDS,
            abrStabilityMs: config.PLAYER_QUALITY_STABILITY_MS,
            abrDownCooldownMs: config.PLAYER_QUALITY_DOWN_COOLDOWN_MS,
            abrUpCooldownMs: config.PLAYER_QUALITY_UP_COOLDOWN_MS,
            abrBandwidthSamples: config.PLAYER_BANDWIDTH_SAMPLES,
            abrMinSamplesBeforeSwitch: config.PLAYER_MIN_SAMPLES_BEFORE_SWITCH,
            abrMinAdaptiveBitrate: config.PLAYER_MIN_ADAPTIVE_BITRATE,
            requestAvailableExpireHours: config.REQUEST_AVAILABLE_EXPIRE_HOURS,
        },
        // Navigation config (from config service: ENV > JSON > Default)
        sidebarLinks: localizeItems(sidebarLinks, viewerLocale),
        sidebarSections: localizeItems(sidebarSections, viewerLocale),
        userMenuLinks: userMenuLinks.map((l) => ({
            ...l,
            label: userMenuLinkLabel(l, viewerLocale),
        })),
        footerLinks: localizeItems(footerLinks, viewerLocale),
        showFooter: getConfigValue<boolean>('SHOW_FOOTER') ?? false,
        heroButtons: heroButtons.map((b) => ({ ...b, label: heroButtonLabel(b, viewerLocale) })),
        // Resolved icon NAMEs -> IconSource for every icon this viewer's
        // navigation actually references — see resolve-nav-icons.ts. Sidebar,
        // UserMenuPopover and the homepage hero buttons look icons up here
        // FIRST, instead of importing the full admin nav icon catalog.
        navIcons,
        // Instance primary mode — content-mode axis ('vod' | 'music' | 'mixed').
        // Safe-by-default ('vod') for anonymous visitors; the value is stable per
        // restart so there is no auth-gating concern here.
        primaryMode: config.INSTANCE_PRIMARY_MODE,
        // Operation mode (Jellyfin availability, degradation state) — exposes
        // whether/which media server is wired up, an integration-presence signal.
        // Anonymous gets the all-false shape (keeps the ClientOperationMode
        // contract; no client on /login or /setup reads it).
        operationMode: (isAuthed
            ? {
                  jellyfinEnabled: operationMode.isJellyfinEnabled,
                  jellyfinAvailable: operationMode.isJellyfinAvailable,
                  canLiveTV: operationMode.canLiveTV,
                  isStandalone: operationMode.isStandalone,
              }
            : {
                  jellyfinEnabled: false,
                  jellyfinAvailable: false,
                  canLiveTV: false,
                  isStandalone: false,
              }) satisfies ClientOperationMode,
    };
};
