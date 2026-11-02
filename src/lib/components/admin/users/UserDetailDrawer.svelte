<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminUserEmailSchema } from '$lib/schemas/admin-user.js';
    import { getAvatarUrl } from '$lib/utils/image-utils.js';
    import { Z } from '$lib/utils/z-index';
    // Z.MODAL / Z.MODAL + 1 (backdrop / panel): Tailwind z-40/z-50 sat below the
    // fixed navbar (Z.NAVBAR = 500), whose bell covered and swallowed the close button.
    import { onMount, untrack } from 'svelte';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { toasts } from '$lib/stores/toast.store';
    import AvatarUploadPopover from '$lib/components/ui/AvatarUploadPopover.svelte';
    import { needsLoginAttention, loginMethods } from './user-directory';
    import { fade, fly } from 'svelte/transition';
    import {
        Icon,
        ChartBar,
        Link,
        AdjustmentsHorizontal,
        CommandLine,
        Key,
        ArrowDownTray,
        ArrowPath,
        ChevronDown,
        FingerPrint,
        NoSymbol,
        CheckCircle,
        Trash,
        XCircle,
        XMark,
        type IconSource,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';
    import type { DrawerSection } from './user-directory';

    import { resolve } from '$lib/paths';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import IdentitiesModal from '$lib/components/admin/IdentitiesModal.svelte';
    import AdminConnectionsModal from '$lib/components/admin/AdminConnectionsModal.svelte';
    import StreamPolicyModal from '$lib/components/admin/StreamPolicyModal.svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { page } from '$app/state';
    import AdminUserSimpleMode from '$lib/components/livetv/simple/AdminUserSimpleMode.svelte';

    interface Props {
        user: LocalUser;
        currentUsername?: string;
        quickConnectEnabled?: boolean;
        togglingAdmin: Set<string>;
        updatingPrivacy: Set<string>;
        updatingAgeRating: Set<string>;
        updatingDisabled: Set<string>;
        deletingUser: Set<string>;
        /** Active library titles without an age rating (null: not loaded). */
        unratedTitles?: { unrated: number; total: number } | null;
        /** UNRATED_CONTENT_VISIBLE: unrated titles are shown to age-limited users. */
        unratedContentVisible?: boolean;
        formatDate: (dateStr: string | null | undefined) => string;
        onToggleAdmin: (username: string, currentIsAdmin: boolean) => void;
        onUnpinAdmin: (username: string) => void;
        /** Resolves false when the save failed, so the field can roll back. */
        onSetAgeRating: (
            username: string,
            maxAge: number | null,
        ) => void | boolean | Promise<boolean | void>;
        onUnpinAgeRating: (username: string) => void;
        onSetAllowLiveTv?: (username: string, allowed: boolean) => Promise<boolean>;
        /** Resolves false when the save failed, so the switch can roll back. */
        onTogglePrivacy: (
            username: string,
            currentValue: boolean,
        ) => void | boolean | Promise<boolean | void>;
        onClearUserData: (username: string) => void;
        /** Shows the Jellyfin mapping editor inside the Identities panel. */
        jellyfinSyncEnabled?: boolean;
        onOpenQuickConnect: (username: string) => void;
        onRefreshWatchState?: (username: string) => void;
        onResetPassword?: (username: string) => void;
        onSetDisabled?: (username: string, disabled: boolean) => void;
        onDeleteUser?: (username: string) => void;
        onSetEmail?: (username: string, email: string) => Promise<boolean>;
        onClose: () => void;
        /** Open section, mirrored into the URL (`&tab=`) by the page. */
        section?: DrawerSection;
        onSectionChange?: (section: DrawerSection) => void;
    }

    let {
        user,
        currentUsername,
        quickConnectEnabled = true,
        togglingAdmin,
        updatingPrivacy,
        updatingAgeRating,
        updatingDisabled,
        deletingUser,
        unratedTitles = null,
        unratedContentVisible = false,
        formatDate,
        onToggleAdmin,
        onUnpinAdmin,
        onSetAgeRating,
        onUnpinAgeRating,
        onSetAllowLiveTv,
        onTogglePrivacy,
        onClearUserData,
        jellyfinSyncEnabled = false,
        onOpenQuickConnect,
        onRefreshWatchState,
        onResetPassword,
        onSetDisabled,
        onDeleteUser,
        onSetEmail,
        onClose,
        section: initialSection = 'overview',
        onSectionChange,
    }: Props = $props();

    let emailInput = $derived(user.email ?? '');
    let emailSaving = $state(false);
    let emailError = $state(false);
    let emailValid = $derived(AdminUserEmailSchema.safeParse(emailInput).success);
    async function saveEmail(): Promise<void> {
        if (!onSetEmail || !emailValid || emailSaving) return;
        emailSaving = true;
        emailError = false;
        try {
            emailError = !(await onSetEmail(user.username, emailInput));
        } catch {
            emailError = true;
        } finally {
            emailSaving = false;
        }
    }

    // Forward-auth can hand the session a differently-cased username.
    let isSelf = $derived(
        currentUsername != null && user.username.toLowerCase() === currentUsername.toLowerCase(),
    );
    /**
     * Where an unpinned role/age value comes from. "From identity provider
     * groups" read as a contradiction next to "No groups", so a group-less
     * account says it is on the defaults instead.
     */
    function sourceLabel(pinned: boolean): string {
        if (pinned) return m.users_directory_manual();
        return user.groups?.length ? m.users_directory_idp() : m.users_directory_default_role();
    }
    // Seeded from the URL once; after that the drawer owns it and reports changes.
    let section = $state<DrawerSection>(untrack(() => initialSection));
    function selectSection(next: DrawerSection): void {
        section = next;
        onSectionChange?.(next);
    }
    // Live TV simple mode tab, only where Live TV exists.
    let liveTvEnabled = $derived(page.data.features?.liveTV === true);
    // WAI-ARIA tabs: one tab stop, arrows/Home/End move between sections.
    const tabIdBase = $props.id();
    const tabs = $derived([
        { key: 'overview' as const, label: m.users_directory_overview() },
        { key: 'access' as const, label: m.users_directory_access() },
        { key: 'activity' as const, label: m.users_directory_activity() },
        ...(liveTvEnabled ? [{ key: 'livetv' as const, label: m.livetv_simple_admin_tab() }] : []),
    ]);
    function onTabKeydown(event: KeyboardEvent): void {
        const index = tabs.findIndex((tab) => tab.key === section);
        const next =
            event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index - 1 + tabs.length) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
        if (next < 0) return;
        event.preventDefault();
        selectSection(tabs[next].key);
        document.getElementById(`${tabIdBase}-tab-${section}`)?.focus();
    }
    // Access-tab panels. They used to be dialogs stacked on top of this drawer;
    // now they expand in place and load their data only when first opened.
    type Panel = 'identities' | 'connections' | 'streamPolicy';
    const openPanels = new SvelteSet<Panel>();
    function togglePanel(panel: Panel): void {
        if (openPanels.has(panel)) openPanels.delete(panel);
        else openPanels.add(panel);
    }
    function openConnections(): void {
        openPanels.add('connections');
        selectSection('access');
    }

    let showAvatar = $state(false);
    let avatarVersion = $state(Date.now());
    let aiExpanded = $state(false);
    onMount(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    });
    async function copy(value: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(value);
            toasts.success(m.users_directory_copied());
        } catch {
            toasts.error(m.users_directory_copy_failed());
        }
    }

    /** Editable age value; resets whenever the server-confirmed prop changes. */
    let ageInput: number | null | undefined = $derived(user.maxAgeRating);
    let ageInvalid = $derived(
        ageInput != null && (!Number.isInteger(ageInput) || ageInput < 0 || ageInput > 21),
    );

    async function submitAge(): Promise<void> {
        // Enter saves, and the blur that follows must not send a second PATCH.
        if (updatingAgeRating.has(user.username)) return;
        // `<input type="number">` binds a number, or null when the field is empty.
        const value = ageInput == null ? null : ageInput;
        if (value !== null && (!Number.isInteger(value) || value < 0 || value > 21)) return;
        if (value !== user.maxAgeRating) {
            const target = user;
            const ok = await onSetAgeRating(target.username, value);
            // A failed save leaves the prop unchanged, so the $derived would
            // keep showing the rejected value as if it had been applied.
            if (ok === false && user.username === target.username) ageInput = user.maxAgeRating;
        }
    }

    // Toggle flips its own `checked` before onchange; remount it after a
    // failed save so it shows the server value again.
    let privacyToggleRevision = $state(0);
    async function togglePrivacy(): Promise<void> {
        const ok = await onTogglePrivacy(user.username, user.hideStreams);
        if (ok === false) privacyToggleRevision++;
    }

    let savingLiveTv = $state(false);
    let liveTvToggleRevision = $state(0);
    async function toggleLiveTv(): Promise<void> {
        savingLiveTv = true;
        try {
            await onSetAllowLiveTv?.(user.username, user.allowLiveTv === false);
        } finally {
            savingLiveTv = false;
            liveTvToggleRevision++;
        }
    }

    function handleAgeKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            void submitAge();
        } else if (e.key === 'Escape') {
            ageInput = user.maxAgeRating;
            (e.currentTarget as HTMLInputElement).blur();
            e.stopPropagation();
        }
    }

    function handleWindowKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && !e.defaultPrevented) {
            e.stopPropagation();
            if (showAvatar) showAvatar = false;
            else onClose();
        }
    }

    // List-row button styling for the Account section.
    const rowBtn =
        'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-surface-200 transition-colors hover:bg-surface-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

    const chip = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0';
    const avatarSrc = $derived(getAvatarUrl(user.id, { version: avatarVersion }));
</script>

{#snippet panelToggle(panel: Panel, icon: IconSource, label: string, description: string)}
    <button
        type="button"
        class={rowBtn}
        aria-expanded={openPanels.has(panel)}
        onclick={() => togglePanel(panel)}>
        <Icon src={icon} class="h-4 w-4 shrink-0" />
        {@render rowLabel(label, description)}
        <Icon
            src={ChevronDown}
            class="ml-auto h-4 w-4 shrink-0 text-surface-400 transition-transform {openPanels.has(
                panel,
            )
                ? 'rotate-180'
                : ''}" />
    </button>
{/snippet}

{#snippet rowLabel(label: string, description: string)}
    <span class="flex min-w-0 flex-col text-left">
        <span>{label}</span>
        <span class="text-xs text-surface-400">{description}</span>
    </span>
{/snippet}

<!-- Backdrop -->
<button
    class="fixed inset-0 bg-black/60 backdrop-blur-sm"
    style="z-index: {Z.MODAL}"
    tabindex="-1"
    aria-label={m.admin_users_drawer_close()}
    onclick={onClose}
    transition:fade={{ duration: 120 }}></button>
<div
    style="z-index: {Z.MODAL + 1}"
    class="fixed inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-surface-700 bg-surface-900 shadow-2xl focus:outline-hidden"
    role="dialog"
    aria-modal="true"
    aria-label={m.admin_users_open_details({ username: user.username })}
    tabindex="-1"
    use:trapFocus
    onkeydown={handleWindowKeydown}
    transition:fly={{ x: 32, duration: 160 }}>
    <header class="border-b border-surface-700 bg-surface-800/40 px-5 py-6 sm:px-7">
        <div class="flex items-start gap-4">
            <div class="relative">
                <button
                    class="rounded-full focus-visible:ring-2 focus-visible:ring-primary-400"
                    aria-label={m.users_directory_avatar()}
                    onclick={() => {
                        showAvatar = !showAvatar;
                    }}>
                    <Avatar
                        src={avatarSrc}
                        alt=""
                        username={user.username}
                        loading="eager"
                        size="lg" />
                </button>
                {#if showAvatar}
                    <div class="absolute left-0 top-full z-10 mt-2">
                        <AvatarUploadPopover
                            username={user.username}
                            onClose={() => {
                                showAvatar = false;
                            }}
                            onSuccess={() => {
                                showAvatar = false;
                                avatarVersion++;
                            }} />
                    </div>
                {/if}
            </div>
            <div class="min-w-0 flex-1">
                <h2 class="truncate text-xl font-semibold text-white">
                    {user.displayName || user.username}
                </h2>
                <p class="mt-1 truncate text-sm text-surface-400">{user.email || user.username}</p>
                <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span
                        class="{chip} {user.disabled
                            ? 'bg-red-500/10 text-red-300'
                            : 'bg-surface-700 text-surface-300'}"
                        >{user.disabled
                            ? m.admin_users_filter_disabled()
                            : m.users_directory_enabled()}</span>
                    <span class="text-surface-400"
                        >{user.isAdmin
                            ? m.admin_users_administrator()
                            : m.users_directory_member()}</span>
                    {#if isSelf}<span class="text-surface-500">· {m.users_directory_you()}</span
                        >{/if}
                </div>
            </div>
            <button
                class="rounded-lg p-2 text-surface-400 hover:bg-surface-700 hover:text-white"
                data-autofocus
                aria-label={m.admin_users_drawer_close()}
                onclick={onClose}><Icon src={XMark} class="h-5 w-5" /></button>
        </div>
    </header>
    <div
        class="flex gap-1 border-b border-surface-700 px-5 sm:px-7"
        role="tablist"
        tabindex="-1"
        aria-label={m.users_directory_account()}
        onkeydown={onTabKeydown}>
        {#each tabs as tab (tab.key)}
            <button
                type="button"
                id="{tabIdBase}-tab-{tab.key}"
                role="tab"
                aria-selected={section === tab.key}
                aria-controls="{tabIdBase}-panel"
                tabindex={section === tab.key ? 0 : -1}
                class="border-b-2 px-3 py-4 text-sm font-medium {section === tab.key
                    ? 'border-primary-400 text-primary-200'
                    : 'border-transparent text-surface-400 hover:text-white'}"
                onclick={() => selectSection(tab.key)}>
                {tab.label}
            </button>
        {/each}
    </div>
    <div
        id="{tabIdBase}-panel"
        role="tabpanel"
        aria-labelledby="{tabIdBase}-tab-{section}"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {#if needsLoginAttention(user)}
            <div class="mx-5 mt-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:mx-7">
                <p class="text-sm font-medium text-amber-200">{m.users_directory_attention()}</p>
                <p class="mt-1 text-sm text-surface-300">{m.users_directory_attention_hint()}</p>
                {#if section !== 'access'}<button
                        class="mt-3 text-sm font-medium text-amber-200 underline underline-offset-4"
                        onclick={() => selectSection('access')}
                        >{m.users_directory_access()} →</button
                    >{/if}
            </div>
        {/if}
        {#if section === 'overview'}
            <section class="space-y-5 p-5 sm:p-7">
                <h3 class="font-medium text-white">{m.users_directory_account()}</h3>
                <dl class="grid grid-cols-1 gap-5 text-sm sm:grid-cols-2">
                    <div>
                        <dt class="text-surface-500">{m.setup_label_username()}</dt>
                        <dd class="mt-1 break-all text-surface-200">{user.username}</dd>
                    </div>
                    <div>
                        <dt class="text-surface-500">{m.users_directory_login()}</dt>
                        <dd class="mt-1 text-surface-200">{loginMethods(user)}</dd>
                    </div>
                    <div>
                        <dt class="text-surface-500">{m.users_directory_role()}</dt>
                        <dd class="mt-1 text-surface-200">
                            {user.isAdmin
                                ? m.admin_users_administrator()
                                : m.users_directory_member()}<span
                                class="mt-1 block text-xs text-surface-400"
                                >{sourceLabel(user.adminPinned)}</span>
                        </dd>
                    </div>
                    <div>
                        <dt class="text-surface-500">{m.admin_users_col_age_limit()}</dt>
                        <dd class="mt-1 text-surface-200">
                            {user.maxAgeRating === null
                                ? m.users_directory_unrestricted()
                                : m.admin_users_age_value({ age: user.maxAgeRating })}
                        </dd>
                    </div>
                </dl>
                <!--
                    Two different clocks, labelled as such: last_seen_at is a
                    Lumastra sign-in, while the directory's Activity column is
                    playback — which for Jellyfin-only users is mirrored from the
                    upstream server and never touches last_seen_at.
                -->
                <p class="text-xs text-surface-400">
                    {m.admin_users_drawer_member_since({ date: formatDate(user.createdAt) })} · {user.lastSeenAt
                        ? m.admin_users_drawer_last_sign_in({ when: formatDate(user.lastSeenAt) })
                        : m.admin_users_drawer_never_signed_in()}{#if user.currentlyStreaming}
                        · <span class="text-emerald-300">{m.users_directory_streaming()}</span
                        >{:else if user.lastActivityAt}
                        · {m.admin_users_drawer_last_activity({
                            when: formatDate(user.lastActivityAt),
                        })}{#if user.lastActivitySource === 'jellyfin'}
                            ({m.users_directory_via_jellyfin()}){/if}{/if}
                </p>
                <div class="flex flex-wrap gap-2">
                    <button class="btn btn-surface text-xs" onclick={() => void copy(user.username)}
                        >{m.users_directory_copy_username()}</button>
                    {#if user.email}<button
                            class="btn btn-surface text-xs"
                            onclick={() => void copy(user.email ?? '')}
                            >{m.users_directory_copy_email()}</button
                        >{/if}
                </div>
                <button class={rowBtn} onclick={openConnections}>
                    <Icon src={Link} class="h-4 w-4 shrink-0" />
                    {@render rowLabel(m.admin_conn_nav(), m.admin_conn_nav_desc())}
                </button>
            </section>
            <!-- Privacy -->
            <section class="border-b border-surface-700/60 p-5">
                <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">
                    {m.admin_users_drawer_section_privacy()}
                </h3>
                <div class="flex items-center justify-between gap-3">
                    <div>
                        <div class="text-sm text-surface-200">
                            {m.admin_users_drawer_hide_streams_label()}
                        </div>
                        <div class="text-xs text-surface-500">
                            {m.admin_users_drawer_hide_streams_desc()}
                        </div>
                    </div>
                    {#key privacyToggleRevision}
                        <Toggle
                            checked={user.hideStreams}
                            disabled={updatingPrivacy.has(user.username)}
                            size="sm"
                            label={m.admin_users_drawer_hide_streams_label()}
                            onchange={() => void togglePrivacy()} />
                    {/key}
                </div>
            </section>
            <details class="border-t border-surface-700" bind:open={aiExpanded}>
                <summary class="cursor-pointer px-5 py-4 text-sm text-surface-300"
                    >{m.admin_users_drawer_section_ai()}</summary>
                <!-- AI & ratings -->
                {#if aiExpanded}
                    <section class="border-b border-surface-700/60 p-5">
                        <h3
                            class="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">
                            {m.admin_users_drawer_section_ai()}
                        </h3>
                        <div class="space-y-2 text-sm">
                            <div class="flex items-baseline justify-between gap-3">
                                <span class="text-surface-500"
                                    >{m.admin_users_drawer_ai_profile()}</span>
                                {#if user.hasProfile}
                                    <span class="text-emerald-300">
                                        {m.admin_users_drawer_ai_profile_active()}
                                    </span>
                                {:else}
                                    <span class="text-surface-400">
                                        {m.admin_users_drawer_ai_profile_none()}
                                    </span>
                                {/if}
                            </div>
                            {#if user.totalRatings != null}
                                <div class="flex items-baseline justify-between gap-3">
                                    <span class="text-surface-500">
                                        {m.admin_users_drawer_total_ratings()}
                                    </span>
                                    <span class="text-surface-200">{user.totalRatings}</span>
                                </div>
                            {/if}
                            {#if user.activeSuggestions != null}
                                <div class="flex items-baseline justify-between gap-3">
                                    <span class="text-surface-500">
                                        {m.admin_users_drawer_active_suggestions()}
                                    </span>
                                    <span class="text-surface-200">{user.activeSuggestions}</span>
                                </div>
                            {/if}
                        </div>
                        {#if user.hasProfile != null}
                            <div class="mt-3 -mx-3">
                                <button
                                    class={rowBtn}
                                    onclick={() => onClearUserData(user.username)}>
                                    <Icon src={XCircle} class="w-4 h-4 text-surface-400" />
                                    {m.admin_users_action_clear_ai()}
                                </button>
                            </div>
                        {/if}
                    </section>
                {/if}
            </details>
        {:else if section === 'access'}
            <section class="border-b border-surface-700/60 p-5 sm:p-7">
                <h3 class="mb-4 font-medium text-white">{m.users_directory_login()}</h3>
                <p class="text-sm text-surface-300">{loginMethods(user)}</p>
                {#if onSetEmail}
                    <div class="mt-4 space-y-2">
                        <label class="block" for="user-matching-email"
                            >{m.admin_users_email_label()}</label>
                        <input
                            id="user-matching-email"
                            type="email"
                            autocomplete="off"
                            bind:value={emailInput}
                            class="w-full rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-white"
                            disabled={emailSaving}
                            aria-invalid={!emailValid}
                            aria-describedby="user-email-hint" />
                        <p id="user-email-hint" class="text-xs text-surface-400">
                            {m.admin_users_email_hint()}
                        </p>
                        {#if !emailValid}<p role="alert" class="text-sm text-red-300">
                                {m.admin_users_email_invalid()}
                            </p>{/if}
                        {#if emailError}<p role="alert" class="text-sm text-red-300">
                                {m.admin_users_email_save_failed()}
                            </p>{/if}
                        <button
                            class="btn btn-surface"
                            disabled={emailSaving || !emailValid}
                            onclick={() => void saveEmail()}>{m.admin_users_email_save()}</button>
                    </div>
                {/if}
                <div class="mt-3 flex flex-wrap gap-2">
                    {#if onResetPassword}
                        <button
                            class="btn btn-surface"
                            onclick={() => onResetPassword?.(user.username)}>
                            <Icon src={Key} class="h-4 w-4" />{user.hasNativePassword
                                ? m.admin_users_reset_password()
                                : m.admin_users_set_password()}
                        </button>
                    {/if}
                </div>
                <div class="-mx-3 mt-3">
                    {@render panelToggle(
                        'identities',
                        FingerPrint,
                        m.admin_users_action_identities(),
                        m.admin_users_identities_desc(),
                    )}
                </div>
                {#if openPanels.has('identities')}
                    <div class="mt-2">
                        <IdentitiesModal
                            inline
                            username={user.username}
                            {formatDate}
                            {jellyfinSyncEnabled}
                            hasNativePassword={user.hasNativePassword}
                            identityProviders={user.identityProviders ?? []}
                            onclose={() => openPanels.delete('identities')} />
                    </div>
                {/if}
                <div class="-mx-3 mt-1">
                    {@render panelToggle(
                        'connections',
                        Link,
                        m.admin_conn_nav(),
                        m.admin_conn_nav_desc(),
                    )}
                </div>
                {#if openPanels.has('connections')}
                    <div class="mt-2">
                        <AdminConnectionsModal
                            inline
                            username={user.username}
                            userId={user.id}
                            {formatDate}
                            onclose={() => openPanels.delete('connections')} />
                    </div>
                {/if}
            </section>
            <section class="space-y-6 border-b border-surface-700/60 p-5 sm:p-7">
                <div>
                    <div
                        class="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center sm:gap-5">
                        <div>
                            <h3 class="font-medium text-white">
                                {m.admin_users_drawer_admin_label()}
                            </h3>
                            <p class="mt-1 text-sm text-surface-400">
                                {sourceLabel(user.adminPinned)}
                            </p>
                            {#if !user.adminPinned && !isSelf}<p
                                    class="mt-1 text-xs text-surface-500">
                                    {m.users_directory_override_hint()}
                                </p>{/if}
                        </div>
                        <button
                            class="btn btn-surface"
                            disabled={isSelf || togglingAdmin.has(user.username)}
                            onclick={() => onToggleAdmin(user.username, user.isAdmin)}>
                            {user.isAdmin ? m.users_directory_revoke() : m.users_directory_grant()}
                        </button>
                    </div>
                    {#if user.adminPinned && !isSelf}<button
                            class="mt-3 text-xs text-primary-300 underline underline-offset-4"
                            disabled={togglingAdmin.has(user.username)}
                            onclick={() => onUnpinAdmin(user.username)}
                            >{m.users_directory_return_idp()}</button
                        >{/if}
                </div>
                <div>
                    <label for="user-age-limit" class="font-medium text-white"
                        >{m.admin_users_drawer_age_label()}</label>
                    <p id="user-age-hint" class="mt-1 text-sm text-surface-400">
                        {m.users_directory_age_hint()}
                    </p>
                    <div id="user-age-scope-hints" class="mt-2 space-y-1 text-xs text-surface-400">
                        <p>{m.admin_users_age_unrated_hint()}</p>
                        {#if unratedTitles && unratedTitles.unrated > 0}
                            <p data-testid="unrated-title-count">
                                {unratedContentVisible
                                    ? m.admin_users_age_unrated_count_visible({
                                          unrated: unratedTitles.unrated,
                                          total: unratedTitles.total,
                                      })
                                    : m.admin_users_age_unrated_count_hidden({
                                          unrated: unratedTitles.unrated,
                                          total: unratedTitles.total,
                                      })}
                            </p>
                        {/if}
                        <p>{m.admin_users_age_livetv_hint()}</p>
                        <p>{m.admin_users_age_libraries_hint()}</p>
                    </div>
                    <input
                        id="user-age-limit"
                        type="number"
                        min="0"
                        max="21"
                        step="1"
                        placeholder="—"
                        class="mt-3 w-24 rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-white"
                        aria-describedby="user-age-hint user-age-scope-hints"
                        aria-invalid={ageInvalid}
                        bind:value={ageInput}
                        onblur={() => void submitAge()}
                        onkeydown={handleAgeKeydown}
                        disabled={updatingAgeRating.has(user.username)} />
                    {#if ageInvalid}<p class="mt-2 text-sm text-red-300" role="alert">
                            {m.users_directory_age_invalid()}
                        </p>{/if}
                    <p class="mt-2 text-xs text-surface-400">
                        {sourceLabel(user.ageRatingPinned)}
                    </p>
                    {#if !user.ageRatingPinned}<p class="mt-1 text-xs text-surface-500">
                            {m.users_directory_override_hint()}
                        </p>{/if}
                    {#if user.ageRatingPinned}<button
                            class="mt-2 text-xs text-primary-300 underline underline-offset-4"
                            disabled={updatingAgeRating.has(user.username)}
                            onclick={() => onUnpinAgeRating(user.username)}
                            >{m.users_directory_return_idp()}</button
                        >{/if}
                </div>
                <div class="flex items-center justify-between gap-3">
                    <div>
                        <div class="font-medium text-white">{m.admin_users_allow_live_tv()}</div>
                        <p class="mt-1 text-sm text-surface-400">
                            {user.maxAgeRating !== null &&
                            user.liveTvDefault !== false &&
                            user.allowLiveTv !== false
                                ? m.admin_users_live_tv_age_hint()
                                : m.admin_users_live_tv_help()}
                        </p>
                    </div>
                    {#key `${user.username}:${liveTvToggleRevision}`}
                        <Toggle
                            checked={user.allowLiveTv !== false}
                            disabled={savingLiveTv}
                            size="sm"
                            label={m.admin_users_allow_live_tv()}
                            onchange={() => void toggleLiveTv()} />
                    {/key}
                </div>
                <div>
                    <h3 class="font-medium text-white">{m.admin_users_col_groups()}</h3>
                    <div class="mt-3 flex flex-wrap gap-2">
                        {#each user.groups ?? [] as group (group)}<span
                                class="max-w-full break-all rounded-md bg-surface-800 px-2 py-1 text-xs text-surface-300"
                                >{group}</span>
                        {:else}<p class="text-sm text-surface-400">
                                {m.admin_users_drawer_no_groups()}
                            </p>{/each}
                    </div>
                </div>
            </section>
            <section class="border-b border-surface-700/60 p-5 sm:p-7">
                <h3 class="mb-3 font-medium text-white">
                    {m.admin_users_drawer_section_account()}
                </h3>
                <div class="-mx-3">
                    {@render panelToggle(
                        'streamPolicy',
                        AdjustmentsHorizontal,
                        m.admin_users_action_stream_policy(),
                        m.admin_users_action_stream_policy_desc(),
                    )}
                </div>
                {#if openPanels.has('streamPolicy')}
                    <div class="mb-2 mt-2">
                        <StreamPolicyModal
                            inline
                            username={user.username}
                            onclose={() => openPanels.delete('streamPolicy')} />
                    </div>
                {/if}
                {#if quickConnectEnabled}<button
                        class={rowBtn}
                        onclick={() => onOpenQuickConnect(user.username)}
                        ><Icon src={CommandLine} class="h-4 w-4 shrink-0" />
                        {@render rowLabel(
                            m.admin_users_action_quick_connect(),
                            m.admin_users_action_quick_connect_desc(),
                        )}</button
                    >{/if}
                {#if onRefreshWatchState}<button
                        class={rowBtn}
                        onclick={() => onRefreshWatchState?.(user.username)}
                        ><Icon src={ArrowPath} class="h-4 w-4 shrink-0" />
                        {@render rowLabel(
                            m.admin_users_action_refresh(),
                            m.admin_users_action_refresh_desc(),
                        )}</button
                    >{/if}
                <a
                    class={rowBtn}
                    href={resolve(
                        `/api/admin/users/${encodeURIComponent(user.username)}/gdpr-export`,
                    )}
                    ><Icon src={ArrowDownTray} class="h-4 w-4 shrink-0" />
                    {@render rowLabel(
                        m.admin_users_action_export_data(),
                        m.admin_users_action_export_data_desc(),
                    )}</a>
            </section>
            <!-- Danger zone -->
            {#if !isSelf && (onSetDisabled || onDeleteUser)}
                <section class="p-5">
                    <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-red-400/80">
                        {m.admin_users_drawer_section_danger()}
                    </h3>
                    <div class="flex flex-col gap-0.5 -mx-3">
                        {#if onSetDisabled}
                            <button
                                class="{rowBtn} {user.disabled
                                    ? ''
                                    : 'text-red-300 hover:bg-red-900/30 hover:text-red-200'}"
                                disabled={updatingDisabled.has(user.username)}
                                onclick={() => onSetDisabled?.(user.username, user.disabled)}>
                                <Icon
                                    src={user.disabled ? CheckCircle : NoSymbol}
                                    class="w-4 h-4 {user.disabled
                                        ? 'text-surface-400'
                                        : 'text-red-400'}" />
                                {user.disabled
                                    ? m.admin_users_action_enable()
                                    : m.admin_users_action_disable()}
                            </button>
                        {/if}
                        {#if onDeleteUser}
                            <button
                                class="{rowBtn} text-red-300 hover:bg-red-900/30 hover:text-red-200"
                                disabled={deletingUser.has(user.username)}
                                onclick={() => onDeleteUser?.(user.username)}>
                                <Icon src={Trash} class="w-4 h-4 text-red-400" />
                                {m.admin_users_action_delete()}
                            </button>
                        {/if}
                    </div>
                </section>
            {/if}
        {:else if section === 'activity'}
            <!-- Activity -->
            <section class="border-b border-surface-700/60 p-5">
                <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-500">
                    {m.admin_users_drawer_section_activity()}
                </h3>
                <div class="space-y-2 text-sm">
                    {#if !user.lastActivityAt && !user.lastWatchedTitle && !user.currentlyStreaming}
                        <p class="text-surface-400">{m.users_directory_no_activity()}</p>
                    {/if}
                    {#if user.currentlyStreaming}
                        <div class="flex items-center gap-2 text-emerald-300">
                            <span
                                class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
                            ></span>
                            {m.admin_users_filter_streaming()}
                        </div>
                    {/if}
                    {#if user.lastWatchedTitle}
                        <div class="flex items-baseline justify-between gap-3">
                            <span class="text-surface-500">
                                {m.admin_users_drawer_last_watched()}
                            </span>
                            <span class="text-surface-200 truncate" title={user.lastWatchedTitle}>
                                {user.lastWatchedTitle}
                            </span>
                        </div>
                    {/if}
                    {#if user.lastActivityAt}
                        <div class="flex items-baseline justify-between gap-3">
                            <span class="text-surface-500">{m.admin_users_col_activity()}</span>
                            <span class="text-surface-200"
                                >{formatDate(
                                    user.lastActivityAt,
                                )}{#if user.lastActivitySource === 'jellyfin'}
                                    · {m.users_directory_via_jellyfin()}{/if}</span>
                        </div>
                    {/if}
                </div>
                <div class="mt-3 flex flex-col gap-0.5 -mx-3">
                    <a class={rowBtn} href={resolve(`/stats/${user.username}`)}>
                        <Icon src={ChartBar} class="w-4 h-4 text-surface-400" />
                        {m.admin_users_drawer_view_stats()}
                    </a>
                </div>
            </section>
        {:else if section === 'livetv'}
            <AdminUserSimpleMode username={user.username} />
        {/if}
    </div>
</div>
