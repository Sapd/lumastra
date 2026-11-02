<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { NavigationItem } from './NavigationItemEditor.svelte';
    import { iconsWithSuggestedFirst } from './navigation-icons';

    export interface UserMenuLink extends NavigationItem {
        id: string;
        external?: boolean;
    }

    // Built-in menu item definition for display purposes
    export interface BuiltInMenuItem {
        id: string;
        label: string;
        icon: string;
        featureFlag: string;
        featureFlagLabel: string;
        description: string;
        type: 'button' | 'toggle' | 'link';
    }
</script>

<script lang="ts">
    import {
        Icon,
        Plus,
        InformationCircle,
        LockClosed,
        DevicePhoneMobile,
        ChartBar,
        PlayCircle,
        Cog6Tooth,
        ArrowRightOnRectangle,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import NavigationItemEditor from './NavigationItemEditor.svelte';
    import { allLocaleLabels } from '$lib/config/hero-button-labels';

    // Icon mapping for built-in items
    const builtInIconMap: Record<string, typeof DevicePhoneMobile> = {
        'device-phone-mobile': DevicePhoneMobile,
        'chart-bar': ChartBar,
        'play-circle': PlayCircle,
        'cog-6-tooth': Cog6Tooth,
        'arrow-right-on-rectangle': ArrowRightOnRectangle,
    };

    // Built-in items that are always shown based on feature flags.
    // API Tokens and Customize Widgets have moved to /settings (account and home sections).
    // What the account menu (UserMenuPopover) renders on its own, after the
    // links configured here. Preference toggles (dock, stream tech info, hide
    // streams, language, theme) moved to /settings in the 2026-09 menu redesign.
    const builtInItems: BuiltInMenuItem[] = [
        {
            id: 'now-playing',
            label: 'Playing now',
            icon: 'play-circle',
            featureFlag: '(only while streaming)',
            featureFlagLabel: 'When playing',
            description: 'What the user is playing right now, anywhere',
            type: 'link',
        },
        {
            id: 'connected-devices',
            label: 'Sessions & devices',
            icon: 'device-phone-mobile',
            featureFlag: 'FEATURE_DEVICE_AUTH',
            featureFlagLabel: 'Device Auth',
            description: 'Signed-in apps, TVs and browsers',
            type: 'link',
        },
        {
            id: 'my-stats',
            label: 'My Stats',
            icon: 'chart-bar',
            featureFlag: 'FEATURE_PERSONAL_STATS',
            featureFlagLabel: 'Personal Stats',
            description: 'View your watch statistics',
            type: 'link',
        },
        {
            id: 'settings',
            label: 'Settings',
            icon: 'cog-6-tooth',
            featureFlag: '(always shown)',
            featureFlagLabel: 'Always',
            description: 'All personal settings',
            type: 'link',
        },
        {
            id: 'sign-out',
            label: 'Sign out',
            icon: 'arrow-right-on-rectangle',
            featureFlag: '(always shown)',
            featureFlagLabel: 'Always',
            description: 'A custom link to /logout is not shown twice',
            type: 'link',
        },
    ];

    interface Props {
        links?: UserMenuLink[];
        availableLocalIcons?: string[];
        onchange?: (detail: UserMenuLink[]) => void;
    }

    let { links = $bindable([]), availableLocalIcons = [], onchange }: Props = $props();

    // Track which link is being edited (for auto-edit on create)
    let editingLinkIndex = $state<number | null>(null);
    // Stable id of the link that was just created (null when no unsaved new link exists).
    // Using an id instead of a boolean prevents stale-flag bugs when the user
    // opens a different item's editor before saving/cancelling the new one.
    let editingNewLinkId = $state<string | null>(null);

    function emitChange() {
        onchange?.(links);
    }

    // Render the list with a deterministic, ALWAYS-unique key per row. Older
    // stored USER_MENU_LINKS configs can contain links with missing or DUPLICATE
    // ids; keying the {#each} directly on link.id then throws Svelte's
    // "duplicate key" error (or mis-reconciles in prod) and the editor never
    // opens. Deriving the key from id+position fixes it at RENDER time (an
    // $effect backfill runs too late — the each crashes first). It does NOT
    // mutate the saved data; edit ops still address links by their array index.
    let keyedLinks = $derived.by(() => {
        const seen: Record<string, number> = {};
        return links.map((link, index) => {
            let key = link.id ? String(link.id) : `__noid_${index}`;
            if (seen[key] !== undefined) key = `${key}__${index}`;
            seen[key] = index;
            return { link, index, key };
        });
    });

    // Load default user menu configuration
    function loadDefaults() {
        // Stored with every language's text so the menu reads right for every
        // viewer. Change Avatar and Logout are no longer seeded: the photo lives
        // in Settings → Account and Sign out is always built in.
        links = [
            {
                id: crypto.randomUUID(),
                label: m.usermenu_default_all_apps(),
                labels: allLocaleLabels(m.usermenu_default_all_apps),
                icon: 'squares-2x2',
                external: true,
            },
            {
                id: crypto.randomUUID(),
                label: m.usermenu_default_change_password(),
                labels: allLocaleLabels(m.usermenu_default_change_password),
                icon: 'key',
                external: true,
            },
        ];
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function addLink() {
        const newId = crypto.randomUUID();
        const newLink: UserMenuLink = {
            id: newId,
            label: 'New Link',
            icon: 'cog-6-tooth',
            external: true,
        };
        // Append at the end so existing items keep their index — prepending would shift
        // an already-open editor's captured index and leave two editors mounted.
        links = [...links, newLink];
        editingLinkIndex = links.length - 1;
        editingNewLinkId = newId;
        emitChange();
    }

    function updateLink(index: number, updatedLink: NavigationItem) {
        links = links.map((link, i) => (i === index ? (updatedLink as UserMenuLink) : link));
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function deleteLink(index: number) {
        links = links.filter((_, i) => i !== index);
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function handleCancel(index: number) {
        // Only auto-delete if this specific link is the unsaved new one.
        // Checking by id prevents the stale-boolean bug where cancelling an
        // existing item's editor would incorrectly delete it.
        const link = links[index];
        if (link && editingNewLinkId !== null && link.id === editingNewLinkId) {
            links = links.filter((_, i) => i !== index);
            emitChange();
        }
        editingLinkIndex = null;
        editingNewLinkId = null;
    }

    function moveLink(index: number, direction: 'up' | 'down') {
        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= links.length) return;
        const newLinks = [...links];
        [newLinks[index], newLinks[newIndex]] = [newLinks[newIndex], newLinks[index]];
        links = newLinks;
        emitChange();
    }

    // Available icons for user menu
    const menuIconsSuggested = [
        'cog-6-tooth',
        'key',
        'arrow-right-on-rectangle',
        'user-circle',
        'chart-bar',
        'sparkles',
        'book-open',
        'film',
    ];

    // The picker offers the whole catalog; these just surface first.
    const menuIcons = iconsWithSuggestedFirst(menuIconsSuggested);
</script>

<div class="space-y-4">
    <div class="card-glass border border-surface-700">
        <div class="between mb-3">
            <h4 class="text-sm font-medium text-surface-300">
                {m.admin_navigation_usermenu_header()}
            </h4>
            <button
                type="button"
                class="px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-sm rounded-lg transition-colors flex items-center gap-1"
                onclick={addLink}>
                <Icon src={Plus} class="w-4 h-4" />
                {m.admin_navigation_usermenu_add_link()}
            </button>
        </div>

        <p class="text-caption mb-4">
            {m.admin_navigation_usermenu_description()}
        </p>

        {#if links.length === 0}
            <div class="text-center py-8 text-surface-500">
                <p>{m.admin_navigation_usermenu_empty()}</p>
                <p class="text-xs mt-2 text-surface-400">
                    {m.admin_navigation_usermenu_empty_hint()}
                </p>
                <button type="button" class="btn btn-gray mt-4" onclick={loadDefaults}>
                    {m.admin_navigation_usermenu_load_defaults()}
                </button>
            </div>
        {:else}
            <div class="space-y-2">
                {#each keyedLinks as entry (entry.key)}
                    <NavigationItemEditor
                        item={entry.link}
                        index={entry.index}
                        isFirst={entry.index === 0}
                        isLast={entry.index === links.length - 1}
                        startInEditMode={editingLinkIndex === entry.index}
                        showExternal={true}
                        externalLabel="Open in new tab"
                        showGroups={false}
                        availableIcons={menuIcons}
                        suggestedIcons={menuIconsSuggested}
                        {availableLocalIcons}
                        onupdate={(detail) => updateLink(entry.index, detail)}
                        ondelete={() => deleteLink(entry.index)}
                        oncancel={() => handleCancel(entry.index)}
                        onmoveUp={() => moveLink(entry.index, 'up')}
                        onmoveDown={() => moveLink(entry.index, 'down')} />
                {/each}
            </div>
        {/if}
    </div>

    <!-- Built-in Items (Feature-Controlled) -->
    <div class="card-glass border border-surface-700">
        <div class="flex items-center gap-2 mb-3">
            <Icon src={LockClosed} class="w-4 h-4 text-surface-500" />
            <h4 class="text-sm font-medium text-surface-400">
                {m.admin_navigation_usermenu_builtin_header()}
            </h4>
        </div>

        <p class="text-caption mb-4">
            {m.admin_navigation_usermenu_builtin_description()} Account, devices, connections, display,
            playback, subtitles, home, and about settings now live on the dedicated
            <code class="text-xs bg-surface-700 px-1 rounded">/settings</code>
            surface — each section is gated by the same feature flags, not by
            <code class="text-xs bg-surface-700 px-1 rounded">USER_MENU_LINKS</code>.
        </p>

        <div class="space-y-2">
            {#each builtInItems as item (item.id)}
                <div class="flex items-center gap-3 bg-surface-700/20 rounded-lg p-3 opacity-60">
                    <!-- Icon -->
                    <div class="w-8 h-8 rounded bg-surface-700/50 center text-surface-500">
                        {#if builtInIconMap[item.icon]}
                            <Icon src={builtInIconMap[item.icon]} class="w-4 h-4" />
                        {:else}
                            <span class="text-xs">{item.icon.substring(0, 2)}</span>
                        {/if}
                    </div>

                    <!-- Item info -->
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="text-sm font-medium text-surface-400">{item.label}</span>
                            <span
                                class="px-1.5 py-0.5 text-[10px] bg-surface-700 text-surface-500 rounded">
                                {item.type}
                            </span>
                        </div>
                        <p class="text-xs text-surface-600 truncate">
                            {item.description}
                        </p>
                    </div>

                    <!-- Feature flag badge -->
                    <div class="shrink-0">
                        <span
                            class="px-2 py-1 text-[10px] bg-purple-500/10 text-purple-400/70 rounded border border-purple-500/20">
                            {item.featureFlagLabel}
                        </span>
                    </div>
                </div>
            {/each}
        </div>
    </div>

    <!-- Help Info -->
    <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
        <div class="flex gap-2">
            <Icon src={InformationCircle} class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div class="text-xs text-blue-300 space-y-1">
                <p><strong>Common links to add:</strong></p>
                <ul class="list-disc list-inside">
                    <li>All Apps (link to your auth portal)</li>
                    <li>Change Password (link to auth profile page)</li>
                </ul>
                <p class="mt-2">
                    <strong>Note:</strong> Custom links appear after the name and "Playing now", before
                    the built-in items. Sign out is always built in. Open a link and use "Translations"
                    to give it a label per language.
                </p>
            </div>
        </div>
    </div>
</div>
