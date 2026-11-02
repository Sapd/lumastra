<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { slide } from 'svelte/transition';
    import {
        Icon,
        Bars3,
        Square3Stack3d,
        UserCircle,
        Sparkles,
        InformationCircle,
        ChevronDown,
        LockClosed,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import SidebarEditor from './SidebarEditor.svelte';
    import FooterEditor from './FooterEditor.svelte';
    import UserMenuEditor from './UserMenuEditor.svelte';
    import HeroButtonsEditor from './HeroButtonsEditor.svelte';
    import type { SidebarLink, SidebarSection } from './SidebarEditor.svelte';
    import type { FooterLink } from './FooterEditor.svelte';
    import type { UserMenuLink } from './UserMenuEditor.svelte';
    import type { HeroButton } from './HeroButtonsEditor.svelte';

    interface Props {
        // Navigation configuration data from server
        sidebarLinks?: SidebarLink[];
        sidebarSections?: SidebarSection[];
        footerLinks?: FooterLink[];
        userMenuLinks?: UserMenuLink[];
        heroButtons?: HeroButton[];
        availableGroups?: string[];
        localNavIcons?: string[];
        /** Server feature flags, for editors that gate a quick-add on one. */
        featureFlags?: Record<string, boolean>;
        envOverrides?: {
            sidebarLinks?: boolean;
            sidebarSections?: boolean;
            footerLinks?: boolean;
            userMenuLinks?: boolean;
            heroButtons?: boolean;
        };
        collapsed?: boolean;
        onchange?: (detail: {
            sidebarLinks: SidebarLink[];
            sidebarSections: SidebarSection[];
            footerLinks: FooterLink[];
            userMenuLinks: UserMenuLink[];
            heroButtons: HeroButton[];
        }) => void;
        onaddgroup?: (groups: string[]) => void;
    }

    let {
        sidebarLinks = $bindable([]),
        sidebarSections = $bindable([]),
        footerLinks = $bindable([]),
        userMenuLinks = $bindable([]),
        heroButtons = $bindable([]),
        availableGroups = ['admin', 'users'],
        localNavIcons = [],
        featureFlags = {},
        envOverrides = {},
        collapsed = $bindable(false),
        onchange,
        onaddgroup,
    }: Props = $props();

    // Tab state
    type Tab = 'sidebar' | 'footer' | 'usermenu' | 'hero';
    let activeTab: Tab = $state('sidebar');

    const tabs: { id: Tab; label: () => string; icon: typeof Bars3 }[] = [
        { id: 'sidebar', label: m.admin_navigation_tab_sidebar, icon: Bars3 },
        { id: 'footer', label: m.admin_navigation_tab_footer, icon: Square3Stack3d },
        { id: 'usermenu', label: m.admin_navigation_tab_user_menu, icon: UserCircle },
        { id: 'hero', label: m.admin_navigation_tab_hero_buttons, icon: Sparkles },
    ];

    // Check which navigation configs are overridden by ENV
    let sidebarEnvOverride = $derived(envOverrides.sidebarLinks || envOverrides.sidebarSections);
    let footerEnvOverride = $derived(envOverrides.footerLinks);
    let userMenuEnvOverride = $derived(envOverrides.userMenuLinks);
    let heroEnvOverride = $derived(envOverrides.heroButtons);

    function emitChange() {
        onchange?.({
            sidebarLinks,
            sidebarSections,
            footerLinks,
            userMenuLinks,
            heroButtons,
        });
    }

    function toggleCollapsed() {
        collapsed = !collapsed;
    }

    function handleSidebarChange(detail: { links: SidebarLink[]; sections: SidebarSection[] }) {
        sidebarLinks = detail.links;
        sidebarSections = detail.sections;
        emitChange();
    }

    function handleFooterChange(detail: FooterLink[]) {
        footerLinks = detail;
        emitChange();
    }

    function handleUserMenuChange(detail: UserMenuLink[]) {
        userMenuLinks = detail;
        emitChange();
    }

    function handleHeroChange(detail: HeroButton[]) {
        heroButtons = detail;
        emitChange();
    }
</script>

<div class="section-card card-glass border border-surface-700 overflow-hidden !p-0">
    <!-- Section Header -->
    <button
        type="button"
        class="w-full between p-4 text-left hover:bg-surface-700/30 transition-colors"
        onclick={toggleCollapsed}
        aria-expanded={!collapsed}>
        <div class="flex items-center gap-3">
            <Icon
                src={ChevronDown}
                class="w-5 h-5 text-surface-400 transition-transform {collapsed
                    ? '-rotate-90'
                    : ''}" />
            <div>
                <h3 class="text-base font-medium text-surface-200">
                    {m.admin_navigation_settings_header()}
                </h3>
                <p class="text-hint mt-0.5">{m.admin_navigation_settings_description()}</p>
            </div>
        </div>
        <span class="text-caption">{m.admin_navigation_settings_editors_count()}</span>
    </button>

    <!-- Section Content -->
    {#if !collapsed}
        <div class="px-4 pb-4 border-t border-surface-700/50" transition:slide={{ duration: 200 }}>
            <!-- Tabs -->
            <div class="flex gap-1 my-4 border-b border-surface-700 pb-2">
                {#each tabs as tab (tab.id)}
                    {@const isOverridden =
                        (tab.id === 'sidebar' && sidebarEnvOverride) ||
                        (tab.id === 'footer' && footerEnvOverride) ||
                        (tab.id === 'usermenu' && userMenuEnvOverride) ||
                        (tab.id === 'hero' && heroEnvOverride)}
                    <button
                        type="button"
                        class="flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors relative {activeTab ===
                        tab.id
                            ? 'bg-surface-700 text-white'
                            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'}"
                        onclick={() => (activeTab = tab.id)}>
                        <Icon src={tab.icon} class="w-4 h-4" />
                        <span>{tab.label()}</span>
                        {#if isOverridden}
                            <span
                                class="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-300 rounded-md ml-auto shrink-0"
                                role="status"
                                aria-label={m.admin_navigation_env_override_aria()}>
                                <Icon src={LockClosed} class="w-3 h-3" />
                                <span>ENV</span>
                            </span>
                        {/if}
                    </button>
                {/each}
            </div>

            <!-- ENV Override Warning -->
            {#if (activeTab === 'sidebar' && sidebarEnvOverride) || (activeTab === 'footer' && footerEnvOverride) || (activeTab === 'usermenu' && userMenuEnvOverride) || (activeTab === 'hero' && heroEnvOverride)}
                <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mb-4">
                    <div class="flex gap-2">
                        <Icon
                            src={InformationCircle}
                            class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <p class="text-xs text-blue-300">
                            {m.admin_navigation_env_override_warning()}
                        </p>
                    </div>
                </div>
            {/if}

            <!-- Tab Content -->
            <div>
                {#if activeTab === 'sidebar'}
                    <SidebarEditor
                        links={sidebarLinks}
                        sections={sidebarSections}
                        {availableGroups}
                        availableLocalIcons={localNavIcons}
                        onchange={handleSidebarChange}
                        {onaddgroup} />
                {:else if activeTab === 'footer'}
                    <FooterEditor
                        links={footerLinks}
                        availableLocalIcons={localNavIcons}
                        {featureFlags}
                        onchange={handleFooterChange} />
                {:else if activeTab === 'usermenu'}
                    <UserMenuEditor
                        links={userMenuLinks}
                        availableLocalIcons={localNavIcons}
                        onchange={handleUserMenuChange} />
                {:else if activeTab === 'hero'}
                    <HeroButtonsEditor
                        links={heroButtons}
                        availableLocalIcons={localNavIcons}
                        {featureFlags}
                        onchange={handleHeroChange} />
                {/if}
            </div>
        </div>
    {/if}
</div>
