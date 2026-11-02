<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Account menu, opened by the avatar in the home page hero row (it used to live
  in Footer.svelte, hence the `footer_*` message keys). An account hub, not a
  second settings page:

    identity (→ Account) · what you are playing right now · the admin's links
    · Sessions & devices · My stats · Settings · Sign out

  The Dock / Stream tech info / Hide my streams / Language / Theme controls that
  used to sit here were copies of Settings → Display and Privacy; they made the
  menu 620px tall, so on a laptop Settings and Logout were scrolled out of view
  inside it. They live in Settings only now.

  Design rules:
  - ONE row shape everywhere (icon · label · trailing chevron/↗).
  - Sign out renders exactly once (custom links pointing at /logout are
    deduped against the floor).
  - The same names as /settings ("Sessions & devices", "Sign out").
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { Z } from '$lib/utils/z-index';
    import {
        Icon,
        Cog6Tooth,
        ArrowRightOnRectangle,
        DevicePhoneMobile,
        ChartBar,
        ChevronRight,
        ArrowTopRightOnSquare,
        Link,
        PlayCircle,
        type IconSource,
    } from 'svelte-hero-icons';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import * as playbackApi from '$lib/api/playback';
    import { env } from '$env/dynamic/public';
    import * as m from '$lib/paraglide/messages';
    import { resolveLogoutMode, performNativeSignOut } from './user-menu-logout';
    import type { UserMenuLink as ServerUserMenuLink } from '../../../routes/+layout.server';
    import type { StreamSession } from '$lib/schemas/api-playback-responses';

    /**
     * Persisted user-menu links carry a stable `id` (the NavigationItemEditor
     * assigns `crypto.randomUUID()` to every entry) and an OPTIONAL `url` —
     * url-less items are valid (e.g. the seeded "All Apps"/"Change Password"
     * defaults, or any custom link saved with an empty URL field). The server
     * `UserMenuLink` interface omits `id` and marks `url` required, so we widen
     * it locally to match what the editor actually persists and key the loop on
     * the stable `id` (never the optional `url`, which collides as `undefined`).
     * `label` arrives already resolved for the viewer's language (layout load).
     */
    type UserMenuLink = Omit<ServerUserMenuLink, 'url'> & {
        id?: string;
        url?: string;
    };

    interface Props {
        /** data-popup target string the trigger's use:popup points at. */
        id?: string;
        /** Avatar image URL (resolved by the trigger where the username is known). */
        avatarSrc?: string;
    }
    let { id = 'popupClick', avatarSrc = '' }: Props = $props();

    // --- page-derived flags ---
    const username = $derived($page.data?.user?.username ?? '');
    // Always show the name with a leading uppercase letter in the menu.
    const displayName = $derived(
        username ? username.charAt(0).toUpperCase() + username.slice(1) : username,
    );
    // The layout ships isAdmin/userId on the user object; the PageData type does not.
    const viewer = $derived(($page.data?.user ?? {}) as { isAdmin?: boolean; userId?: string });
    const showPersonalStats = $derived($page.data?.features?.personalStats !== false);
    const showDeviceSessions = $derived($page.data?.features?.deviceAuth !== false);
    /**
     * Custom admin links, minus any that point at /logout — the menu's
     * guaranteed floor already renders Sign out, and the seeded defaults
     * include a logout link, which used to show the action TWICE.
     */
    const userMenuLinks = $derived(
        (($page.data?.userMenuLinks as UserMenuLink[] | undefined) ?? []).filter(
            (link) => (link.url ?? '').replace(/\/+$/, '') !== '/logout',
        ),
    );

    // --- logout variant (pure helper) ---
    const logoutMode = $derived(resolveLogoutMode($page.data?.authMethod, env.PUBLIC_LOGOUTURL));

    // The actual sign-out logic lives in performNativeSignOut()
    // (user-menu-logout.ts) so it is directly importable by e2e coverage —
    // see that function's doc comment (security fix C19, 2026-09-16).
    async function nativeSignOut(): Promise<void> {
        await performNativeSignOut();
    }

    // --- what you are playing right now ---
    // Read each time the menu opens (it stays mounted while closed), so the row
    // is current without polling in the background.
    let playing = $state<StreamSession[]>([]);
    let root: HTMLDivElement | undefined = $state();

    async function loadPlaying(): Promise<void> {
        if (!viewer.userId) return;
        try {
            const result = await playbackApi.getActiveSessions('mine');
            if (result.error) return;
            playing = (result.data?.items ?? []).filter((s) => s.userId === viewer.userId);
        } catch {
            // Best-effort: the row simply stays hidden.
        }
    }

    onMount(() => {
        if (!root) return;
        const observer = new MutationObserver(() => {
            if (root?.classList.contains('popup-visible')) void loadPlaying();
        });
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    });

    // --- custom-link icons ---
    // Uses the server-resolved `page.data.navIcons` (see resolve-nav-icons.ts)
    // so every offered icon resolves without importing the full admin nav icon
    // catalog client-side.
    function isCustomIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
    }
    function getIconComponent(iconName: string | undefined): IconSource | null {
        if (!iconName) return null;
        return ($page.data.navIcons?.[iconName] as IconSource | undefined) ?? null;
    }
    function opensNewTab(link: UserMenuLink): boolean {
        return !!link.url && link.external !== false;
    }
</script>

<div
    use:bodyPortal
    bind:this={root}
    class="card p-2 bg-surface-800/90 backdrop-blur-md shadow-xl w-72 border border-surface-600/40"
    style="z-index: {Z.NAV_POPUP}"
    role="dialog"
    aria-label={m.nav_account_menu()}
    data-popup={id}>
    <!-- Identity header: the whole row is the door to account settings -->
    <a class="usermenu-row group !py-2" href={resolve('/settings/account')}>
        <Avatar src={avatarSrc} alt="" initials="-" {username} size="lg" />
        <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
                <span class="font-semibold truncate">{displayName}</span>
                {#if viewer.isAdmin}
                    <span class="badge variant-soft-primary text-[10px] px-1.5 py-0.5"
                        >{m.settings_account_role_admin()}</span>
                {/if}
            </span>
            <span
                class="block text-xs text-surface-400 group-hover:text-primary-300 transition-colors">
                {m.usermenu_manage_account()}
            </span>
        </span>
        <Icon src={ChevronRight} class="w-4 h-4 text-surface-500 shrink-0" />
    </a>

    <!-- What this person is playing right now, anywhere -->
    {#if playing.length > 0}
        <div class="usermenu-divider"></div>
        <a class="usermenu-row" href={resolve('/settings/sessions')}>
            <Icon src={PlayCircle} class="w-4 h-4 text-primary-400 shrink-0" />
            <span class="min-w-0 flex-1 text-sm">
                <span class="block text-[11px] text-surface-400">{m.usermenu_now_playing()}</span>
                <span class="block truncate">{playing[0].title}</span>
            </span>
            {#if playing.length > 1}
                <span class="text-xs text-surface-400 shrink-0"
                    >{m.usermenu_now_playing_more({ count: playing.length - 1 })}</span>
            {/if}
            <Icon src={ChevronRight} class="w-4 h-4 text-surface-500 shrink-0" />
        </a>
    {/if}

    <!-- Custom admin links (USER_MENU_LINKS) as regular menu rows -->
    {#if userMenuLinks.length > 0}
        <div class="usermenu-divider"></div>
        {#each userMenuLinks as link, i (link.id ?? link.url ?? i)}
            <a
                class="usermenu-row"
                class:pointer-events-none={!link.url}
                class:opacity-50={!link.url}
                aria-disabled={!link.url ? 'true' : undefined}
                href={link.url ? resolve(link.url) : undefined}
                target={opensNewTab(link) ? '_blank' : undefined}
                rel={opensNewTab(link) ? 'noopener noreferrer' : undefined}>
                {#if isCustomIconPath(link.icon)}
                    <img src={link.icon} alt="" class="w-4 h-4" loading="eager" decoding="async" />
                {:else if getIconComponent(link.icon)}
                    <Icon src={getIconComponent(link.icon)!} class="w-4 h-4 text-surface-400" />
                {:else}
                    <!-- No gear fallback: it made an unconfigured link look like a
                         second "Settings". -->
                    <Icon src={Link} class="w-4 h-4 text-surface-400" />
                {/if}
                <span class="min-w-0 flex-1 truncate text-sm">{link.label}</span>
                {#if opensNewTab(link)}
                    <Icon
                        src={ArrowTopRightOnSquare}
                        class="w-3.5 h-3.5 text-surface-500 shrink-0" />
                    <span class="sr-only">{m.usermenu_opens_new_tab()}</span>
                {/if}
            </a>
        {/each}
    {/if}

    <!-- Your own pages + the guaranteed floor (Settings + Sign out, once) -->
    <div class="usermenu-divider"></div>
    {#if showDeviceSessions}
        <a class="usermenu-row" href={resolve('/settings/sessions')}>
            <Icon src={DevicePhoneMobile} class="w-4 h-4 text-surface-400" />
            <span class="min-w-0 flex-1 text-sm">{m.settings_section_sessions()}</span>
            <Icon src={ChevronRight} class="w-4 h-4 text-surface-500" />
        </a>
    {/if}
    {#if showPersonalStats}
        <a class="usermenu-row" href={resolve('/my-stats')}>
            <Icon src={ChartBar} class="w-4 h-4 text-surface-400" />
            <span class="min-w-0 flex-1 text-sm">{m.footer_my_stats()}</span>
            <Icon src={ChevronRight} class="w-4 h-4 text-surface-500" />
        </a>
    {/if}
    <a class="usermenu-row" href={resolve('/settings')}>
        <Icon src={Cog6Tooth} class="w-4 h-4 text-surface-400" />
        <span class="min-w-0 flex-1 text-sm">{m.footer_settings()}</span>
        <Icon src={ChevronRight} class="w-4 h-4 text-surface-500" />
    </a>
    {#if logoutMode === 'session'}
        <button class="usermenu-row w-full text-left" onclick={nativeSignOut}>
            <Icon src={ArrowRightOnRectangle} class="w-4 h-4 text-surface-400" />
            <span class="min-w-0 flex-1 text-sm">{m.settings_account_sign_out()}</span>
        </button>
    {:else}
        <!-- forward + fallback both anchor /logout; NOT error-red (routine) -->
        <a class="usermenu-row" href={resolve('/logout')}>
            <Icon src={ArrowRightOnRectangle} class="w-4 h-4 text-surface-400" />
            <span class="min-w-0 flex-1 text-sm">{m.settings_account_sign_out()}</span>
        </a>
    {/if}
</div>

<style lang="postcss">
    /* One row shape for every entry: icon · label · trailing control.
       Interactive rows (links/buttons) get the hover wash; rows hosting
       their own control (toggles/selects) opt out via cursor-default. */
    .usermenu-row {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.5rem;
        border-radius: 0.5rem;
        min-height: 2.25rem;
    }
    a.usermenu-row:hover,
    button.usermenu-row:hover {
        background-color: rgb(var(--color-surface-600-rgb) / 0.35);
    }
    a.usermenu-row:focus-visible,
    button.usermenu-row:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: -2px;
    }
    .usermenu-divider {
        height: 1px;
        margin: 0.375rem 0.5rem;
        background-color: rgb(var(--color-surface-500-rgb) / 0.3);
    }
</style>
