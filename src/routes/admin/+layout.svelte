<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin shell (admin IA redesign, spec §4/§6). One compact header bar (title +
  breadcrumb + bell + account menu), then the manifest-driven navigation in the
  user's chosen style (sidebar | mega), a single row of section sub-page tabs,
  and the page. The Authentik group chips and "logged in as" now live inside the
  account menu on ALL sizes; the mobile drawer is manifest-driven too.
-->
<script lang="ts">
    import '$lib/components/app-shell';
    import * as m from '$lib/paraglide/messages.js';
    import { onMount } from 'svelte';
    import { initializeShowAdvancedSettings } from '$lib/stores/admin-show-advanced.store';
    import { goto, afterNavigate } from '$app/navigation';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import {
        Icon,
        Cog6Tooth,
        ExclamationTriangle,
        Bars3,
        ChevronDown,
        MagnifyingGlass,
        ArrowUturnLeft,
        ArrowRightOnRectangle,
    } from 'svelte-hero-icons';
    import { env } from '$env/dynamic/public';
    import {
        resolveLogoutMode,
        performNativeSignOut,
    } from '$lib/components/user-menu/user-menu-logout.js';
    import { DevModeSwitcher } from '$lib/components/admin';
    import AdminMegaMenu from '$lib/components/admin/nav/AdminMegaMenu.svelte';
    import AdminSidebar from '$lib/components/admin/nav/AdminSidebar.svelte';
    import AdminNavDrawer from '$lib/components/admin/nav/AdminNavDrawer.svelte';
    import AdminBreadcrumb from '$lib/components/admin/nav/AdminBreadcrumb.svelte';
    import AdminSectionTabs from '$lib/components/admin/nav/AdminSectionTabs.svelte';
    import ConfigHealthBanner from '$lib/components/admin/ConfigHealthBanner.svelte';
    import NotificationBell from '$lib/components/admin/attention/NotificationBell.svelte';
    import UserNotificationBell from '$lib/components/notifications/NotificationBell.svelte';
    import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
    import NavigationProgressBar from '$lib/components/ui/NavigationProgressBar.svelte';
    import ShortcutHelpModal from '$lib/components/ui/ShortcutHelpModal.svelte';
    import AdminCommandPalette from '$lib/components/admin/AdminCommandPalette.svelte';
    import { shortcuts } from '$lib/stores/shortcuts.svelte';
    import { isInputFocused } from '$lib/utils/admin/settings-search';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { visibleNav, findNavPage, type AdminNavStyle } from '$lib/config/admin-nav';
    import { lastSectionPageStorageKey } from '$lib/components/admin/admin-nav.utils.js';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { adminNavPrefs } from '$lib/stores/admin-nav-prefs.store.svelte.js';
    import type { LayoutData } from './$types';

    interface Props {
        data: LayoutData;
        children?: import('svelte').Snippet;
    }

    let { data, children }: Props = $props();

    let isAdmin = $derived(data?.isAdmin || false);
    let currentUsername = $derived(data?.user?.username || m.misc_unknown());
    // Dedup Authentik groups (repeats throw each_key_duplicate on the chips).
    let currentGroups = $derived([...new Set(data?.user?.userGroups ?? [])]);
    let trainingAssignments = $derived(data?.features?.trainingAssignments === true);
    let assessment = $derived(data?.features?.assessment === true);
    let showcase = $derived(data?.features?.showcase === true);
    let devToolsEnabled = $derived(data?.devToolsEnabled === true);

    let navGate = $derived({
        devToolsEnabled,
        features: data?.features ?? {},
        trainingAssignments,
        assessment,
        showcase,
    });

    // The ONE gated section list every renderer consumes (spec §4).
    let sections = $derived(visibleNav(navGate));

    // Nav style (per-user, live-switchable). The server value drives SSR; a live
    // switch sets a client override that wins (see the store) — no flash.
    let serverNavStyle = $derived(
        (data?.uiPrefs?.navStyle as AdminNavStyle | undefined) ?? 'sidebar',
    );
    let navStyle = $derived(adminNavPrefs.resolveStyle(serverNavStyle));

    let devMode = import.meta.env.DEV;
    let defaultUser = $derived(data?.defaultUser || 'admin');
    let currentDevUser = $state('');
    let showShortcuts = $state(false);
    let paletteOpen = $state(false);
    let accountMenuOpen = $state(false);
    let drawerOpen = $state(false);

    // Register global admin shortcuts so the "?" help modal has content on every
    // admin page (individual pages may still register their own extra groups).
    $effect(() => {
        const paletteKey = browser && navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl+K';
        return shortcuts.register({
            label: m.admin_shortcut_group_general(),
            entries: [
                { keys: [paletteKey], description: m.admin_shortcut_open_palette() },
                { keys: ['/'], description: m.admin_shortcut_focus_search() },
                { keys: ['?'], description: m.admin_shortcut_show_help() },
            ],
        });
    });

    // Same fallback as the root layout's app name.
    let appName = $derived(
        ($page.data as { branding?: { appName?: string } }).branding?.appName ||
            (m.nav_dashboard() as string),
    );

    let avatarInitial = $derived((currentUsername || '?').charAt(0).toUpperCase());
    // Real avatar keyed on username (endpoint resolves custom / Jellyfin / Gravatar).
    // Falls back to the initial when the endpoint 404s (no image anywhere).
    let avatarSrc = $derived(data?.user?.username ? getAvatarUrl(data.user.username) : '');
    let avatarImageError = $state(false);
    let showAvatarImage = $derived(!!avatarSrc && !avatarImageError);

    onMount(() => {
        let storedUser: string | null = null;
        try {
            storedUser = localStorage.getItem('devUser');
        } catch {
            // expected: storage blocked (private mode, site data off) — no stored dev user
        }
        currentDevUser = storedUser || defaultUser;
        if (storedUser) {
            document.cookie = `devUser=${encodeURIComponent(currentDevUser)}; path=/; max-age=${60 * 60 * 24 * 7}`;
        }
    });

    onMount(() => {
        if (!isAdmin) {
            void goto(resolve('/'));
        }
    });

    // The admin layout owns the ONE status poller (spec §5); it also restores
    // the persisted sidebar rail pin and the user's expanded sections.
    onMount(() => {
        initializeShowAdvancedSettings();
        adminNavPrefs.initFromStorage(data?.user?.username ?? '');
        adminStatus.start();
        return () => adminStatus.stop();
    });

    // Auto-collapse the sidebar to its rail below the xl breakpoint (spec §4);
    // above it, the manual pin is restored.
    $effect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(max-width: 1279px)');
        const apply = (): void => adminNavPrefs.applyBreakpoint(mq.matches);
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    });

    // Close transient popovers on navigation.
    $effect(() => {
        void $page.url.pathname;
        accountMenuOpen = false;
        drawerOpen = false;
    });

    // Remember the last sub-page visited within each section (feature:
    // "remember last sub-page"), so a section header/landing link can return
    // the user there instead of always the section's default page. Uses
    // `afterNavigate` (not a `$effect` on `$page.url`) — this repo had a
    // stale-url bug with the `$effect` pattern (see continue-watching-load-perf
    // notes); `afterNavigate` fires once per completed client navigation with
    // the settled URL.
    afterNavigate(() => {
        if (!browser) return;
        const pathname = $page.url.pathname;
        const match = findNavPage(pathname);
        if (!match) return;
        try {
            localStorage.setItem(lastSectionPageStorageKey(match.section.id), pathname);
        } catch {
            // expected: storage blocked or full — the section link falls back to its first page
        }
    });

    function handleUserChange(user: string): void {
        currentDevUser = user;
    }

    function handleGlobalKeydown(event: KeyboardEvent): void {
        if (event.defaultPrevented) return;
        // The account menu's backdrop is not focusable, so Esc has to be caught here.
        if (event.key === 'Escape' && accountMenuOpen) {
            accountMenuOpen = false;
            return;
        }
        // Settings handles this shortcut locally; only one surface should open.
        if (
            document.querySelector('[data-admin-settings-page]') &&
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === 'k'
        )
            return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            paletteOpen = true;
            return;
        }
        if (event.key === '?' && !isInputFocused()) {
            event.preventDefault();
            showShortcuts = true;
        }
    }

    async function pickNavStyle(style: AdminNavStyle): Promise<void> {
        await adminNavPrefs.setStyle(style);
    }

    // Same sign-out flow as the home hero's account menu (UserMenuPopover) —
    // resolved from the SAME helper so the admin header never grows its own
    // copy of the native-session wipe/redirect logic.
    const logoutMode = $derived(
        resolveLogoutMode(($page.data as { authMethod?: string }).authMethod, env.PUBLIC_LOGOUTURL),
    );

    async function adminSignOut(): Promise<void> {
        await performNativeSignOut();
    }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<ToastContainer />
<ShortcutHelpModal bind:open={showShortcuts} groups={shortcuts.groups} />
<AdminCommandPalette
    bind:open={paletteOpen}
    navSections={sections}
    {navGate}
    providerIndex={data?.providerIndex ?? []}
    devFeaturesEnabled={data?.devFeaturesEnabled ?? false} />

{#if !isAdmin}
    <div class="admin-page min-h-screen center pt-4">
        <div class="text-center">
            <Icon src={ExclamationTriangle} class="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h1 class="text-2xl font-bold text-white mb-2">{m.admin_access_denied()}</h1>
            <p class="text-surface-400">{m.admin_need_privileges()}</p>
        </div>
    </div>
{:else}
    <!-- No top clearance for the global #main-navbar: the admin shell hides it
         (`body.admin-shell`, see app.html) and carries its own way back to the
         app plus the personal notifications button in the header below. -->
    <div class="admin-page min-h-screen text-white pt-4">
        <div class="container mx-auto px-4 py-6">
            <!-- Compact header bar (spec §6: one bar, no 450px chrome) -->
            <div class="admin-header">
                <button
                    type="button"
                    class="drawer-trigger"
                    onclick={() => (drawerOpen = true)}
                    aria-label={m.admin_nav_open()}>
                    <Icon src={Bars3} class="w-5 h-5" />
                </button>

                <a
                    href={resolve('/')}
                    class="admin-app-link"
                    title={m.admin_back_to_app({ appName })}
                    aria-label={m.admin_back_to_app({ appName })}>
                    <Icon src={ArrowUturnLeft} class="w-4 h-4" />
                </a>

                <a href={resolve('/admin')} class="admin-brand" aria-label={m.admin_title()}>
                    <Icon src={Cog6Tooth} class="w-6 h-6 text-yellow-400 shrink-0" />
                    <span class="admin-brand-text">{m.admin_title()}</span>
                </a>

                <div class="admin-breadcrumb-slot">
                    <AdminBreadcrumb />
                </div>

                <div class="admin-header-right">
                    <button
                        type="button"
                        class="flex items-center gap-1.5 rounded p-2 text-surface-400 hover:bg-surface-700 hover:text-surface-200"
                        aria-label={m.admin_shortcut_open_palette()}
                        onclick={() => (paletteOpen = true)}>
                        <Icon src={MagnifyingGlass} class="h-4 w-4" />
                        <kbd
                            class="hidden sm:inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0.5 text-xs font-mono rounded bg-surface-800 border border-surface-600 text-surface-300">
                            {#if browser && navigator.platform?.includes('Mac')}⌘K{:else}Ctrl+K{/if}
                        </kbd>
                    </button>
                    <UserNotificationBell inline />
                    <NotificationBell />

                    <div class="account">
                        <button
                            type="button"
                            class="account-btn"
                            onclick={() => (accountMenuOpen = !accountMenuOpen)}
                            aria-haspopup="menu"
                            aria-expanded={accountMenuOpen}
                            aria-label={m.admin_user_menu_label()}>
                            <span class="avatar">
                                {#if showAvatarImage}
                                    <img
                                        class="avatar-img"
                                        src={avatarSrc}
                                        alt=""
                                        onerror={() => (avatarImageError = true)} />
                                {:else}
                                    {avatarInitial}
                                {/if}
                            </span>
                            <span class="account-name">{currentUsername}</span>
                            <Icon src={ChevronDown} class="w-3.5 h-3.5 opacity-60" />
                        </button>

                        {#if accountMenuOpen}
                            <!-- Pointer-only backdrop; Esc is handled by handleGlobalKeydown. -->
                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div class="account-backdrop" onclick={() => (accountMenuOpen = false)}>
                            </div>
                            <div class="account-menu" role="menu">
                                <div class="account-menu-head">
                                    <span class="account-menu-user">{currentUsername}</span>
                                    <span class="account-menu-label"
                                        >{m.admin_logged_in_as_prefix()}</span>
                                </div>

                                <!-- Authentik group chips (identity trivia, spec §6) -->
                                <div class="account-menu-section">
                                    <span class="account-menu-heading">{m.admin_groups()}</span>
                                    {#if currentGroups.length > 0}
                                        <div class="chips">
                                            {#each currentGroups as group (group)}
                                                <span class="chip">{group}</span>
                                            {/each}
                                        </div>
                                    {:else}
                                        <span class="account-menu-muted">{m.admin_none()}</span>
                                    {/if}
                                </div>

                                <!-- Nav-style switcher (temporary here; canonical home is
                                     Settings → General, added in a later step). -->
                                <div class="account-menu-section">
                                    <span class="account-menu-heading"
                                        >{m.admin_nav_style_label()}</span>
                                    <div class="style-toggle">
                                        <button
                                            type="button"
                                            class="style-opt"
                                            class:style-opt-active={navStyle === 'sidebar'}
                                            onclick={() => void pickNavStyle('sidebar')}>
                                            {m.admin_nav_style_sidebar()}
                                        </button>
                                        <button
                                            type="button"
                                            class="style-opt"
                                            class:style-opt-active={navStyle === 'mega'}
                                            onclick={() => void pickNavStyle('mega')}>
                                            {m.admin_nav_style_mega()}
                                        </button>
                                    </div>
                                </div>

                                {#if devMode}
                                    <div class="account-menu-section">
                                        <DevModeSwitcher
                                            bind:currentUser={currentDevUser}
                                            {defaultUser}
                                            onuserChange={handleUserChange} />
                                    </div>
                                {/if}

                                <div class="account-menu-signout-wrap">
                                    {#if logoutMode === 'session'}
                                        <button
                                            type="button"
                                            class="account-menu-signout"
                                            onclick={() => void adminSignOut()}>
                                            <Icon src={ArrowRightOnRectangle} class="w-4 h-4" />
                                            {m.settings_account_sign_out()}
                                        </button>
                                    {:else}
                                        <a href={resolve('/logout')} class="account-menu-signout">
                                            <Icon src={ArrowRightOnRectangle} class="w-4 h-4" />
                                            {m.settings_account_sign_out()}
                                        </a>
                                    {/if}
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- Mobile drawer (manifest-driven, spec §6) -->
            <AdminNavDrawer {sections} open={drawerOpen} onclose={() => (drawerOpen = false)} />

            {#if navStyle === 'mega'}
                <div class="nav-mega-wrap">
                    <AdminMegaMenu {sections} />
                </div>
                <ConfigHealthBanner />
                <AdminSectionTabs {sections} />
                <NavigationProgressBar />
                {@render children?.()}
            {:else}
                <div class="admin-body">
                    <div class="admin-sidebar-slot">
                        <AdminSidebar {sections} />
                    </div>
                    <div class="admin-content">
                        <ConfigHealthBanner />
                        <!-- The expanded sidebar lists the active section's pages
                             itself; the tab row only returns on the rail. -->
                        <AdminSectionTabs {sections} sidebarExpanded={!adminNavPrefs.collapsed} />
                        <NavigationProgressBar />
                        {@render children?.()}
                    </div>
                </div>
            {/if}

            <footer
                class="mt-12 pt-6 border-t border-surface-700 text-center text-surface-500 text-sm">
                <div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                    <a
                        href="https://github.com/Sapd"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-2 hover:text-surface-300 transition-colors">
                        <svg
                            class="w-5 h-5"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true">
                            <path
                                fill-rule="evenodd"
                                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                                clip-rule="evenodd" />
                        </svg>
                        {m.admin_footer()}
                    </a>
                    <a
                        href={resolve('/admin/system/instance')}
                        class="inline-flex items-center gap-1.5 hover:text-surface-300 transition-colors">
                        {m.admin_nav_licensing()}
                    </a>
                    <button
                        type="button"
                        class="hidden sm:inline-flex items-center gap-1.5 hover:text-surface-300 transition-colors"
                        onclick={() => (showShortcuts = true)}>
                        <kbd
                            class="inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0.5 text-xs font-mono rounded bg-surface-800 border border-surface-600 text-surface-300">
                            ?
                        </kbd>
                        {m.admin_shortcuts()}
                    </button>
                    <button
                        type="button"
                        class="hidden sm:inline-flex items-center gap-1.5 hover:text-surface-300 transition-colors"
                        onclick={() => (paletteOpen = true)}>
                        <kbd
                            class="inline-flex items-center justify-center px-1 py-0.5 text-xs font-mono rounded bg-surface-800 border border-surface-600 text-surface-300">
                            {#if browser && navigator.platform?.includes('Mac')}⌘K{:else}Ctrl+K{/if}
                        </kbd>
                        {m.admin_command_palette()}
                    </button>
                </div>
            </footer>
        </div>
    </div>
{/if}

<style>
    :global(.app-layout:has(.admin-page)) {
        background-image: none !important;
        background-color: rgb(17 24 39);
    }
    .admin-page {
        background-color: rgb(17 24 39);
    }

    /* ── Compact header bar ── */
    .admin-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.25rem;
    }
    .drawer-trigger {
        display: none;
        align-items: center;
        justify-content: center;
        padding: 0.375rem;
        border: 1px solid rgb(55 65 81 / 0.5);
        border-radius: 0.5rem;
        background: rgb(55 65 81 / 0.25);
        color: rgb(209 213 219);
        cursor: pointer;
    }
    .drawer-trigger:hover {
        color: white;
        background: rgb(55 65 81 / 0.5);
    }
    .admin-app-link {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        flex-shrink: 0;
        border-radius: 0.5rem;
        color: rgb(148 163 184);
        transition:
            color 120ms ease,
            background-color 120ms ease;
    }
    .admin-app-link:hover {
        color: white;
        background: rgb(51 65 85 / 0.6);
    }
    .admin-brand {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        text-decoration: none;
        color: white;
        transition: color 120ms ease;
    }
    .admin-brand:hover {
        color: rgb(253 224 71);
    }
    .admin-brand-text {
        font-size: 1.25rem;
        font-weight: 700;
    }
    .admin-breadcrumb-slot {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        padding-left: 0.75rem;
        border-left: 1px solid rgb(55 65 81 / 0.5);
    }
    .admin-header-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-left: auto;
    }

    /* ── Account menu ── */
    .account {
        position: relative;
    }
    .account-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.5rem 0.25rem 0.25rem;
        border: 1px solid rgb(55 65 81 / 0.5);
        border-radius: 9999px;
        background: rgb(55 65 81 / 0.25);
        color: rgb(209 213 219);
        cursor: pointer;
        transition: all 120ms ease;
    }
    .account-btn:hover {
        color: white;
        background: rgb(55 65 81 / 0.5);
    }
    .avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border-radius: 9999px;
        background: rgb(234 179 8 / 0.2);
        color: rgb(250 204 21);
        font-size: 0.75rem;
        font-weight: 700;
        overflow: hidden;
    }
    .avatar-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .account-name {
        font-size: 0.8125rem;
        font-weight: 500;
        max-width: 8rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .account-backdrop {
        position: fixed;
        inset: 0;
        z-index: 60;
    }
    .account-menu {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        z-index: 61;
        width: 16rem;
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        background: rgb(31 41 55 / 0.98);
        border: 1px solid rgb(55 65 81 / 0.8);
        border-radius: 0.75rem;
        box-shadow: 0 20px 40px -8px rgb(0 0 0 / 0.5);
    }
    .account-menu-head {
        display: flex;
        flex-direction: column;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgb(55 65 81 / 0.5);
    }
    .account-menu-user {
        font-size: 0.875rem;
        font-weight: 600;
        color: white;
    }
    .account-menu-label {
        font-size: 0.6875rem;
        color: rgb(107 114 128);
    }
    .account-menu-section {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
    }
    .account-menu-heading {
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: rgb(156 163 175);
    }
    .account-menu-muted {
        font-size: 0.8125rem;
        color: rgb(107 114 128);
    }
    .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
    }
    .chip {
        display: inline-flex;
        align-items: center;
        padding: 0.125rem 0.5rem;
        border-radius: 0.375rem;
        font-size: 0.6875rem;
        font-weight: 500;
        background: rgb(6 78 59 / 0.5);
        color: rgb(110 231 183);
        border: 1px solid rgb(4 120 87 / 0.5);
    }
    .style-toggle {
        display: flex;
        gap: 0.25rem;
        padding: 0.25rem;
        background: rgb(17 24 39 / 0.6);
        border-radius: 0.5rem;
    }
    .style-opt {
        flex: 1;
        padding: 0.375rem 0.5rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: rgb(156 163 175);
        background: transparent;
        border: none;
        border-radius: 0.375rem;
        cursor: pointer;
        transition: all 120ms ease;
    }
    .style-opt:hover {
        color: rgb(229 231 235);
    }
    .style-opt-active {
        color: rgb(17 24 39);
        background: rgb(250 204 21);
    }
    .account-menu-signout-wrap {
        padding-top: 0.5rem;
        border-top: 1px solid rgb(55 65 81 / 0.5);
    }
    .account-menu-signout {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem;
        border-radius: 0.5rem;
        border: none;
        background: transparent;
        color: rgb(209 213 219);
        font-size: 0.8125rem;
        text-align: left;
        cursor: pointer;
        transition: background-color 120ms ease;
    }
    .account-menu-signout:hover {
        background-color: rgb(55 65 81 / 0.5);
        color: white;
    }

    /* ── Body layout (sidebar style) ── */
    .admin-body {
        display: flex;
        gap: 1.5rem;
        align-items: flex-start;
    }
    .admin-sidebar-slot {
        flex-shrink: 0;
        /* Full body height: the sidebar inside is position:sticky, and a sticky
           box can't leave its parent — a slot only as tall as the sidebar made it
           scroll away, leaving an empty column beside long pages. */
        align-self: stretch;
    }
    .admin-content {
        flex: 1;
        min-width: 0;
    }
    .nav-mega-wrap {
        margin-bottom: 0;
    }

    /* ── Responsive chrome (spec §6) ── */
    @media (max-width: 1023px) {
        .drawer-trigger {
            display: flex;
        }
        /* On narrow screens the sidebar is replaced by the drawer trigger. */
        .admin-sidebar-slot {
            display: none;
        }
        .admin-body {
            display: block;
        }
    }
    @media (max-width: 640px) {
        .admin-breadcrumb-slot {
            display: none;
        }
        .account-name {
            display: none;
        }
        /* At 375px the brand text plus four icon controls overflowed the
           viewport; the cog alone still links to /admin (aria-label kept). */
        .admin-brand-text {
            display: none;
        }
        .admin-header {
            gap: 0.5rem;
        }
        .admin-header-right {
            gap: 0.25rem;
        }
    }
</style>
