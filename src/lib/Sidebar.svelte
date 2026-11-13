<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { base } from '$app/paths';
    import { resolve } from '$lib/paths';
    import { onMount, onDestroy, untrack } from 'svelte';
    import type { ComponentType, SvelteComponent } from 'svelte';
    import type { IconSource } from 'svelte-hero-icons';
    import { goto, preloadData, afterNavigate } from '$app/navigation';
    import { SvelteSet } from 'svelte/reactivity';
    import { writable } from 'svelte/store';
    import { debounce } from '$lib/utils/debounce';
    import { dockLabels, toggleDockLabels } from '$lib/stores/dock.store';
    import { isMusicPlaylistRoute } from '$lib/utils/music-bottom-nav';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { SidebarLink, SidebarSection } from '../routes/+layout.server';
    // Track navbar scroll state for dock positioning
    let isNavbarScrolled = $state(false);
    import {
        Icon,
        Film,
        BookOpen,
        Cog6Tooth,
        Bars3,
        Bars3BottomLeft,
        XMark,
        ChevronLeft,
        ChevronRight,
        ChevronDown,
        ChevronUp,
        RectangleGroup,
        MusicalNote,
        QueueList,
        FolderOpen,
        Folder,
        VideoCamera,
        AcademicCap,
        Beaker,
        GlobeAlt,
        MagnifyingGlass,
        ArrowsRightLeft,
        Bell,
    } from 'svelte-hero-icons';
    import { LiveTvPlay, RadioTower } from '$lib/components/admin/navigation/lumastra-custom-icons';
    import { isRecord } from '$lib/utils/data-extraction';
    import * as m from '$lib/paraglide/messages';
    import { notificationInbox } from '$lib/stores/notification-inbox.js';
    import {
        openNotificationDrawer,
        notificationDrawerOpen,
    } from '$lib/stores/notification-drawer.js';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates.js';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    // The mobile dock trigger is `position: fixed; z-index: 2000`, i.e. above
    // every full-screen surface. It has always been gated on the music player
    // for that reason; the audiobook player needs the same gate or the trigger
    // sits on top of its Chapters button and swallows the tap. Measured in a
    // real browser, not inferred — `elementFromPoint` on the Chapters button
    // returned `.mobile-toggle`.
    import { audiobookFullScreenOpen } from '$lib/stores/audiobook-ui';
    import { hasModals } from '$lib/stores/modal.store';
    import { searchOverlayOpen } from '$lib/stores/search-overlay.store';
    import { Z } from '$lib/utils/z-index';
    import { getNavPins } from '$lib/api/nav-pins';
    import type { AdminNavPin } from '$lib/schemas/api-admin-nav-pins';

    interface NonEntertainmentLibrary {
        media_type: string;
        library_group_id: string;
        display_name: string | null;
        sidebar_visible: boolean;
        icon: string | null;
        sort_order: number;
    }

    interface Props {
        userGroups?: string[];
        adminGroups?: string[]; // Default admin group
        /**
         * Server-resolved effective admin verdict. This includes a local
         * `admin_pinned` override, which is deliberately allowed to differ
         * from ForwardAuth/IdP group membership.
         */
        /**
         * Server-resolved effective admin verdict, or `undefined` when the
         * caller has none. `false` is AUTHORITATIVE — see `isAdminUser`.
         */
        isAdmin?: boolean | undefined;
        isOpen?: boolean;
        customLinks?: SidebarLink[]; // From SIDEBAR_LINKS env var
        /**
         * Sidebar entries for plugin-owned pages, already access-filtered
         * server-side (the page load re-checks — this only decides what the
         * sidebar advertises).
         */
        pluginNavEntries?: {
            label: string;
            url: string;
            icon: string;
            section?: string;
            displayOrder?: number;
            key: string;
        }[];
        sections?: SidebarSection[]; // From SIDEBAR_SECTIONS env var
        nonEntertainmentLibraries?: NonEntertainmentLibrary[];
        activeLibraryTypes?: string[];
        /** Instance primary mode — controls music-first vs VOD-first nav layout. */
        primaryMode?: 'vod' | 'music' | 'mixed' | 'enterprise' | 'showcase';
        /** Whether Live TV is available (features.liveTV — flag enabled AND a
         *  standalone tuner source configured). Gates the VOD-nav "Live TV" entry;
         *  music-first mode's "Radio" pill is a separate, always-on /livetv link
         *  and is intentionally not gated by this (see the comment above it). */
        liveTV?: boolean;
        /** Whether the Music Alchemy mixing desk surface is enabled. */
        musicAlchemy?: boolean;
        /** Whether the Music Map feature is available (features.musicMap). */
        musicMap?: boolean;
        /** Whether Lyrics Search is available (features.lyricsSearch). */
        lyricsSearch?: boolean;
        /** Whether Sonic Embeddings are enabled (features.sonicEmbeddings) — gates Song Paths. */
        sonicEmbeddings?: boolean;
        /** Whether Sonic Collections (KMeans auto-playlists) are available (features.musicClusters). */
        musicClusters?: boolean;
        /** Whether Text-to-Sound Search is available (features.textToSound). */
        textToSound?: boolean;
        /** Whether the enterprise Training Assignments feature is enabled. */
        trainingAssignments?: boolean;
        /** Whether the enterprise Assessment (native quiz + certificate) feature is enabled. */
        assessment?: boolean;
    }

    let {
        userGroups = [],
        adminGroups = ['admin'],
        isAdmin = undefined,
        isOpen = $bindable(false),
        customLinks = [],
        pluginNavEntries = [],
        sections = [],
        nonEntertainmentLibraries = [],
        activeLibraryTypes = [],
        primaryMode = 'vod',
        liveTV = false,
        musicAlchemy = false,
        musicMap = false,
        lyricsSearch = false,
        sonicEmbeddings = false,
        musicClusters = false,
        textToSound = false,
        trainingAssignments = false,
        assessment = false,
    }: Props = $props();

    let activeLibSet = $derived(new Set(activeLibraryTypes));

    // Whether the current user is an admin. Prefer the server-resolved effective
    // verdict because a local `admin_pinned` override intentionally wins over
    // ForwardAuth/IdP group membership. Keep the group check as a compatibility
    // fallback for callers that have not supplied the verdict.
    // Drives the admin dock icon's quick-menu (pinned nav) flyout — never shown
    // to non-admins, even if a custom SIDEBAR_LINKS config exposes '/admin'
    // without a groups restriction.
    let isAdminUser = $derived.by(() => {
        // A supplied verdict wins OUTRIGHT, including `false`. It used to be
        // `if (isAdmin) return true;` followed by the group check, which meant a
        // server verdict of false fell through and the groups re-granted admin.
        // `admin_pinned` exists precisely to demote a member of an admin group
        // (`isAdmin = admin_pinned ? is_admin : oidcIsAdmin`), so such a user
        // kept the Admin dock icon and its pins flyout, then got redirected to
        // `/` by the admin layout's `locals.user.isAdmin` gate on click.
        if (isAdmin !== undefined) return isAdmin;
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        const adminGroupsLower = adminGroups.map((g) => g.toLowerCase());
        return userGroupsLower.some((group) => adminGroupsLower.includes(group));
    });

    interface MenuItem {
        label: string;
        url: string;
        icon: IconSource | string; // Can be either a svelte-hero-icons source or SVG path
        outline?: boolean; // True for outline-style icons
        external?: boolean;
        groups?: string[]; // Required groups to see this item
        section?: string; // Optional section ID to group this link under
        displayOrder?: number; // Position in navigation (interleaved with sections)
    }

    // A single entry in the interleaved navigation list, mirroring the editor's
    // unifiedNavItems: either a top-level link or a section with its child items.
    // `key` is a collision-proof identity used for the keyed-each blocks: the
    // MenuItem type has no id (SidebarLink/convertCustomLinks carry none), and two
    // configured links can legitimately share a url (e.g. two '/' buttons), so
    // url alone is unsafe as a key. We compose keys from the entry's original
    // index instead, which is unique and stable for a given config.
    type NavEntry =
        | { type: 'item'; order: number; key: string; item: MenuItem }
        | {
              type: 'section';
              order: number;
              key: string;
              section: SidebarSection;
              items: { item: MenuItem; key: string }[];
          };

    // Viewport-driven, set on mount and on resize (see the resize handler below).
    // Declared here because `labelsShown` reads it.
    let isMobile = $state(false);

    /**
     * Does the rail show item names?
     *
     * Mobile is always labelled: the rail there is an overlay drawer, so its
     * width costs the page nothing, and touch has no hover to fall back on —
     * which made the icon-only drawer the least legible surface in the app.
     *
     * On the server `isMobile` is false and the cookie decides, which is what
     * keeps the rail and the gutter `.main-content.with-dock-labels` renders
     * agreeing on the first paint.
     */
    let onAdminPage = $derived($page.url.pathname.startsWith(base ? `${base}/admin` : '/admin'));

    let labelsShown = $derived(
        isMobile || (!onAdminPage && (browser ? $dockLabels : $page.data?.dockMode !== 'icons')),
    );

    /**
     * One action-verb name for the labels toggle — deliberately NOT paired with
     * `aria-pressed`: a toggle whose name flips with its state announces as
     * "Hide labels, pressed", which leaves the listener unable to tell whether
     * the name describes the current state or the next action (ARIA APG).
     */
    let dockLabelsToggleLabel = $derived(labelsShown ? m.dock_collapse() : m.dock_expand());

    // Track collapsed state for each section
    let collapsedSections: Record<string, boolean> = $state({});

    // Initialize collapsed state from localStorage and section defaults
    function initCollapsedSections() {
        if (!browser) return;

        const saved = localStorage.getItem('sidebar-sections-collapsed');
        if (saved) {
            try {
                const parsed: unknown = JSON.parse(saved);
                if (isRecord(parsed)) {
                    collapsedSections = Object.fromEntries(
                        Object.entries(parsed).filter(([, value]) => typeof value === 'boolean'),
                    ) as Record<string, boolean>;
                } else {
                    collapsedSections = {};
                }
            } catch {
                /* expected: JSON.parse failure on corrupt localStorage section state */
                collapsedSections = {};
            }
        }

        // Apply defaults for sections not in saved state
        sections.forEach((section) => {
            if (collapsedSections[section.id] === undefined) {
                collapsedSections[section.id] = section.collapsed !== false; // Default to collapsed
            }
        });
    }

    function toggleSection(sectionId: string) {
        collapsedSections[sectionId] = !collapsedSections[sectionId];
        collapsedSections = collapsedSections; // Trigger reactivity

        if (browser) {
            localStorage.setItem('sidebar-sections-collapsed', JSON.stringify(collapsedSections));
        }
    }

    // Map icon names to Svelte Hero Icons.
    // Server-resolved icon names -> IconSource (only the names THIS viewer's
    // navigation actually references — see resolve-nav-icons.ts and
    // +layout.server.ts's `navIcons`), plus a couple of hard-coded,
    // non-configurable icons already imported above for the default menu's
    // direct-value usages. Reactive: `navIcons` can change across a
    // client-side layout re-load (e.g. after an admin edits nav config).
    let iconMap: Record<string, IconSource> = $derived({
        ...($page.data.navIcons ?? {}),
        'video-camera': VideoCamera,
        'academic-cap': AcademicCap,
    });

    // Check if icon is a custom path (local or external URL)
    function isCustomIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
    }

    // Convert custom links to menu items
    function convertCustomLinks(links: SidebarLink[]): MenuItem[] {
        return links.map((link) => {
            let iconValue: IconSource | string = Film;
            if (isCustomIconPath(link.icon)) {
                iconValue = link.icon as string;
            } else if (link.icon && iconMap[link.icon]) {
                iconValue = iconMap[link.icon];
            }
            return {
                label: link.label,
                url: link.url,
                icon: iconValue,
                outline: link.outline,
                external: link.external ?? true,
                groups: link.groups,
                section: link.section,
                displayOrder: link.displayOrder,
            };
        });
    }

    // Get icon for a section (handles IconSource type safely)
    function getSectionIcon(iconName: string | undefined): IconSource | string | null {
        if (!iconName) return null;
        if (isCustomIconPath(iconName)) return iconName;
        return iconMap[iconName] ?? null;
    }

    // Default menu items (used when no custom links are provided via SIDEBAR_LINKS)
    // These are minimal defaults - configure SIDEBAR_LINKS env var for external services
    // Library-specific items (Music, Audiobook) only show when that library type exists.
    // Audiobooks point at the purpose-built /audiobooks destination (shelf tabs,
    // language chips, series collapse), NOT the generic /library/{type} browser —
    // that one groups by media_type and has no notion of a derived series, so a
    // real library renders as hundreds of sibling "65 - …" cards.
    //
    // When primaryMode === 'music', the layout switches to music-first order:
    //   - Home → /music (music library root)
    //   - Playlists, Radio/Live TV, and (if musicAlchemy) Mixing Desk are shown to all
    //   - VOD entries (Browse, Live TV as primary, Audiobooks) are demoted and tagged
    //     groups: ['__ADMIN__'] so they remain visible to admins but hidden from
    //     regular users (admins always keep full nav per the CLAUDE.md contract).
    //
    // For enterprise mode ('enterprise'), libraries are shown to all; entertainment/discovery
    // surfaces (Browse, Music, Admin) are demoted to admins only.
    //
    // For all other modes ('vod', 'mixed') the existing order is preserved unchanged.
    let defaultMenuItems = $derived.by((): MenuItem[] => {
        if (primaryMode === 'enterprise') {
            // Home & Training: libraries + playlists for everyone;
            // entertainment/discovery demoted to admins (full nav per CLAUDE.md).
            const firstNonEnt = nonEntertainmentLibraries
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order)
                .find((l) => l.sidebar_visible);
            const enterpriseHomeUrl = firstNonEnt
                ? `/library/${firstNonEnt.media_type}`
                : '/library/home_video';
            const items: MenuItem[] = [
                {
                    label: m.nav_home(),
                    url: enterpriseHomeUrl,
                    icon: '/icons/home.svg',
                    outline: true,
                    external: false,
                },
                { label: m.nav_playlists(), url: '/playlists', icon: QueueList, external: false },
            ];
            // Training Assignments (enterprise feature).
            if (trainingAssignments) {
                items.push({
                    label: m.nav_my_trainings(),
                    url: '/my/trainings',
                    icon: AcademicCap,
                    external: false,
                });
            }
            // Assessment — native quiz + certificate (enterprise feature).
            if (assessment) {
                items.push({
                    label: m.nav_learn(),
                    url: '/learn',
                    icon: BookOpen,
                    external: false,
                });
            }
            // Entertainment surfaces kept for admins only.
            items.push({
                label: m.nav_browse(),
                url: '/browse',
                icon: RectangleGroup,
                outline: true,
                external: false,
                groups: ['__ADMIN__'],
            });
            if (activeLibSet.has('music')) {
                items.push({
                    label: m.nav_music(),
                    url: '/music',
                    icon: MusicalNote,
                    external: false,
                    groups: ['__ADMIN__'],
                });
            }
            items.push({
                label: m.nav_admin(),
                url: '/admin',
                icon: Cog6Tooth,
                external: false,
                groups: ['__ADMIN__'],
            });
            return items;
        }

        if (primaryMode === 'showcase') {
            // Showcase / Product Showcase: internal product library for authenticated staff;
            // public /showcase page linked for all authenticated users.
            // Entertainment/discovery surfaces demoted to admins only (same as enterprise).
            const firstProduct = nonEntertainmentLibraries
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order)
                .find((l) => l.sidebar_visible && l.media_type === 'product');
            const productUrl = firstProduct
                ? `/library/${firstProduct.media_type}`
                : '/library/product';
            const items: MenuItem[] = [
                {
                    label: m.nav_product_videos(),
                    url: productUrl,
                    icon: '/icons/home.svg',
                    outline: true,
                    external: false,
                },
                { label: m.nav_playlists(), url: '/playlists', icon: QueueList, external: false },
                // Public showcase page — visible to all authenticated users.
                {
                    label: m.nav_public_showcase(),
                    url: '/showcase',
                    icon: GlobeAlt,
                    outline: true,
                    external: false,
                },
            ];
            // Admin-only surfaces.
            items.push({
                label: m.nav_browse(),
                url: '/browse',
                icon: RectangleGroup,
                outline: true,
                external: false,
                groups: ['__ADMIN__'],
            });
            items.push({
                label: m.nav_admin(),
                url: '/admin',
                icon: Cog6Tooth,
                external: false,
                groups: ['__ADMIN__'],
            });
            return items;
        }

        if (primaryMode === 'music' && activeLibSet.has('music')) {
            // ── Music-first layout (only when a music library actually exists) ─
            const items: MenuItem[] = [
                // Home points to the music library in music-first mode.
                {
                    label: m.nav_home(),
                    url: '/music',
                    icon: '/icons/home.svg',
                    outline: true,
                    external: false,
                },
                {
                    label: m.nav_playlists(),
                    url: '/playlists',
                    icon: QueueList,
                    external: false,
                },
                {
                    label: m.nav_radio(),
                    url: '/livetv',
                    icon: RadioTower,
                    external: false,
                },
            ];

            // Mixing Desk — only when Music Alchemy is enabled
            if (musicAlchemy) {
                items.push({
                    label: m.nav_mixing_desk(),
                    url: '/music/alchemy',
                    icon: Beaker,
                    external: false,
                });
            }

            // Music Map — 2D audio-embedding starfield (features.musicMap)
            if (musicMap) {
                items.push({
                    label: m.nav_music_map(),
                    url: '/music/map',
                    icon: GlobeAlt,
                    external: false,
                });
            }

            // Lyrics Search — semantic lyrics kNN search (features.lyricsSearch)
            if (lyricsSearch) {
                items.push({
                    label: m.nav_lyrics_search(),
                    url: '/music/lyrics-search',
                    icon: MagnifyingGlass,
                    external: false,
                });
            }

            // Song Paths — sonic path between two tracks (features.sonicEmbeddings)
            if (sonicEmbeddings) {
                items.push({
                    label: m.nav_song_paths(),
                    url: '/music/path',
                    icon: ArrowsRightLeft,
                    external: false,
                });
            }

            // Sonic Collections — KMeans auto-playlists (features.musicClusters)
            if (musicClusters) {
                items.push({
                    label: m.nav_sonic_collections(),
                    url: '/music/collections',
                    icon: QueueList,
                    external: false,
                });
            }

            // Text-to-Sound Search — natural-language track search (features.textToSound)
            if (textToSound) {
                items.push({
                    label: m.nav_sound_search(),
                    url: '/music/text-search',
                    icon: MagnifyingGlass,
                    external: false,
                });
            }

            // VOD entries: visible to admins only so they keep full nav.
            // Live TV is intentionally omitted here because "Radio" above
            // already covers /livetv for all users — adding a second entry
            // for the same route would create visual clutter for admins.
            items.push({
                label: m.nav_browse(),
                url: '/browse',
                icon: RectangleGroup,
                outline: true,
                external: false,
                groups: ['__ADMIN__'],
            });

            if (activeLibSet.has('audiobook')) {
                items.push({
                    label: m.nav_audiobooks(),
                    url: '/audiobooks',
                    icon: BookOpen,
                    external: false,
                    groups: ['__ADMIN__'],
                });
            }

            // Admin link — always at the bottom, admin-only
            items.push({
                label: m.nav_admin(),
                url: '/admin',
                icon: Cog6Tooth,
                external: false,
                groups: ['__ADMIN__'],
            });

            return items;
        }

        // ── VOD-first / mixed layout (default) ───────────────────────────────
        const items: MenuItem[] = [
            {
                label: m.nav_home(),
                url: '/',
                icon: '/icons/home.svg',
                outline: true,
                external: false,
            },
            {
                label: m.nav_browse(),
                url: '/browse',
                icon: RectangleGroup,
                outline: true,
                external: false,
            },
        ];

        items.push({
            label: m.nav_music(),
            url: '/music',
            icon: MusicalNote,
            external: false,
        });

        // Only advertised once a standalone tuner source is actually
        // configured — an unconfigured Live TV led nowhere useful (S12/Polish).
        if (liveTV) {
            items.push({
                label: m.nav_livetv(),
                url: '/livetv',
                icon: LiveTvPlay,
                external: false,
            });
        }

        if (activeLibSet.has('audiobook')) {
            items.push({
                label: m.nav_audiobooks(),
                url: '/audiobooks',
                icon: BookOpen,
                external: false,
            });
        }

        // Music sub-feature deep-links (Mixing Desk, Music Map, Lyrics Search, Song
        // Paths, Sonic Collections, Sound Search) are intentionally NOT surfaced here —
        // they're music-first shortcuts (see the primaryMode === 'music' branch above).
        // In mixed mode (vod + music both selected) they'd clutter the dock; they're
        // still reachable from the /music page tiles/search.

        // Training Assignments (enterprise feature — shown when enabled in any mode).
        if (trainingAssignments) {
            items.push({
                label: m.nav_my_trainings(),
                url: '/my/trainings',
                icon: AcademicCap,
                external: false,
            });
        }

        // Assessment — native quiz + certificate (enterprise feature).
        if (assessment) {
            items.push({
                label: m.nav_learn(),
                url: '/learn',
                icon: BookOpen,
                external: false,
            });
        }

        items.push(
            {
                label: m.nav_playlists(),
                url: '/playlists',
                icon: QueueList,
                external: false,
            },
            {
                label: m.nav_admin(),
                url: '/admin',
                icon: Cog6Tooth,
                external: false,
                groups: ['__ADMIN__'],
            },
        );

        return items;
    });

    // Check if user has permission to see a section (sections can have groups too)
    function hasSectionPermission(section: SidebarSection): boolean {
        if (!section.groups || section.groups.length === 0) return true;

        // Case-insensitive group matching
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        const adminGroupsLower = adminGroups.map((g) => g.toLowerCase());

        // Check if section requires admin access
        if (section.groups.includes('__ADMIN__')) {
            return isAdminUser;
        }

        // Admin users can see everything
        if (isAdminUser) return true;

        // Check if user has any of the required groups
        const sectionGroupsLower = section.groups.map((g) => g.toLowerCase());
        return sectionGroupsLower.some((group) => userGroupsLower.includes(group));
    }

    // Get section config by ID (for icon lookup)
    function getSectionConfig(sectionId: string): SidebarSection | undefined {
        return sections.find((s) => s.id === sectionId);
    }

    /**
     * Hover unfurl: in icon mode the hovered item's name grows out of its own
     * icon, so a sweep down the rail reads as a wave rather than a series of
     * disconnected bubbles.
     *
     * Rendered flush against the icon's right edge (its viewport rect), in the
     * shell rather than the scroller — `.dock-content` clips horizontally, so a
     * child of it could not extend past the 70px rail. `pointer-events: none`
     * is deliberate: the pill covers page content, and the 48px icon stays the
     * only hit target, exactly as it was. The pill vanishes as the pointer
     * moves toward it, so it is never a target that looks clickable and is not.
     */
    let dockUnfurl = $state<{
        key: string;
        x: number;
        y: number;
        height: number;
        label: string;
        active: boolean;
    } | null>(null);

    function showUnfurl(trigger: EventTarget | null, key: string, label: string, active: boolean) {
        // Labels already on screen, or no real pointer to hover with.
        if (labelsShown || !label) return;
        if (browser && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        if (!(trigger instanceof HTMLElement)) return;
        const rect = trigger.getBoundingClientRect();
        dockUnfurl = { key, x: rect.right, y: rect.top, height: rect.height, label, active };
    }

    function hideUnfurl() {
        dockUnfurl = null;
    }

    // ── Dock flyouts ──────────────────────────────────────────────────────
    // One panel mechanism, two users:
    //   'pins'    — the Admin icon's quick-menu of instance-wide pinned nav
    //               (GET /api/admin/nav-pins, admin-gated). The dock renders
    //               app-wide, outside /admin, so it cannot read the admin
    //               layout's load data; it lazy-fetches once on first
    //               hover/focus and caches for the session.
    //   'section' — a sidebar section while the rail is in icon mode. Expanding
    //               a section in place there just reveals MORE unlabelled
    //               icons: an unlabelled folder hiding unlabelled files. The
    //               labels exist in the config the whole time, so the section
    //               opens a labelled panel instead. In labelled mode the header
    //               keeps its original inline expand/collapse.
    //
    // One state, so opening either closes the other by construction. Desktop
    // only: a tap on touch should navigate (pins) or toggle (sections), and the
    // panel is display:none under `(hover: none)` anyway.
    const DOCK_FLYOUT_OPEN_DELAY_MS = 150;
    const DOCK_FLYOUT_CLOSE_GRACE_MS = 200;

    type DockFlyoutTarget = { kind: 'pins' } | { kind: 'section'; id: string };

    /** `y` is the trigger's viewport centre — the panel is fixed-positioned. */
    let dockFlyout = $state<{ target: DockFlyoutTarget; y: number } | null>(null);
    let dockFlyoutEl = $state<HTMLElement | null>(null);

    function sameTarget(a: DockFlyoutTarget, b: DockFlyoutTarget): boolean {
        if (a.kind === 'pins' || b.kind === 'pins') return a.kind === b.kind;
        return a.id === b.id;
    }

    function isFlyoutOpen(target: DockFlyoutTarget): boolean {
        return dockFlyout !== null && sameTarget(dockFlyout.target, target);
    }

    /** Section whose children the open panel lists, if that is what is open. */
    let flyoutSection = $derived.by(() => {
        if (dockFlyout?.target.kind !== 'section') return null;
        const id = dockFlyout.target.id;
        const entry = navEntries.find((e) => e.type === 'section' && e.section.id === id);
        return entry && entry.type === 'section' ? entry : null;
    });

    // null = not yet fetched (or in flight); [] = fetched, no pins pinned.
    let navPins = $state<AdminNavPin[] | null>(null);
    let navPinsFetchPromise: Promise<void> | null = null;
    let dockFlyoutOpenTimer: ReturnType<typeof setTimeout> | null = null;
    let dockFlyoutCloseTimer: ReturnType<typeof setTimeout> | null = null;

    function clearDockFlyoutOpenTimer() {
        if (dockFlyoutOpenTimer !== null) {
            clearTimeout(dockFlyoutOpenTimer);
            dockFlyoutOpenTimer = null;
        }
    }

    function clearDockFlyoutCloseTimer() {
        if (dockFlyoutCloseTimer !== null) {
            clearTimeout(dockFlyoutCloseTimer);
            dockFlyoutCloseTimer = null;
        }
    }

    /**
     * Fetch the pin list, on every open rather than once per session.
     *
     * It used to fetch once and keep the result forever: pin a page, and this
     * menu went on saying "nothing pinned yet" until a full reload. The pin
     * button calls `invalidateAll()` and its comment claims that refreshes
     * navPins "everywhere", but invalidation re-runs LOAD functions — and the
     * dock's copy is a client-side fetch in this component, not load data. The
     * admin sidebar's copy refreshed; the dock's did not.
     *
     * Deduped by the in-flight promise, and only ever called when the flyout
     * opens, so this still costs nothing on a page load. The previous list stays
     * on screen while the new one is in flight (and survives a failed refresh).
     */
    function refreshNavPins(): void {
        if (navPinsFetchPromise) return;
        navPinsFetchPromise = (async () => {
            try {
                const result = await getNavPins();
                navPins = result.data?.pins ?? [];
            } catch {
                // Best-effort — an empty list renders the "no pins" hint rather
                // than breaking the dock. `??=` keeps a previously loaded list
                // rather than blanking it on a transient failure.
                navPins ??= [];
            } finally {
                // Cleared, unlike before: the stale promise blocked every
                // subsequent fetch, which is the other half of why this never
                // updated.
                navPinsFetchPromise = null;
            }
        })();
    }

    /** Viewport centre of the trigger, which is what the panel is pinned to. */
    function triggerCentreY(trigger: EventTarget | null): number | null {
        if (!(trigger instanceof HTMLElement)) return null;
        const rect = trigger.getBoundingClientRect();
        return rect.top + rect.height / 2;
    }

    /** Hover: open after a short delay so a quick mouse pass-over doesn't flash it. */
    function openDockFlyoutDelayed(target: DockFlyoutTarget, trigger: EventTarget | null) {
        if (isMobile) return;
        hideUnfurl();
        const y = triggerCentreY(trigger);
        if (y === null) return;
        clearDockFlyoutCloseTimer();
        if (target.kind === 'pins') refreshNavPins();
        if (isFlyoutOpen(target)) return;
        clearDockFlyoutOpenTimer();
        dockFlyoutOpenTimer = setTimeout(() => {
            dockFlyout = { target, y };
            dockFlyoutOpenTimer = null;
        }, DOCK_FLYOUT_OPEN_DELAY_MS);
    }

    /** Keyboard focus or click: open at once — a discrete act, not a pass-through. */
    function openDockFlyoutNow(target: DockFlyoutTarget, trigger: EventTarget | null) {
        if (isMobile) return;
        hideUnfurl();
        const y = triggerCentreY(trigger);
        if (y === null) return;
        clearDockFlyoutOpenTimer();
        clearDockFlyoutCloseTimer();
        if (target.kind === 'pins') refreshNavPins();
        dockFlyout = { target, y };
    }

    /** Mouse leaving the trigger or the panel: cancel a pending open, else close with grace. */
    function handleDockFlyoutMouseLeave() {
        clearDockFlyoutOpenTimer();
        if (dockFlyout === null) return;
        clearDockFlyoutCloseTimer();
        dockFlyoutCloseTimer = setTimeout(() => {
            dockFlyout = null;
            dockFlyoutCloseTimer = null;
        }, DOCK_FLYOUT_CLOSE_GRACE_MS);
    }

    /** Focus leaving trigger+panel (Tab out) — close unless it moved within either. */
    function handleDockFlyoutFocusOut(event: FocusEvent) {
        const next = event.relatedTarget as Node | null;
        const container = event.currentTarget as HTMLElement;
        if (next && container.contains(next)) return;
        // The panel is not a descendant of the trigger (it must sit outside the
        // dock's scroll container), so tabbing into it reads as focus leaving.
        if (next instanceof Node && dockFlyoutEl?.contains(next)) return;
        closeDockFlyoutNow();
    }

    function handleDockFlyoutKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || dockFlyout === null) return;
        event.stopPropagation();
        closeDockFlyoutNow();
        (event.currentTarget as HTMLElement).querySelector('button')?.focus();
    }

    function closeDockFlyoutNow() {
        clearDockFlyoutOpenTimer();
        clearDockFlyoutCloseTimer();
        dockFlyout = null;
    }

    onDestroy(() => {
        clearDockFlyoutOpenTimer();
        clearDockFlyoutCloseTimer();
    });

    // Re-clamp after navigation (a route change can add/remove the bottom nav)
    // and whenever the MiniPlayer appears/disappears (changes reserved height).
    afterNavigate(() => reclampTriggerPos());
    $effect(() => {
        void $musicPlayerStore.currentTrack; // track presence toggles .mini-player
        // untrack: reclampTriggerPos() both reads and writes triggerPos. Without this,
        // the effect would track its own write as a dependency and re-run forever
        // (effect_update_depth_exceeded) for any user with a saved toggle position.
        untrack(() => reclampTriggerPos());
    });

    // NOTE: the dock used to carry a second, localStorage-backed "collapsed"
    // state on top of the visibility preference. It slid the rail off-screen
    // with a transform while `.main-content` kept its 70px gutter, so "Hide
    // dock" left a dead strip and a 10px sliver — and it broadcast a
    // `sidebar-toggle` window event that /app/[url] listened to in order to add
    // a SECOND gutter of its own. All of it is gone: `dockMode` in
    // $lib/stores/dock.store is the one preference, 'hidden' really hides.

    onMount(() => {
        if (browser) {
            // Initialize section collapsed states
            initCollapsedSections();

            // Restore the persisted (and re-clamped) mobile toggle position
            loadTriggerPos();

            const checkMobile = () => {
                isMobile = window.innerWidth < 768; // md breakpoint
                viewportWidth = window.innerWidth;
                reclampTriggerPos();
            };
            checkMobile();
            const debouncedCheckMobile = debounce(checkMobile, 150);
            // resize (not orientationchange) is used for re-clamping: on iOS
            // orientationchange fires before innerWidth/innerHeight update, so it
            // would clamp against stale dimensions. resize fires afterwards with
            // the correct viewport.
            window.addEventListener('resize', debouncedCheckMobile);

            // Track navbar scroll state for dock positioning
            const updateNavbarState = () => {
                const navbar = document.getElementById('main-navbar');
                if (navbar) {
                    isNavbarScrolled = navbar.classList.contains('scrolled');
                }
            };

            // Use MutationObserver to watch for class changes on navbar
            const navbar = document.getElementById('main-navbar');
            let observer: MutationObserver | null = null;
            if (navbar) {
                observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.attributeName === 'class') {
                            updateNavbarState();
                        }
                    });
                });
                observer.observe(navbar, { attributes: true });
                updateNavbarState(); // Initial check
            }

            return () => {
                window.removeEventListener('resize', debouncedCheckMobile);
                if (observer) observer.disconnect();
            };
        }
    });

    function hasPermission(item: MenuItem): boolean {
        if (!item.groups || item.groups.length === 0) return true;

        // Case-insensitive group matching
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        const adminGroupsLower = adminGroups.map((g) => g.toLowerCase());

        // Check if item requires admin access
        if (item.groups.includes('__ADMIN__')) {
            return isAdminUser;
        }

        // Admin users can see everything
        if (isAdminUser) return true;

        // Check if user has any of the required groups
        const itemGroupsLower = item.groups.map((g) => g.toLowerCase());
        return itemGroupsLower.some((group) => userGroupsLower.includes(group));
    }

    function isActive(item: MenuItem, pathname: string, params: Record<string, string>): boolean {
        // Account for base path in subfolder deployments
        const basePath = base || '';
        const musicPlaylistContext = isMusicPlaylistRoute(
            $page.route?.id ?? null,
            $page.url.searchParams,
            $page.data?.playlist?.playlistType,
        );

        // For internal routes (non-external items)
        if (!item.external) {
            if (musicPlaylistContext && item.url === '/music') return true;
            if (musicPlaylistContext && item.url === '/playlists') return false;
            // Exact match for root-level routes, or startsWith for nested routes
            if (item.url === '/') {
                return pathname === (basePath || '/');
            }
            // For other routes, check exact match or if it's a sub-path
            // Item URLs are relative to base, so prepend base for comparison
            const fullItemUrl = basePath + item.url;
            return pathname === fullItemUrl || pathname.startsWith(fullItemUrl + '/');
        }

        // For external services (iframe pages)
        const appPath = basePath ? `${basePath}/app/` : '/app/';
        if (item.external && pathname.startsWith(appPath)) {
            const encodedUrl = params.url;
            if (encodedUrl) {
                try {
                    const decodedUrl = decodeURIComponent(encodedUrl);
                    return decodedUrl === item.url;
                } catch {
                    /* expected: decodeURIComponent may fail on malformed URL encoding */
                    return false;
                }
            }
        }

        return false;
    }

    /** The SvelteKit href a nav item routes to (internal route or the iframe wrapper). */
    function navHref(item: MenuItem): string {
        return item.external ? resolve(`/app/${encodeURIComponent(item.url)}`) : resolve(item.url);
    }

    // Preload a nav target's load (server + client) on hover/focus so the actual
    // click navigates instantly. The sidebar uses button+goto (not <a href>), so
    // SvelteKit's automatic `data-sveltekit-preload-data` can't see these links —
    // we drive preloadData() manually. Deduped per href; preloadData itself caches
    // the result, so a subsequent goto() reuses it. Best-effort (never throws).
    const navPreloaded = new SvelteSet<string>();
    function preloadNav(item: MenuItem): void {
        const href = navHref(item);
        if (navPreloaded.has(href)) return;
        navPreloaded.add(href);
        void preloadData(href).catch(() => navPreloaded.delete(href));
    }

    function handleNavigation(item: MenuItem) {
        // Navigate to the iframe view for external services, else the internal route.
        goto(navHref(item));

        // Close sidebar on mobile after navigation
        if (isMobile) {
            isOpen = false;
        }
    }

    function toggleSidebar() {
        isOpen = !isOpen;
    }

    function closeSidebar() {
        isOpen = false;
    }

    // ── Notifications (mobile) ─────────────────────────────────────────────
    // On mobile the dock owns the notification entry point; NotificationBell
    // hides itself under 768px. See docs/architecture/user-events.md.
    const unreadNotifications = $derived($notificationInbox.unreadCount);

    // The trigger's label carries the count so a screen reader gets the same
    // information the badge conveys visually — the badge itself is aria-hidden.
    const triggerAriaLabel = $derived(
        unreadNotifications > 0 && !isOpen
            ? `${m.admin_sidebar_toggle_aria()} — ${unreadNotifications}`
            : m.admin_sidebar_toggle_aria(),
    );

    function openNotificationsFromDock(): void {
        // Close the dock first: the drawer is a modal with its own focus trap,
        // and leaving the dock open behind it would leave two overlapping
        // dismissable surfaces racing for the same Escape key.
        closeSidebar();
        openNotificationDrawer();
    }

    // Close sidebar when clicking outside on mobile
    function handleBackdropClick() {
        if (isMobile) {
            closeSidebar();
        }
    }

    // ── Draggable mobile toggle ────────────────────────────────────────────
    // The mobile toggle defaults to the top-right corner but can be dragged to
    // either screen edge. The chosen position persists in localStorage and is
    // re-clamped into the viewport on load/resize so it can never strand
    // off-screen (e.g. after a rotation or on a smaller device).
    type DockTriggerPos = { side: 'left' | 'right'; top: number };
    const DOCK_TRIGGER_STORAGE_KEY = 'dock-trigger-position';
    const TRIGGER_SIZE = 40; // matches .mobile-toggle width/height
    const TRIGGER_MARGIN = 16; // 1rem edge inset
    const DRAG_THRESHOLD = 10; // px before a press becomes a drag (vs a tap)

    let triggerPos = $state<DockTriggerPos | null>(null);
    let isDraggingTrigger = $state(false);
    let liveDragStyle = $state('');
    let viewportWidth = $state(0); // tracked so the resting style can be left-based
    // Hidden probe element used to resolve --music-bottom-stack (see
    // bottomStackReservedPx below) into a real pixel value.
    let bottomStackProbeEl: HTMLDivElement | null = $state(null);
    // Non-reactive drag bookkeeping
    let dragPointerId: number | null = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragMoved = false;
    let dragLeft = 0;
    let dragTop = 0;
    let suppressClick = false; // swallow the click synthesized after a real drag
    // Top-bounds snapshot taken once at drag start (see onTriggerPointerDown) so
    // onTriggerPointerMove never forces a style/layout read on every pointermove.
    let dragTopBounds: { minTop: number; maxTop: number } | null = null;

    // Resolved inline position when not actively dragging (CSS transition gives
    // the snap-to-edge spring on release). Defaults to top-right when unset.
    // Both the live-drag style and this one are `left`-based so the snap can
    // animate (CSS cannot interpolate a left↔right swap).
    let triggerStyle = $derived.by(() => {
        const pos = triggerPos;
        if (!pos) return 'top: 1rem; right: 1rem;';
        const left =
            pos.side === 'left'
                ? TRIGGER_MARGIN
                : Math.max(viewportWidth - TRIGGER_SIZE - TRIGGER_MARGIN, TRIGGER_MARGIN);
        return `top: ${pos.top}px; left: ${left}px;`;
    });

    // Pixels of bottom chrome to keep clear of the draggable toggle: the mobile
    // music bottom nav + MiniPlayer stack, already composed into
    // --music-bottom-stack on .app-layout (src/routes/+layout.svelte) — 0 at
    // lg+ and off music routes, so this is a single source of truth rather
    // than a duplicate DOM-measurement of the nav/MiniPlayer elements here.
    // CSS custom properties holding calc() expressions are NOT numerically
    // resolved by getComputedStyle().getPropertyValue() (only real box-model
    // properties are), so bottomStackProbeEl exists purely to let the browser
    // resolve the var into a pixel height we can read via
    // getBoundingClientRect().
    function bottomStackReservedPx(): number {
        if (!browser || !bottomStackProbeEl) return 0;
        return bottomStackProbeEl.getBoundingClientRect().height;
    }

    function triggerTopBounds(): { minTop: number; maxTop: number } {
        const minTop = TRIGGER_MARGIN;
        const maxTop = window.innerHeight - TRIGGER_SIZE - TRIGGER_MARGIN - bottomStackReservedPx();
        return { minTop, maxTop };
    }

    function clampTriggerPos(pos: DockTriggerPos): DockTriggerPos | null {
        const { minTop, maxTop } = triggerTopBounds();
        // Viewport too short to place the button safely → fall back to default.
        if (maxTop < minTop) return null;
        const top = Math.min(Math.max(pos.top, minTop), maxTop);
        // Reference-stable when unchanged: prevents redundant downstream churn
        // (e.g. re-triggering effects that watch `triggerPos` by reference).
        if (top === pos.top) return pos;
        return { side: pos.side, top };
    }

    function loadTriggerPos() {
        if (!browser) return;
        try {
            const stored = localStorage.getItem(DOCK_TRIGGER_STORAGE_KEY);
            if (!stored) {
                triggerPos = null;
                return;
            }
            const parsed: unknown = JSON.parse(stored);
            if (
                isRecord(parsed) &&
                (parsed.side === 'left' || parsed.side === 'right') &&
                typeof parsed.top === 'number' &&
                Number.isFinite(parsed.top)
            ) {
                triggerPos = clampTriggerPos({ side: parsed.side, top: parsed.top });
            } else {
                triggerPos = null;
            }
        } catch {
            /* expected: JSON.parse failure on corrupt localStorage value */
            triggerPos = null;
        }
    }

    function persistTriggerPos() {
        if (!browser || !triggerPos) return;
        try {
            localStorage.setItem(DOCK_TRIGGER_STORAGE_KEY, JSON.stringify(triggerPos));
        } catch (error) {
            console.error('[Sidebar] Failed to persist dock trigger position:', error);
        }
    }

    // Re-clamp on viewport changes so a saved position can't end up off-screen.
    function reclampTriggerPos() {
        if (triggerPos) triggerPos = clampTriggerPos(triggerPos);
    }

    function onTriggerPointerDown(event: PointerEvent) {
        // Ignore secondary pointers while a drag is already in progress so a
        // second finger can't hijack the active drag.
        if (dragPointerId !== null) return;
        suppressClick = false;
        const target = event.currentTarget as HTMLElement;
        dragPointerId = event.pointerId;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragMoved = false;
        const rect = target.getBoundingClientRect();
        dragLeft = rect.left;
        dragTop = rect.top;
        // Snapshot the clamp bounds once per drag (forces one style/layout
        // read here) so onTriggerPointerMove — which fires on every
        // pointermove — never triggers a forced reflow. Geometry changes
        // mid-drag (rotation, MiniPlayer appearing) are covered by the
        // resize/afterNavigate/player-visibility reclamp triggers instead.
        dragTopBounds = triggerTopBounds();
        target.setPointerCapture?.(event.pointerId);
    }

    function onTriggerPointerMove(event: PointerEvent) {
        if (dragPointerId === null || event.pointerId !== dragPointerId) return;
        const dx = event.clientX - dragStartX;
        const dy = event.clientY - dragStartY;
        if (!dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragMoved = true;
        isDraggingTrigger = true;
        const { minTop, maxTop } = dragTopBounds ?? triggerTopBounds();
        const maxLeft = window.innerWidth - TRIGGER_SIZE - TRIGGER_MARGIN;
        dragLeft = Math.min(
            Math.max(dragLeft + dx, TRIGGER_MARGIN),
            Math.max(maxLeft, TRIGGER_MARGIN),
        );
        dragTop = Math.min(Math.max(dragTop + dy, minTop), Math.max(maxTop, minTop));
        // Reset start so deltas are incremental and follow the finger 1:1.
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        liveDragStyle = `top: ${dragTop}px; left: ${dragLeft}px; right: auto; transition: none;`;
    }

    function endTriggerDrag(event: PointerEvent) {
        if (dragPointerId === null || event.pointerId !== dragPointerId) return;
        const target = event.currentTarget as HTMLElement;
        target.releasePointerCapture?.(event.pointerId);
        dragPointerId = null;
        dragTopBounds = null;
        const wasDrag = dragMoved;
        isDraggingTrigger = false;
        liveDragStyle = '';
        // A press without movement is a tap; activation is handled by the native
        // click event (so keyboard, screen readers and Voice Control all work).
        if (!wasDrag) return;
        // Swallow the click the browser synthesizes after this drag's pointerup.
        suppressClick = true;
        // Snap horizontally to whichever edge the button's center is nearest.
        triggerPos = clampTriggerPos({
            side: dragLeft + TRIGGER_SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right',
            top: dragTop,
        });
        persistTriggerPos();
    }

    function cancelTriggerDrag(event: PointerEvent) {
        if (event.pointerId !== dragPointerId) return;
        dragPointerId = null;
        dragTopBounds = null;
        dragMoved = false;
        isDraggingTrigger = false;
        liveDragStyle = '';
    }

    function onTriggerClick() {
        // Ignore the click that trails a drag; otherwise toggle the dock. This
        // is the activation path for taps, mouse, keyboard (Enter/Space) and
        // assistive tech, all of which dispatch a native click.
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        toggleSidebar();
    }
    // Reactive helper - returns true if section is collapsed
    // Using a reactive approach by referencing collapsedSections directly
    let getCollapsedState = $derived((sectionId: string) => collapsedSections[sectionId] ?? true);
    // Convert non-entertainment libraries to menu items (filtered by sidebar_visible, sorted by sort_order)
    function convertNonEntertainmentLibraries(libs: NonEntertainmentLibrary[]): MenuItem[] {
        return libs
            .filter((lib) => lib.sidebar_visible)
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((lib) => {
                const template = getLibraryTypeTemplate(lib.media_type);
                const iconName = lib.icon ?? template?.icon ?? 'folder';
                let iconValue: IconSource | string = iconMap[iconName] ?? Folder;
                return {
                    label: lib.display_name ?? template?.label ?? lib.media_type,
                    url: `/library/${lib.media_type}`,
                    icon: iconValue,
                    external: false,
                };
            });
    }

    // Use custom links if provided, otherwise fall back to defaults
    // Inject non-entertainment library entries before Admin
    let menuItems = $derived.by(() => {
        const base = customLinks.length > 0 ? convertCustomLinks(customLinks) : defaultMenuItems;
        if (nonEntertainmentLibraries.length === 0) return base;

        const libItems = convertNonEntertainmentLibraries(nonEntertainmentLibraries);
        // Insert before the last item (Admin) in default layout
        const adminIdx = base.findIndex((item) => item.url === '/admin');
        if (adminIdx >= 0) {
            return [...base.slice(0, adminIdx), ...libItems, ...base.slice(adminIdx)];
        }
        return [...base, ...libItems];
    });

    // Plugin pages join the same ordering space as everything else. No `groups`
    // is set on them: the server already filtered this list for this viewer, and
    // re-deriving permission here from a different source could only disagree
    // with the page load that actually enforces it.
    let menuItemsWithPlugins = $derived(
        pluginNavEntries.length === 0
            ? menuItems
            : [
                  ...menuItems,
                  ...pluginNavEntries.map((e) => ({
                      label: e.label,
                      url: e.url,
                      icon: e.icon,
                      ...(e.section ? { section: e.section } : {}),
                      ...(e.displayOrder !== undefined ? { displayOrder: e.displayOrder } : {}),
                  })),
              ],
    );
    // Build a single displayOrder-sorted, interleaved navigation list that mirrors
    // the editor's unifiedNavItems: top-level links and sections share one ordering
    // space (#13). Previously all top-level links rendered before all sections,
    // ignoring displayOrder entirely. Within-group order is preserved: items/sections
    // without a displayOrder fall back to their original position (appended after any
    // ordered entries), and a section's child links keep their menuItems order.
    let navEntries = $derived.by((): NavEntry[] => {
        // Top-level links the user may see, keeping original index for fallback order.
        const topLevel = menuItemsWithPlugins
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => !item.section && hasPermission(item));

        // Sections the user may see, with their permitted child items, dropping empties.
        // Child items carry their original index so the inner keyed-each can compose a
        // collision-proof key (two children may share a url, e.g. duplicate '/' links).
        const sectionGroups = sections
            .filter((section) => hasSectionPermission(section))
            .map((section, index) => ({
                section,
                index,
                items: menuItemsWithPlugins
                    .filter((item) => item.section === section.id && hasPermission(item))
                    .map((item, itemIndex) => ({ item, itemIndex })),
            }))
            .filter((group) => group.items.length > 0);

        // Fallback base so entries without an explicit displayOrder sort after any
        // ordered entries while preserving their relative original order.
        const explicitOrders = [
            ...topLevel.map(({ item }) => item.displayOrder),
            ...sectionGroups.map(({ section }) => section.displayOrder),
        ].filter((order): order is number => typeof order === 'number');
        const fallbackBase = (explicitOrders.length > 0 ? Math.max(...explicitOrders) : 0) + 1;

        const entries: NavEntry[] = [
            ...topLevel.map(({ item, index }): NavEntry => ({
                type: 'item',
                order: item.displayOrder ?? fallbackBase + index,
                // Index-composed key: unique even when two links share a url.
                key: `item-${index}`,
                item,
            })),
            ...sectionGroups.map(({ section, index, items }): NavEntry => ({
                type: 'section',
                // +1000 keeps unordered sections after unordered links, matching
                // the editor's "sections drift to the end when unordered" behavior.
                order: section.displayOrder ?? fallbackBase + 1000 + index,
                // Section id is unique by contract; prefix to avoid clashing with
                // top-level item keys in the shared keyed-each.
                key: `section-${section.id}`,
                section,
                // Each child keyed by its original index within the section, so
                // duplicate child urls can't collide.
                items: items.map(({ item, itemIndex }) => ({
                    item,
                    key: `${section.id}-${itemIndex}`,
                })),
            })),
        ];

        // Stable sort by order (Array.prototype.sort is stable in modern engines),
        // so equal orders keep the link-before-section, original-index ordering above.
        return entries.sort((a, b) => a.order - b.order);
    });
    // Reactive pathname for active state detection
    let currentPathname = $derived($page.url.pathname);
    let currentParams = $derived($page.params);
    // The settings screen is a full-screen route overlay (not a modal), so it
    // isn't caught by $hasModals. Hide the floating toggle while it owns the
    // top-right corner to avoid clashing with the settings close button.
    let isSettingsOverlay = $derived(
        currentPathname === `${base}/settings` || currentPathname.startsWith(`${base}/settings/`),
    );
</script>

<!-- Invisible probe: resolves --music-bottom-stack (published on .app-layout in
     src/routes/+layout.svelte — nav bar + MiniPlayer, 0 at lg+/off music
     routes) into a real pixel height via getBoundingClientRect(), see
     bottomStackReservedPx(). Rendered unconditionally so it's always
     available to reclampTriggerPos(). -->
<div bind:this={bottomStackProbeEl} class="bottom-stack-probe" aria-hidden="true"></div>

<!-- Mobile Toggle Button — hidden whenever a full-screen surface owns the screen
     (music player, modals, or the settings route overlay). Draggable to either
     edge; tap toggles the dock. -->
<!-- `!$notificationDrawerOpen` joins the existing full-screen-surface guards:
     the trigger is z-index 2000 (Z.TOOLTIP), ABOVE the drawer's Z.MODAL, so
     while the drawer is open it floated over the header and clipped "Mark all
     as read". The drawer is a dismissable surface that owns the screen, exactly
     like the cases already listed here. The Search overlay is one too: its
     close button sits in the same top-right corner the trigger defaults to. -->
{#if isMobile && !$musicPlayerStore.isFullScreen && !$audiobookFullScreenOpen && !$hasModals && !isSettingsOverlay && !$notificationDrawerOpen && !$searchOverlayOpen}
    <button
        class="mobile-toggle"
        class:dragging={isDraggingTrigger}
        style={isDraggingTrigger ? liveDragStyle : triggerStyle}
        onpointerdown={onTriggerPointerDown}
        onpointermove={onTriggerPointerMove}
        onpointerup={endTriggerDrag}
        onpointercancel={cancelTriggerDrag}
        onclick={onTriggerClick}
        aria-label={triggerAriaLabel}>
        <Icon src={isOpen ? XMark : Bars3} class="h-4 w-4" />
        <!-- Unread notifications ride the trigger on mobile: it is the ONE
             floating control here and the user has already placed it where it
             does not obstruct anything. Adding a second fixed overlay for the
             bell put two circles in one corner, only one of them movable.
             Hidden while the dock is open — the dock's own Notifications entry
             carries the count then, and a badge on an X button reads as "close
             has 3 of something". -->
        {#if unreadNotifications > 0 && !isOpen}
            <span class="trigger-badge" aria-hidden="true">
                {unreadNotifications > 9 ? '9+' : unreadNotifications}
            </span>
        {/if}
    </button>
{/if}

<!-- Backdrop for mobile -->
{#if isMobile && isOpen}
    <div
        class="fixed inset-0 bg-black/50 z-40"
        onclick={handleBackdropClick}
        onkeydown={(e) => e.key === 'Escape' && closeSidebar()}
        role="button"
        tabindex="-1">
    </div>
{/if}

<!-- The dock is a fixed, NON-scrolling shell; `.dock-content` inside it is the
     only scroll container. That split is load-bearing: when the shell itself
     scrolled, its authored `overflow-x: visible` computed to `auto` beside
     `overflow-y: auto`, and every overlay a child tried to paint past x=70 was
     clipped away — which is what silently deleted the hover tooltip, the admin
     pins flyout and the active-item indicator, all three measured invisible in
     a real browser. Overlays now either portal out (Tooltip `fixed`) or sit
     outside the scroller. -->
<aside
    class="icon-dock {isOpen ? 'open' : ''} {isMobile ? 'mobile' : 'desktop'} {isNavbarScrolled
        ? 'navbar-scrolled'
        : ''} {labelsShown ? 'labeled' : ''}">
    <div class="dock-content" onscroll={hideUnfurl}>
        <!-- Centered Navigation Icons — top-level links and sections share a
                     single displayOrder-sorted list (navEntries) so the rendered order
                     matches the navigation editor (#13). -->
        <nav class="dock-segment">
            <!-- Notifications (mobile only). Deliberately NOT a navEntry:
                         navEntries are URL-driven (entry.item.url →
                         handleNavigation) and this opens a drawer, so a
                         synthetic entry would have to fake an href.

                         FIRST, not last. `.dock-content` scrolls (measured:
                         870px of content in a 714px box on an install with 12
                         nav entries), so at the tail this landed ~80px below the
                         fold — you'd have to scroll a nav list to reach the
                         thing the badge just told you about. The badge is an
                         attention cue; what it points at has to be on screen
                         the moment the dock opens. -->
            {#if isMobile}
                <button
                    class="dock-notifications"
                    onclick={openNotificationsFromDock}
                    aria-haspopup="dialog"
                    aria-label={unreadNotifications > 0
                        ? `${m.notifications_drawer_title()} — ${unreadNotifications}`
                        : m.notifications_drawer_title()}>
                    <Icon src={Bell} class="h-5 w-5" />
                    {#if labelsShown}
                        <span class="dock-label">{m.notifications_drawer_title()}</span>
                    {/if}
                    {#if unreadNotifications > 0}
                        <span class="dock-notifications-badge" aria-hidden="true">
                            {unreadNotifications > 9 ? '9+' : unreadNotifications}
                        </span>
                    {/if}
                </button>
                <div class="dock-separator"></div>
            {/if}

            {#each navEntries as entry (entry.key)}
                {#if entry.type === 'item'}
                    {@const isAdminDockEntry = entry.item.url === '/admin' && isAdminUser}
                    <ul class="dock-icons">
                        <li>
                            <!-- The hover/focus-driven flyout container is a plain
                                         div (not the <li>) so mouse/keyboard listeners don't
                                         land on a non-interactive list-semantic element. The
                                         actual interactive control is the <button> inside it
                                         (and the flyout's own <a> menu items). -->
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                class:dock-icon-anchor={isAdminDockEntry}
                                onmouseenter={isAdminDockEntry
                                    ? (e) =>
                                          openDockFlyoutDelayed({ kind: 'pins' }, e.currentTarget)
                                    : undefined}
                                onmouseleave={isAdminDockEntry
                                    ? handleDockFlyoutMouseLeave
                                    : undefined}
                                onfocusout={isAdminDockEntry ? handleDockFlyoutFocusOut : undefined}
                                onkeydown={isAdminDockEntry ? handleDockFlyoutKeydown : undefined}>
                                <!-- No Tooltip for a plain item in icon mode:
                                     `.dock-unfurl` is its label, growing out of the
                                     icon itself. The Admin entry keeps its pins
                                     panel instead, and labelled mode needs neither. -->
                                <Tooltip
                                    text={entry.item.label}
                                    position="right"
                                    fixed
                                    disabled={true}
                                    triggerClass="w-full">
                                    <button
                                        class="dock-icon-wrapper {isActive(
                                            entry.item,
                                            currentPathname,
                                            currentParams,
                                        )
                                            ? 'active'
                                            : ''} {isAdminDockEntry ? 'has-flyout' : ''}"
                                        class:unfurled={dockUnfurl?.key === entry.key}
                                        onclick={() => {
                                            hideUnfurl();
                                            handleNavigation(entry.item);
                                        }}
                                        onpointerenter={(e) => {
                                            preloadNav(entry.item);
                                            if (!isAdminDockEntry)
                                                showUnfurl(
                                                    e.currentTarget,
                                                    entry.key,
                                                    entry.item.label,
                                                    isActive(
                                                        entry.item,
                                                        currentPathname,
                                                        currentParams,
                                                    ),
                                                );
                                        }}
                                        onpointerleave={hideUnfurl}
                                        onblur={hideUnfurl}
                                        onfocus={(e) => {
                                            preloadNav(entry.item);
                                            if (isAdminDockEntry)
                                                openDockFlyoutNow(
                                                    { kind: 'pins' },
                                                    e.currentTarget,
                                                );
                                            else
                                                showUnfurl(
                                                    e.currentTarget,
                                                    entry.key,
                                                    entry.item.label,
                                                    isActive(
                                                        entry.item,
                                                        currentPathname,
                                                        currentParams,
                                                    ),
                                                );
                                        }}
                                        aria-label={entry.item.label}
                                        aria-haspopup={isAdminDockEntry ? 'true' : undefined}
                                        aria-expanded={isAdminDockEntry
                                            ? isFlyoutOpen({ kind: 'pins' })
                                            : undefined}>
                                        {#if typeof entry.item.icon === 'string'}
                                            <img
                                                src={entry.item.icon}
                                                alt={entry.item.label}
                                                loading="eager"
                                                fetchpriority="high"
                                                decoding="async"
                                                class={entry.item.outline
                                                    ? 'dock-outline-icon'
                                                    : 'dock-custom-icon'} />
                                        {:else}
                                            <Icon src={entry.item.icon} class="h-5 w-5" />
                                        {/if}
                                        {#if labelsShown}
                                            <span class="dock-label">{entry.item.label}</span>
                                        {/if}
                                    </button>
                                </Tooltip>
                            </div>
                        </li>
                    </ul>
                {:else}
                    {@const sectionIcon = getSectionIcon(entry.section.icon)}

                    <div class="dock-section">
                        <div class="dock-section-separator"></div>

                        <!-- Section header. Labelled: expands the group in place, as
                             before. Icon-only: opens the labelled flyout instead —
                             expanding in place there only reveals more unlabelled
                             icons, which is the thing people could not navigate. -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="dock-section-trigger"
                            onmouseenter={labelsShown
                                ? undefined
                                : (e) =>
                                      openDockFlyoutDelayed(
                                          { kind: 'section', id: entry.section.id },
                                          e.currentTarget,
                                      )}
                            onmouseleave={labelsShown ? undefined : handleDockFlyoutMouseLeave}
                            onfocusout={labelsShown ? undefined : handleDockFlyoutFocusOut}
                            onkeydown={labelsShown ? undefined : handleDockFlyoutKeydown}>
                            <Tooltip
                                text={entry.section.label}
                                position="right"
                                fixed
                                disabled={labelsShown ||
                                    isFlyoutOpen({ kind: 'section', id: entry.section.id })}
                                triggerClass="w-full">
                                <button
                                    class="dock-section-header"
                                    onclick={(e) => {
                                        if (labelsShown) toggleSection(entry.section.id);
                                        else
                                            openDockFlyoutNow(
                                                { kind: 'section', id: entry.section.id },
                                                e.currentTarget,
                                            );
                                    }}
                                    onfocus={labelsShown
                                        ? undefined
                                        : (e) =>
                                              openDockFlyoutNow(
                                                  { kind: 'section', id: entry.section.id },
                                                  e.currentTarget,
                                              )}
                                    aria-label={labelsShown
                                        ? `${entry.section.label} (${
                                              !getCollapsedState(entry.section.id)
                                                  ? m.admin_sidebar_section_click_to_collapse()
                                                  : m.admin_sidebar_section_click_to_expand()
                                          })`
                                        : entry.section.label}
                                    aria-haspopup={labelsShown ? undefined : 'menu'}
                                    aria-expanded={labelsShown
                                        ? !getCollapsedState(entry.section.id)
                                        : isFlyoutOpen({ kind: 'section', id: entry.section.id })}>
                                    <span class="section-icon">
                                        {#if typeof sectionIcon === 'string'}
                                            <img
                                                src={sectionIcon}
                                                alt={entry.section.label}
                                                loading="eager"
                                                fetchpriority="high"
                                                decoding="async"
                                                class="dock-outline-icon" />
                                        {:else if sectionIcon}
                                            <Icon src={sectionIcon} class="h-4 w-4" />
                                        {:else}
                                            <Icon
                                                src={!getCollapsedState(entry.section.id)
                                                    ? FolderOpen
                                                    : Folder}
                                                class="h-4 w-4" />
                                        {/if}
                                    </span>
                                    {#if labelsShown}
                                        <span class="dock-label dock-section-label"
                                            >{entry.section.label}</span>
                                    {/if}
                                    <span class="section-chevron">
                                        <Icon
                                            src={labelsShown
                                                ? !getCollapsedState(entry.section.id)
                                                    ? ChevronUp
                                                    : ChevronDown
                                                : ChevronRight}
                                            class="h-3 w-3" />
                                    </span>
                                </button>
                            </Tooltip>
                        </div>

                        <!-- Section items, inline. Only in labelled mode: in icon
                             mode the flyout lists them with their names. -->
                        {#if labelsShown && !getCollapsedState(entry.section.id)}
                            <ul class="dock-icons section-items">
                                {#each entry.items as child (child.key)}
                                    <li>
                                        <Tooltip
                                            text={child.item.label}
                                            position="right"
                                            fixed
                                            disabled={labelsShown}
                                            triggerClass="w-full">
                                            <button
                                                class="dock-icon-wrapper {isActive(
                                                    child.item,
                                                    currentPathname,
                                                    currentParams,
                                                )
                                                    ? 'active'
                                                    : ''}"
                                                onclick={() => handleNavigation(child.item)}
                                                aria-label={child.item.label}>
                                                {#if typeof child.item.icon === 'string'}
                                                    <img
                                                        src={child.item.icon}
                                                        alt={child.item.label}
                                                        loading="eager"
                                                        fetchpriority="high"
                                                        decoding="async"
                                                        class={child.item.outline
                                                            ? 'dock-outline-icon'
                                                            : 'dock-custom-icon'} />
                                                {:else}
                                                    <Icon src={child.item.icon} class="h-5 w-5" />
                                                {/if}
                                                {#if labelsShown}
                                                    <span class="dock-label"
                                                        >{child.item.label}</span>
                                                {/if}
                                            </button>
                                        </Tooltip>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                {/if}
            {/each}

            <!-- Separator and collapse button (desktop only). Hidden on /admin:
                 labels are forced off there (the admin area has its own
                 sidebar), so the toggle would store a new mode and change
                 nothing on screen — a control that does nothing where it is
                 shown. -->
            {#if !isMobile && !onAdminPage}
                <div class="dock-separator"></div>
                <Tooltip
                    text={dockLabelsToggleLabel}
                    position="right"
                    fixed
                    disabled={labelsShown}
                    triggerClass="w-full">
                    <button
                        class="collapse-button-inline"
                        onclick={toggleDockLabels}
                        aria-label={dockLabelsToggleLabel}>
                        <Icon src={labelsShown ? ChevronLeft : ChevronRight} class="h-4 w-4" />
                        {#if labelsShown}
                            <span class="dock-label">{dockLabelsToggleLabel}</span>
                        {/if}
                    </button>
                </Tooltip>
            {/if}
        </nav>
    </div>

    <!-- Hover unfurl: the hovered item's name growing out of its own icon.
         Keyed so each item replays the animation instead of one pill sliding
         between rows — that is what turns a sweep into a wave. -->
    {#if dockUnfurl}
        {#key dockUnfurl.key}
            <div
                class="dock-unfurl {dockUnfurl.active ? 'active' : ''}"
                style="top: {dockUnfurl.y}px; left: {dockUnfurl.x}px; height: {dockUnfurl.height}px"
                aria-hidden="true">
                <span class="dock-unfurl-label">{dockUnfurl.label}</span>
            </div>
        {/key}
    {/if}

    <!-- Flyout panel. A sibling of `.dock-content`, NOT a child: inside the
         scroller it was clipped away entirely (measured: 194px wide, starting
         at x=71 against a 70px visible box, zero pixels painted). Fixed, and
         pinned to the trigger's viewport centre. -->
    {#if dockFlyout}
        {@const isPins = dockFlyout.target.kind === 'pins'}
        <div
            bind:this={dockFlyoutEl}
            class="dock-flyout"
            role="menu"
            tabindex="-1"
            aria-label={isPins
                ? m.dock_admin_pins_aria_label()
                : (flyoutSection?.section.label ?? '')}
            style="top: {dockFlyout.y}px; z-index: {Z.NAV_POPUP};"
            onmouseenter={clearDockFlyoutCloseTimer}
            onmouseleave={handleDockFlyoutMouseLeave}
            onfocusout={handleDockFlyoutFocusOut}
            onkeydown={handleDockFlyoutKeydown}>
            {#if isPins}
                <a
                    class="dock-flyout-header"
                    href={resolve('/admin')}
                    role="menuitem"
                    onclick={closeDockFlyoutNow}>
                    {m.dock_admin_pins_header()}
                </a>
                <!-- Nothing for the empty case and nothing while loading: with no
                     pins the panel is just its header, which is also this icon's
                     only name (the Admin entry's tooltip is disabled because the
                     flyout takes over labelling it). An empty state here would be
                     a paragraph of instructions in a menu that cannot carry them
                     out, and a 'Loading' line would flash on the first hover for
                     a list that is usually empty or tiny. -->
                {#if navPins && navPins.length > 0}
                    <ul class="dock-flyout-list">
                        {#each navPins as pin (pin.href)}
                            <li>
                                <a
                                    href={resolve(pin.href)}
                                    role="menuitem"
                                    onclick={closeDockFlyoutNow}>
                                    {pin.label}
                                </a>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {:else if flyoutSection}
                <p class="dock-flyout-header dock-flyout-title">{flyoutSection.section.label}</p>
                {#if flyoutSection.items.length > 0}
                    <ul class="dock-flyout-list">
                        {#each flyoutSection.items as child (child.key)}
                            <li>
                                <button
                                    type="button"
                                    role="menuitem"
                                    class="dock-flyout-item {isActive(
                                        child.item,
                                        currentPathname,
                                        currentParams,
                                    )
                                        ? 'active'
                                        : ''}"
                                    onclick={() => {
                                        closeDockFlyoutNow();
                                        handleNavigation(child.item);
                                    }}>
                                    <span class="dock-flyout-icon">
                                        {#if typeof child.item.icon === 'string'}
                                            <img src={child.item.icon} alt="" />
                                        {:else}
                                            <Icon src={child.item.icon} class="h-4 w-4" />
                                        {/if}
                                    </span>
                                    <span class="truncate">{child.item.label}</span>
                                </button>
                            </li>
                        {/each}
                    </ul>
                {:else}
                    <p class="dock-flyout-empty">{m.admin_navigation_sidebar_empty()}</p>
                {/if}
            {/if}
        </div>
    {/if}
</aside>

<style lang="postcss">
    /* Zero-footprint probe for bottomStackReservedPx() — binds height to
       --music-bottom-stack (a real box-model property resolves calc()-valued
       custom properties; the custom property itself does not) so JS can read
       a pixel value via getBoundingClientRect() without measuring the nav
       bar / MiniPlayer elements directly. */
    .bottom-stack-probe {
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: var(--music-bottom-stack, 0px);
        visibility: hidden;
        pointer-events: none;
    }

    /* Labelled mode. This width IS the main content's left gutter, so it has to
       stay in lockstep with `.main-content.with-dock-labels` in
       src/routes/+layout.svelte (220px). Two scoped stylesheets cannot share a
       constant; changing one without the other leaves a gap or an overlap. */
    .icon-dock.labeled {
        --dock-rail-width: 220px;
        align-items: stretch;
    }

    .icon-dock.labeled .dock-segment,
    .icon-dock.labeled .dock-icons,
    .icon-dock.labeled .dock-content,
    .icon-dock.labeled .dock-section {
        align-items: stretch;
        width: 100%;
    }

    .icon-dock.labeled .dock-segment {
        padding-inline: 0.75rem;
    }

    .icon-dock.labeled .dock-icon-wrapper,
    .icon-dock.labeled .dock-section-header,
    .icon-dock.labeled .collapse-button-inline {
        width: 100%;
        justify-content: flex-start;
        gap: 0.75rem;
        padding-inline: 0.75rem;
    }

    .icon-dock.labeled .dock-section-header {
        justify-content: space-between;
    }

    .icon-dock.labeled .dock-section-label {
        flex: 1;
    }

    /* ── Labelled rail: a list, not a stack of cards ──────────────────────
       The icon rail's per-item border and translucent fill read as a card
       because at 48×48 that IS the item. Once a row is 220px wide with a name
       in it, the same treatment turns the rail into eight boxes; the row itself
       is the hit target, so hover/active alone can carry the state. */
    .icon-dock.labeled .dock-icon-wrapper,
    .icon-dock.labeled .dock-notifications,
    .icon-dock.labeled .dock-section-header {
        background: transparent;
        border-color: transparent;
        box-shadow: none;
    }

    .icon-dock.labeled .dock-icon-wrapper:hover,
    .icon-dock.labeled .dock-section-header:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.28);
        border-color: transparent;
        box-shadow: none;
        /* The rail's `scale(1.15) translateY(-2px)` is right for a 48px square
           and wrong for a full-width row — it would swell over its neighbours. */
        transform: none;
    }

    .icon-dock.labeled .dock-icon-wrapper.active {
        background: rgb(var(--color-primary-500-rgb) / 0.22);
        border-color: transparent;
        box-shadow: none;
    }

    /* Tighter rhythm: rows that read as one list rather than eight objects. */
    .icon-dock.labeled .dock-segment {
        gap: 0.25rem;
    }

    .icon-dock.labeled .dock-icons {
        gap: 0.25rem;
    }

    /* Notifications is a destination like any other once it has a name. */
    .icon-dock.labeled .dock-notifications {
        width: 100%;
        height: 48px;
        justify-content: flex-start;
        gap: 0.75rem;
        padding-inline: 0.75rem;
        border-radius: 0.875rem;
    }

    /* Count sits at the end of the row, not clipped to the icon's corner. */
    .icon-dock.labeled .dock-notifications-badge {
        top: 50%;
        right: 0.75rem;
        transform: translateY(-50%);
    }

    /* A hairline that spans the list instead of a 32px dash floating in 220px. */
    .icon-dock.labeled .dock-separator,
    .icon-dock.labeled .dock-section-separator {
        width: auto;
        margin: 0.5rem 0.75rem;
    }

    /* ── Hover unfurl ─────────────────────────────────────────────────────
       Flush against the icon's right edge and the same height, so the two read
       as one row rather than an icon plus a bubble. Fixed-positioned from the
       trigger's viewport rect: the scroller clips horizontally, so this cannot
       live inside it. */
    .dock-unfurl {
        position: fixed;
        /* Its `height` is set from the icon's measured border-box rect, so it
           has to read that number the same way — not inherit the assumption
           from a global reset. */
        box-sizing: border-box;
        display: flex;
        align-items: center;
        width: max-content;
        padding-right: 0.875rem;
        color: var(--color-surface-50);
        font-size: 0.875rem;
        line-height: 1;
        white-space: nowrap;
        pointer-events: none;
        z-index: 101; /* one above .icon-dock */
    }

    /*
     * The pill is a background LAYER behind the name, not a box the name lives
     * inside — and it is the layer that animates.
     *
     * Growing the box itself (max-width + overflow:hidden) meant a hard edge
     * wiping across text that was already laid out: letters appeared sliced
     * down the middle, one column of pixels at a time. Revealing a background
     * under static text has no such edge to cut a glyph on, and `clip-path:
     * inset(... round)` keeps the trailing corner radius intact throughout,
     * which a `transform: scaleX()` would squash.
     */
    .dock-unfurl::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 0 0.875rem 0.875rem 0;
        /* Three sides only — the fourth is the icon's, and the two halves share
           the seam. Same width and colour as the icon's, so the outline reads
           as one continuous stroke around the joined shape. */
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.4);
        border-left: none;
        background: rgb(var(--color-surface-600-rgb) / 0.28);
        animation: dock-unfurl 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    /* Long names still have to stop somewhere. Static truncation, applied to
       the text itself, so nothing is clipped WHILE the pill opens. */
    .dock-unfurl-label {
        position: relative;
        max-width: 13rem;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .dock-unfurl.active {
        color: var(--color-primary-200);
    }

    .dock-unfurl.active::before {
        background: rgb(var(--color-primary-500-rgb) / 0.22);
        border-color: rgb(var(--color-primary-500-rgb) / 0.4);
        border-left: none;
    }

    /* `max-width` rather than `width`: the pill is content-sized, and width
       cannot animate to `auto`. Padding grows with it so short names do not
       start out with a 14px gap already open. */
    @keyframes dock-unfurl {
        from {
            clip-path: inset(0 100% 0 0 round 0 0.875rem 0.875rem 0);
        }
        to {
            clip-path: inset(0 0 0 0 round 0 0.875rem 0.875rem 0);
        }
    }

    /* The name fades in behind the opening edge — no translate, because
       sliding text under a moving edge is what read as clipping. */
    .dock-unfurl-label {
        animation: dock-unfurl-label 200ms ease-out 90ms both;
    }

    @keyframes dock-unfurl-label {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    /* While its name is out, the icon is the LEFT HALF of one shape, not a box
       in its own right. It therefore gives up three things it has when hovered
       alone, each of which broke the illusion:
         - its trailing corners and its right border, which drew a seam straight
           down the middle of the joined pill;
         - `scale(1.15) translateY(-2px)`, which grew the icon away from a label
           anchored to the rect measured before the transform ran;
         - its drop shadow, which fell across the label.
       `:hover` is matched explicitly because these are the rules it sets. */
    .dock-icon-wrapper.unfurled,
    .dock-icon-wrapper.unfurled:hover {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
        background: rgb(var(--color-surface-600-rgb) / 0.28);
        border-color: rgb(var(--color-surface-500-rgb) / 0.4);
        /* Transparent, not removed: the background paints under the border, so
           the icon's fill runs to the seam with no 1px gap. */
        border-right-color: transparent;
        box-shadow: none;
        transform: none;
    }

    .dock-icon-wrapper.unfurled.active,
    .dock-icon-wrapper.unfurled.active:hover {
        background: rgb(var(--color-primary-500-rgb) / 0.22);
        border-color: rgb(var(--color-primary-500-rgb) / 0.4);
        border-right-color: transparent;
    }

    @media (prefers-reduced-motion: reduce) {
        .dock-unfurl::before,
        .dock-unfurl-label {
            animation: none;
        }
    }

    .dock-label {
        font-size: 0.875rem;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: left;
    }

    /* The shell. It must NOT scroll: `overflow-y: auto` here forced the
       authored `overflow-x: visible` to compute as `auto` (CSS Overflow 3 §3),
       which clipped every overlay a descendant painted past x=70 — the hover
       tooltip, the admin pins flyout and the active-item bar were all measured
       painting zero pixels because of this one pair of declarations. Scrolling
       lives on `.dock-content` instead. */
    .icon-dock {
        /* Rail width, exposed so fixed-positioned overlays can sit beside the
           rail without hardcoding it. A `fixed` element resolves percentages
           against the VIEWPORT, so `left: calc(100% + gap)` would put a panel
           off the right edge of the screen. */
        --dock-rail-width: 70px;

        position: fixed;
        /* Start below the navbar (large state: ~70px) */
        top: 70px;
        bottom: 0;
        left: 0;
        width: var(--dock-rail-width);
        background: transparent;
        transition:
            transform 0.3s ease-in-out,
            top 0.3s ease,
            width 0.3s ease-in-out;
        z-index: 100; /* Z.SIDEBAR_DOCK */
        display: flex;
        flex-direction: column;
        align-items: stretch;
        overflow: visible;
    }

    /* When navbar is scrolled (smaller), dock moves up */
    .icon-dock.navbar-scrolled {
        top: 50px;
    }

    /* Mobile is an overlay drawer, so its width costs the page nothing — it is
       always labelled (see `labelsShown`), which is why the old hard 70px is
       gone. */
    .icon-dock.mobile {
        transform: translateX(-100%);
        --dock-rail-width: 220px;
        height: auto !important;
        background: transparent;
        backdrop-filter: none;
        border-radius: 0;
        border-right: none;
        box-shadow: none;
    }

    .icon-dock.mobile.open {
        transform: translateX(0);
    }

    /* The only scroll container in the dock. Overlays (tooltips, the pins
       flyout) must never be descendants of this element — they portal to the
       body or sit in the shell, or they get clipped exactly as before. */
    .dock-content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 1rem 0 2rem 0;
        /* Hide scrollbar but keep functionality */
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* IE/Edge */
    }

    .dock-content::-webkit-scrollbar {
        display: none; /* Chrome/Safari */
    }

    .dock-segment {
        /* Vertical centering when the rail is shorter than the viewport; the
           auto margins collapse once it is taller and the content scrolls.
           (This lived on `.dock-content` while that element was the centred
           child of the scrolling shell.) */
        margin: auto 0;
        flex-shrink: 0;
    }

    .dock-segment {
        /* Transparent dock - no background for cleaner look */
        border-radius: 1.25rem;
        padding: 1rem 0.75rem;
        position: relative;
        /* navEntries renders each top-level link in its own single-item <ul>
           interleaved with sections; the column gap keeps the spacing those
           links had when they shared one list. */
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
    }

    .dock-icons {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: center;
    }

    .dock-icon-wrapper {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.875rem;
        background: rgb(var(--color-surface-700-rgb) / 0.1);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.2);
        cursor: pointer;
        color: var(--color-surface-300);
        transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        position: relative;
        backdrop-filter: blur(8px);
    }

    .dock-icon-wrapper:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.3);
        color: var(--color-surface-50);
        transform: scale(1.15) translateY(-2px);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        border-color: rgb(var(--color-surface-500-rgb) / 0.4);
    }

    .dock-icon-wrapper.active {
        background: rgb(var(--color-primary-500-rgb) / 0.3);
        color: var(--color-primary-300);
        border-color: rgb(var(--color-primary-500-rgb) / 0.4);
        box-shadow:
            0 0 0 2px rgb(var(--color-primary-500-rgb) / 0.1),
            0 4px 16px rgba(0, 0, 0, 0.2);
    }

    /* Inside the wrapper, not `left: -1rem` outside it. At -1rem the bar sat at
       x = -5..-1 — left of the rail's own padding box, so the scroll container
       clipped it and the active item has never actually shown an indicator. */
    .dock-icon-wrapper.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 4px;
        height: 20px;
        background: linear-gradient(to bottom, var(--color-primary-400), var(--color-primary-500));
        border-radius: 2px;
        box-shadow: 0 2px 8px rgb(var(--color-primary-500-rgb) / 0.3);
    }

    /* Admin dock icon quick-menu (pinned nav) flyout */
    .dock-icon-anchor {
        position: relative;
    }

    .dock-flyout {
        /* Fixed, not absolute: the panel is positioned from the trigger's
           viewport rect so it does not need (and must not have) an ancestor
           inside the scroll container. */
        position: fixed;
        left: calc(var(--dock-rail-width) + 0.75rem);
        transform: translateY(-50%);
        min-width: 180px;
        max-width: 260px;
        max-height: min(60vh, 420px);
        display: flex;
        flex-direction: column;
        background: rgb(var(--color-surface-800-rgb) / 0.98);
        backdrop-filter: blur(12px);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        border-radius: 0.75rem;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        padding: 0.375rem;
        overflow-y: auto;
        /* Above page content (incl. the sticky /admin sidebar, which has no
           z-index of its own and lives in normal document flow) but below
           navbar-tier popups. See src/lib/utils/z-index.ts Z.NAV_POPUP. */
    }

    .dock-flyout-header {
        display: block;
        padding: 0.5rem 0.625rem;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--color-surface-400);
        border-bottom: 1px solid rgb(var(--color-surface-600-rgb) / 0.3);
        margin-bottom: 0.25rem;
        text-decoration: none;
        border-radius: 0.5rem 0.5rem 0 0;
    }

    .dock-flyout-header:hover {
        color: var(--color-primary-300);
        background: rgb(var(--color-surface-700-rgb) / 0.4);
    }

    .dock-flyout-list {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        list-style: none;
        margin: 0;
        padding: 0;
    }

    .dock-flyout-list a {
        display: block;
        padding: 0.5rem 0.625rem;
        border-radius: 0.5rem;
        color: var(--color-surface-200);
        text-decoration: none;
        font-size: 0.875rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 0.15s ease;
    }

    .dock-flyout-list a:hover,
    .dock-flyout-list a:focus-visible {
        background: rgb(var(--color-primary-500-rgb) / 0.2);
        color: var(--color-primary-200);
    }

    /* Section items in the flyout. Buttons, not links: navigation goes through
       `handleNavigation()` so a section child behaves identically whether it is
       clicked here or on the rail. Styled to match the pins list. */
    .dock-flyout-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.625rem;
        border-radius: 0.5rem;
        color: var(--color-surface-200);
        font-size: 0.875rem;
        text-align: left;
        background: transparent;
        border: none;
        cursor: pointer;
        transition: background 0.15s ease;
    }

    .dock-flyout-item:hover,
    .dock-flyout-item:focus-visible {
        background: rgb(var(--color-primary-500-rgb) / 0.2);
        color: var(--color-primary-200);
    }

    .dock-flyout-item.active {
        background: rgb(var(--color-primary-500-rgb) / 0.15);
        color: var(--color-primary-200);
    }

    .dock-flyout-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1rem;
        height: 1rem;
        flex-shrink: 0;
    }

    .dock-flyout-icon img {
        width: 1rem;
        height: 1rem;
        object-fit: contain;
    }

    /* The section name at the top of its flyout — same weight as the pins
       header, but not a link: the section itself has no page to go to. */
    .dock-flyout-title {
        cursor: default;
    }

    /* The trigger wrapper owns the section's hover/focus handlers. It must be a
       real box: `display: contents` generates none, and an element with no box
       never fires `mouseenter`/`mouseleave` — the flyout would only ever open
       on focus. Full width so the whole row is the hover target. */
    .dock-section-trigger {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
    }

    .dock-flyout-empty {
        padding: 0.5rem 0.625rem;
        font-size: 0.8125rem;
        color: var(--color-surface-400);
        margin: 0;
        white-space: normal;
    }

    /* Touch/coarse-pointer devices never get the flyout — a tap should just
       navigate to /admin, same as every other dock icon. */
    @media (hover: none) {
        .dock-flyout {
            display: none;
        }
    }

    /* Separator line inside dock */
    .dock-separator {
        width: 32px;
        height: 1px;
        background: rgb(var(--color-surface-600-rgb) / 0.4);
        margin: 0.75rem auto;
    }

    /* Collapsible Section Styles */
    .dock-section {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    .dock-section-separator {
        width: 32px;
        height: 1px;
        background: rgb(var(--color-surface-600-rgb) / 0.3);
        margin: 0.5rem auto;
    }

    .dock-section-header {
        width: 48px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.125rem;
        border-radius: 0.75rem;
        background: rgb(var(--color-surface-700-rgb) / 0.2);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.15);
        cursor: pointer;
        color: var(--color-surface-400);
        transition: all 0.2s ease;
        position: relative;
    }

    .dock-section-header:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.3);
        color: var(--color-surface-200);
        border-color: rgb(var(--color-surface-500-rgb) / 0.3);
    }

    .dock-section-header .section-icon {
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .dock-section-header .section-chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.6;
    }

    .dock-section-header:hover .section-chevron {
        opacity: 1;
    }

    .section-items {
        margin-top: 0.5rem;
    }

    /* Inline collapse button (inside dock) */
    .collapse-button-inline {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 0.75rem;
        background: transparent;
        border: 1px solid transparent;
        color: var(--color-surface-400);
        cursor: pointer;
        transition: all 0.2s ease;
        margin: 0 auto;
    }

    .collapse-button-inline:hover {
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        color: var(--color-surface-200);
        border-color: rgb(var(--color-surface-600-rgb) / 0.3);
    }

    /* Mobile specific styles */
    @media (max-width: 767px) {
        .icon-dock {
            top: 50px !important; /* Below mobile navbar */
            bottom: 0 !important; /* Extend to bottom of viewport */
            height: auto !important;
            transform: translateX(-100%) !important;
            /* The drawer is labelled (see `labelsShown`), so it needs room for
               names. The old hard 70px survived the rest of this change and
               cropped every label to a single character. `!important` only
               because the rest of this block already fights that way; the vw
               cap keeps it off the edge of a small phone. */
            --dock-rail-width: min(220px, 78vw);
            width: var(--dock-rail-width) !important;
            max-width: none !important;
            /* 0.97, not 0.95: at 0.95 a bright hero behind the sheet bleeds
               through in bands that read as inconsistent row fills. */
            background: rgb(var(--color-surface-900-rgb) / 0.97) !important;
            backdrop-filter: blur(16px) !important;
            /* The drawer is a sheet over the page, so it gets a sheet's edge:
               rounded on the side it opens toward, a hairline to separate it
               from the backdrop, and enough elevation to read as above rather
               than beside. Square-cut at 100% height looked like a column of
               the layout that had failed to load. */
            border-radius: 0 1.5rem 1.5rem 0 !important;
            border-right: 1px solid rgb(255 255 255 / 0.07) !important;
            box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.65) !important;
        }

        .icon-dock.navbar-scrolled {
            top: 40px !important; /* Smaller when navbar scrolled */
        }

        .icon-dock.mobile {
            transform: translateX(-100%) !important;
        }

        .icon-dock.mobile.open {
            transform: translateX(0) !important;
        }

        .dock-content {
            padding: 0.75rem 0 1.25rem;
            width: 100%;
            height: 100%;
            max-height: none;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            align-items: center;
            overflow-y: auto;
            overflow-x: hidden;
        }

        .dock-segment {
            width: 100%;
            margin: 0 auto;
            background: transparent;
            border: none;
            box-shadow: none;
            flex-shrink: 0;
        }

        /* Custom scrollbar for mobile */
        .dock-content::-webkit-scrollbar {
            width: 4px;
        }

        .dock-content::-webkit-scrollbar-track {
            background: transparent;
        }

        .dock-content::-webkit-scrollbar-thumb {
            background: var(--color-surface-600);
            border-radius: 2px;
        }

        .dock-content::-webkit-scrollbar-thumb:hover {
            background: var(--color-surface-500);
        }

        /* Subtle mobile toggle button. Position (top/left/right) is driven by an
           inline style so it can be dragged; the snap-to-edge spring comes from
           the transition below. */
        .mobile-toggle {
            position: fixed !important;
            z-index: 2000 !important; /* Z.TOOLTIP */
            width: 40px !important;
            height: 40px !important;
            border-radius: 50% !important;
            /* 0.6 (was 0.4): at lower alpha the floating button melted into
               card badges/posters scrolling under it and became hard to spot. */
            background: rgba(0, 0, 0, 0.6) !important;
            backdrop-filter: blur(12px) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            color: rgba(255, 255, 255, 0.9) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 0 !important;
            transition: all 0.2s ease !important;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2) !important;
            /* Drag ergonomics: don't scroll the page while dragging, and don't
               select text / show the iOS callout on long press. */
            touch-action: none !important;
            user-select: none !important;
            -webkit-user-select: none !important;
            -webkit-touch-callout: none !important;
        }

        /* Unread badge on the draggable trigger. `position:absolute` against
           the trigger's `position:fixed` box, so it travels with the drag for
           free rather than needing its own coordinates. */
        .trigger-badge {
            position: absolute !important;
            top: -2px !important;
            right: -2px !important;
            min-width: 16px !important;
            height: 16px !important;
            padding: 0 4px !important;
            border-radius: 9999px !important;
            background: #ef4444 !important;
            color: #fff !important;
            font-size: 10px !important;
            line-height: 16px !important;
            text-align: center !important;
            font-weight: 600 !important;
            pointer-events: none !important;
        }

        /* Notifications entry inside the mobile dock — matches the desktop
           collapse button's treatment so the dock tail reads as one family. */
        .dock-notifications {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 44px;
            height: 44px;
            border-radius: 12px;
            color: rgba(255, 255, 255, 0.75);
            background: transparent;
            transition: all 0.15s ease;
        }

        .dock-notifications:hover {
            color: white;
            background: rgba(255, 255, 255, 0.08);
        }

        .dock-notifications-badge {
            position: absolute;
            top: 4px;
            right: 4px;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            border-radius: 9999px;
            background: #ef4444;
            color: #fff;
            font-size: 10px;
            line-height: 16px;
            text-align: center;
            font-weight: 600;
        }

        .mobile-toggle:hover {
            background: rgba(0, 0, 0, 0.75) !important;
            color: white !important;
            transform: scale(1.05) !important;
        }

        .mobile-toggle:active {
            transform: scale(0.95) !important;
        }

        /* While dragging, follow the finger with no transition or scale. */
        .mobile-toggle.dragging,
        .mobile-toggle.dragging:hover,
        .mobile-toggle.dragging:active {
            transition: none !important;
            transform: none !important;
            cursor: grabbing !important;
        }
    }

    /* The tooltip that used to live here as `.dock-icon-wrapper::after` was
       never visible: it is a child of the scrolling `.icon-dock`, whose
       authored `overflow-x: visible` computes to `auto` beside `overflow-y:
       auto`, clipping it at the 70px padding box it starts 5px past. It is now
       `.dock-tooltip`, rendered a level up in `.dock-hover-zone`. */

    /* Custom icon styling for service icons with built-in backgrounds */
    .dock-custom-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        object-fit: cover;
    }

    /* Outline-style icons (Hero Icons saved as SVG) - use filter to match color */
    .dock-outline-icon {
        width: 20px;
        height: 20px;
        /* Convert black stroke to light gray (--color-surface-300) */
        filter: invert(80%) sepia(5%) saturate(200%) hue-rotate(180deg) brightness(95%)
            contrast(90%);
    }

    .dock-icon-wrapper:hover .dock-outline-icon {
        /* Brighter on hover (--color-surface-50) */
        filter: invert(100%) sepia(0%) saturate(0%) brightness(100%) contrast(100%);
    }

    .dock-icon-wrapper.active .dock-outline-icon {
        /* Active custom icons go plain WHITE, not a filter-faked accent: CSS
           filters can't read theme vars, and the old hue-rotate(200deg) chain
           hardcoded an indigo approximation that clashed under non-indigo
           themes. White reads correctly on the accent-tinted active pill in
           every theme (built-in <Icon> glyphs already follow currentColor via
           the wrapper's `color` and need no filter). */
        filter: invert(100%) sepia(0%) saturate(0%) brightness(100%) contrast(100%);
    }

    /* PWA standalone safe area support */
    @media (display-mode: standalone) {
        .icon-dock {
            /* Account for iOS status bar at top */
            top: calc(70px + env(safe-area-inset-top, 0px));
        }

        .icon-dock.navbar-scrolled {
            top: calc(50px + env(safe-area-inset-top, 0px));
        }

        .mobile-toggle {
            /* Push below iOS status bar */
            top: calc(1rem + env(safe-area-inset-top, 0px)) !important;
        }
    }
</style>
