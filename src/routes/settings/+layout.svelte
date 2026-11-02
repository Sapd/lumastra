<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import '$lib/components/app-shell';
    import { onMount } from 'svelte';
    import type { Snippet } from 'svelte';
    import { page } from '$app/stores';
    import { afterNavigate, goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { Icon, XMark, MagnifyingGlass, ChevronLeft, ChevronRight } from 'svelte-hero-icons';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import { hasModals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';
    import { SETTINGS_SECTIONS } from '$lib/config/settings-sections';
    import { searchSettings } from '$lib/config/settings-search-index';
    import EmptyState from '$lib/components/ui/EmptyState.svelte';
    import NavigationProgressBar from '$lib/components/ui/NavigationProgressBar.svelte';
    import { navigateTo, resolve } from '$lib/paths';

    interface Props {
        data: { enabledSectionIds: string[] };
        children?: Snippet;
    }
    let { data, children }: Props = $props();

    // Remember where the user came from so closing returns there, not always '/'.
    let openerUrl = $state<string | null>(null);
    afterNavigate(({ from, to }) => {
        const settingsRoot = `${base}/settings`;
        const toSettings = to?.url.pathname.startsWith(settingsRoot) ?? false;
        const fromSettings = from?.url.pathname.startsWith(settingsRoot) ?? false;
        if (toSettings && from && !fromSettings) {
            // from.url.pathname already includes the deployment base; store a
            // base-relative path so navigateTo() (which re-applies base) does not
            // double-prefix it on subfolder deployments.
            const rel = from.url.pathname.startsWith(base)
                ? from.url.pathname.slice(base.length)
                : from.url.pathname;
            openerUrl = (rel || '/') + from.url.search;
        }
    });

    function closeSettings(): void {
        void navigateTo(openerUrl ?? '/');
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // Defer Escape to any dialog opened from WITHIN settings so it closes the
        // dialog first, not the whole overlay. Two kinds exist:
        //  - modal-store modals (e.g. ChangePassword) → $hasModals
        //  - body-portalled `.modal-overlay` dialogs the section panels use
        //    (token-create, Jellyfin/Subsonic connect), which don't register with
        //    the store.
        //  - native dialogs, whose browser-managed Escape must take priority.
        if ($hasModals) return;
        if (
            typeof document !== 'undefined' &&
            document.querySelector('.modal-overlay, dialog[open]')
        )
            return;
        e.preventDefault();
        if (query.trim()) {
            clearSearch();
            return;
        }
        closeSettings();
    }

    const enabledIds = $derived(new Set(data.enabledSectionIds));
    const sidebarSections = $derived(SETTINGS_SECTIONS.filter((s) => enabledIds.has(s.id)));

    const currentId = $derived(
        $page.url.pathname.replace(`${base}/settings`, '').replace(/^\//, '').split('/')[0] || '',
    );
    const currentSection = $derived(SETTINGS_SECTIONS.find((s) => s.id === currentId));

    let query = $state('');
    let searchInput: HTMLInputElement | undefined;
    function clearSearch(): void {
        query = '';
        searchInput?.focus();
    }
    const results = $derived(
        searchSettings(query, enabledIds, { authMethod: $page.data?.authMethod }),
    );
    // Localized section labels (the config `label` stays English for search keys).
    const SECTION_LABELS: Record<string, () => string> = {
        account: m.settings_section_account,
        sessions: m.settings_section_sessions,
        connections: m.settings_section_connections,
        display: m.settings_section_display,
        privacy: m.settings_section_privacy,
        playback: m.settings_section_playback,
        subtitles: m.settings_section_subtitles,
        home: m.settings_section_home,
        about: m.settings_section_about,
        data: m.settings_search_label_reset_data,
    };
    const sectionLabel = (id: string): string =>
        SECTION_LABELS[id]?.() ?? SETTINGS_SECTIONS.find((s) => s.id === id)?.label ?? id;

    // --- Mobile / desktop viewport detection ---
    // SSR-safe default: true so the server renders the desktop branch and the
    // e2e desktop redirect logic is consistent; the client corrects on mount.
    let isDesktop = $state(true);

    onMount(() => {
        const mq = window.matchMedia('(min-width: 1024px)');
        isDesktop = mq.matches;
        const handler = (e: MediaQueryListEvent): void => {
            isDesktop = e.matches;
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    });

    // Desktop auto-advance: when at the settings root on a wide viewport,
    // navigate to the first enabled section (preserves Plan-1 desktop behavior).
    $effect(() => {
        if (isDesktop && currentId === '' && sidebarSections.length > 0) {
            void goto(resolve(`/settings/${sidebarSections[0].id}`), { replaceState: true });
        }
    });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Every settings tab used to read just the instance name. -->
<svelte:head>
    <title
        >{currentSection
            ? `${sectionLabel(currentSection.id)} - ${m.settings_title()}`
            : m.settings_title()} - {$page.data?.branding?.appName || 'Lumastra'}</title>
</svelte:head>

<div
    class="fixed inset-0 h-[100dvh] overflow-hidden flex flex-col bg-surface-900"
    style="z-index: {Z.SETTINGS_OVERLAY}; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-dialog-heading"
    use:trapFocus>
    <h1 id="settings-dialog-heading" class="sr-only">{m.settings_title()}</h1>
    <!-- Closing /settings runs a full navigation back to the opener page (the
         homepage remounts + reloads). The root-layout progress bar lives at
         z-index 501, below this overlay (980), so it stays hidden for the whole
         close. Render one INSIDE the overlay so the wait is legible. -->
    <NavigationProgressBar />
    <!-- Sticky top bar: close + cross-section search -->
    <div class="sticky top-0 flex items-center gap-3 px-4 py-3 border-b border-surface-700/50">
        <button
            class="btn variant-ghost-surface shrink-0"
            data-autofocus
            aria-label={m.settings_close_aria()}
            onclick={closeSettings}>
            <Icon src={XMark} class="w-6 h-6" />
        </button>
        <div class="flex items-center gap-2 flex-1 min-w-0 max-w-md">
            <Icon src={MagnifyingGlass} class="w-5 h-5 text-surface-400 shrink-0" />
            <input
                class="input settings-search"
                type="search"
                placeholder={m.settings_search_placeholder()}
                aria-label={m.settings_search_aria()}
                bind:this={searchInput}
                bind:value={query} />
            {#if query}
                <button
                    class="btn-icon variant-ghost-surface shrink-0"
                    aria-label={m.viewer_settings_clear_search()}
                    onclick={clearSearch}>
                    <Icon src={XMark} class="w-5 h-5" />
                </button>
            {/if}
        </div>
    </div>

    <div class="flex-1 flex min-h-0">
        <!-- Sidebar (desktop only) -->
        <nav
            class="w-60 shrink-0 overflow-y-auto border-r border-surface-700/50 p-3 hidden lg:block"
            aria-label={m.settings_title()}>
            {#each sidebarSections as s (s.id)}
                <a
                    href={resolve(`/settings/${s.id}`)}
                    data-sveltekit-replacestate
                    onclick={() => (query = '')}
                    class="flex items-center gap-2 px-3 py-2 rounded-lg border-l-2 {s.id ===
                    currentId
                        ? 'border-primary-500 bg-surface-700 text-white'
                        : 'border-transparent text-surface-300 hover:bg-surface-700/40'}"
                    aria-current={s.id === currentId ? 'page' : undefined}>
                    <Icon src={s.icon} class="w-5 h-5" />
                    <span>{sectionLabel(s.id)}</span>
                </a>
            {/each}
        </nav>

        <!-- Content pane -->
        <main class="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 lg:px-8">
            {#if query.trim()}
                <h2 class="text-xl font-semibold mb-2">{m.viewer_settings_search_heading()}</h2>
                <p class="text-sm text-surface-400 mb-6" role="status">
                    {m.viewer_settings_search_count({ count: results.length })}
                </p>
                {#if results.length === 0}
                    <EmptyState
                        variant="minimal"
                        icon={MagnifyingGlass}
                        title={m.settings_search_no_results({ query })} />
                {:else}
                    <ul class="space-y-2">
                        {#each results as r (r.sectionId + r.label)}
                            <li>
                                <a
                                    href={resolve(`/settings/${r.sectionId}`) +
                                        (r.query ? `?${r.query}` : '')}
                                    data-sveltekit-replacestate
                                    class="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-surface-800/50 hover:bg-surface-700"
                                    onclick={() => (query = '')}>
                                    <span>{r.label}</span>
                                    <span class="badge variant-soft-surface"
                                        >{sectionLabel(r.sectionId)}</span>
                                </a>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {:else if currentId === '' && !isDesktop}
                <h2 class="text-2xl font-semibold mb-6">{m.settings_title()}</h2>
                <!-- Mobile: section LIST at the /settings root -->
                <nav aria-label={m.settings_sections_aria()} class="space-y-2">
                    {#each sidebarSections as s (s.id)}
                        <!-- Mobile list -> section PUSHES history so the device
                             Back button returns to this list (not out of the overlay). -->
                        <a
                            href={resolve(`/settings/${s.id}`)}
                            class="between p-4 rounded-lg bg-surface-800/50 hover:bg-surface-700">
                            <span class="flex items-center gap-2">
                                <Icon src={s.icon} class="w-5 h-5" />{sectionLabel(s.id)}
                            </span>
                            <Icon src={ChevronRight} class="w-5 h-5 text-surface-500" />
                        </a>
                    {/each}
                </nav>
            {:else}
                {#if currentId !== '' && !isDesktop}
                    <a
                        href={resolve('/settings')}
                        class="inline-flex items-center gap-1 text-sm text-surface-300 mb-4"
                        aria-label={m.settings_back_to_list_aria()}>
                        <Icon src={ChevronLeft} class="w-5 h-5" />
                        {m.settings_title()}
                    </a>
                {/if}
                <header class="flex items-center gap-2 mb-6">
                    {#if currentSection}
                        <Icon src={currentSection.icon} class="w-6 h-6 text-primary-400" />
                    {/if}
                    <h2 id="settings-section-heading" class="text-2xl font-semibold">
                        {currentSection ? sectionLabel(currentSection.id) : m.settings_title()}
                    </h2>
                </header>
                {@render children?.()}
            {/if}
        </main>
    </div>
</div>

<style>
    /* The browser's own clear (×) sat right next to ours. */
    .settings-search::-webkit-search-cancel-button {
        appearance: none;
    }
</style>
