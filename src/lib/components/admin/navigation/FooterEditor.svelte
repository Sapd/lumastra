<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { NavigationItem } from './NavigationItemEditor.svelte';
    import { iconsWithSuggestedFirst } from './navigation-icons';

    export interface FooterLink extends NavigationItem {
        id: string;
        variant?: string;
    }
</script>

<script lang="ts">
    import { Icon, Plus, InformationCircle } from 'svelte-hero-icons';
    import NavigationItemEditor from './NavigationItemEditor.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        links?: FooterLink[];
        availableLocalIcons?: string[];
        /** Server feature flags — gate quick-adds whose destination needs one. */
        featureFlags?: Record<string, boolean>;
        onchange?: (detail: FooterLink[]) => void;
    }

    let {
        links = $bindable([]),
        availableLocalIcons = [],
        featureFlags = {},
        onchange,
    }: Props = $props();

    // The footer's Quick Connect button posts to an endpoint declared
    // `auth: { kind: 'feature', flag: 'jellyfinCompat' }`, so with the /j surface
    // off it can only ever fail. Don't offer adding one. (An already-configured
    // 'quickconnect' link still renders — removing it is the operator's call.)
    let showQuickConnect = $derived(featureFlags.jellyfinCompat === true);

    // Track which link is being edited (for auto-edit on create)
    let editingLinkIndex = $state<number | null>(null);
    // Stable id of the link that was just created (null when no unsaved new link exists).
    // Using an id instead of a boolean prevents stale-flag bugs when the user
    // opens a different item's editor before saving/cancelling the new one.
    let editingNewLinkId = $state<string | null>(null);

    function emitChange() {
        onchange?.(links);
    }

    // Load default footer configuration
    function loadDefaults() {
        links = [
            {
                id: 'request',
                label: 'Request',
                icon: 'clapperboard',
                variant: 'ghost-secondary',
                external: true,
            },
            {
                id: 'chat',
                label: 'Chat',
                icon: 'sparkles',
                variant: 'ghost-primary',
            },
            {
                id: 'quickconnect',
                label: 'Quick Connect',
                icon: 'command-line',
                variant: 'ghost-secondary',
            },
        ];
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function addLink() {
        const newId = crypto.randomUUID();
        const newLink: FooterLink = {
            id: newId,
            label: 'New Button',
            url: '/',
            icon: 'film',
            variant: 'ghost-secondary',
            external: true,
        };
        // Append at the end so existing editors' indices are not shifted,
        // preventing stale index/id collisions when another editor is already open.
        links = [...links, newLink];
        editingLinkIndex = links.length - 1;
        editingNewLinkId = newId;
        emitChange();
    }

    function addQuickConnect() {
        // Check if quickconnect already exists
        if (links.some((l) => l.id === 'quickconnect')) {
            toasts.error(m.admin_navigation_footer_toast_duplicate_qc());
            return;
        }
        const qcLink: FooterLink = {
            id: 'quickconnect',
            label: 'Quick Connect',
            icon: 'command-line',
            variant: 'ghost-secondary',
        };
        // Append at the end so existing editors' indices are not shifted,
        // preventing stale index/id collisions when another editor is already open.
        links = [...links, qcLink];
        editingLinkIndex = links.length - 1;
        editingNewLinkId = 'quickconnect';
        emitChange();
    }

    function updateLink(index: number, updatedLink: NavigationItem) {
        links = links.map((link, i) =>
            i === index ? { ...link, ...(updatedLink as FooterLink) } : link,
        );
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

    // Available icons for footer
    const footerIconsSuggested = [
        'clapperboard',
        'film',
        'sparkles',
        'book-open',
        'command-line',
        'cog-6-tooth',
        'chat-bubble-left-right',
        'arrow-down-tray',
        'tv',
        'musical-note',
        'key',
    ];

    // The picker offers the whole catalog; these just surface first.
    const footerIcons = iconsWithSuggestedFirst(footerIconsSuggested);
</script>

<div class="space-y-4">
    <div class="card-glass border border-surface-700">
        <div class="between mb-3">
            <h4 class="text-sm font-medium text-surface-300">
                {m.admin_navigation_footer_buttons_header()}
            </h4>
            <div class="flex gap-2">
                {#if showQuickConnect}
                    <button
                        type="button"
                        class="btn btn-sm btn-gray flex items-center gap-1"
                        onclick={addQuickConnect}>
                        <Icon src={Plus} class="w-4 h-4" />
                        {m.admin_navigation_footer_quick_connect_btn()}
                    </button>
                {/if}
                <button
                    type="button"
                    class="btn btn-sm btn-soft-cyan flex items-center gap-1"
                    onclick={addLink}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_navigation_footer_add_button()}
                </button>
            </div>
        </div>

        <p class="text-caption mb-4">
            {m.admin_navigation_footer_description()}
        </p>

        {#if links.length === 0}
            <div class="text-center py-8 text-surface-500">
                <p>{m.admin_navigation_footer_empty()}</p>
                <p class="text-xs mt-2 text-surface-400">
                    {m.admin_navigation_footer_empty_hint()}
                </p>
                <button type="button" class="btn btn-gray mt-4" onclick={loadDefaults}>
                    {m.admin_navigation_footer_load_defaults()}
                </button>
            </div>
        {:else}
            <div class="space-y-2">
                {#each links as link, index (link.id)}
                    <NavigationItemEditor
                        item={link}
                        {index}
                        isFirst={index === 0}
                        isLast={index === links.length - 1}
                        startInEditMode={editingLinkIndex === index}
                        showVariant={true}
                        showExternal={true}
                        externalLabel="Open in new tab"
                        showGroups={false}
                        availableIcons={footerIcons}
                        suggestedIcons={footerIconsSuggested}
                        {availableLocalIcons}
                        onupdate={(detail) => updateLink(index, detail)}
                        ondelete={() => deleteLink(index)}
                        oncancel={() => handleCancel(index)}
                        onmoveUp={() => moveLink(index, 'up')}
                        onmoveDown={() => moveLink(index, 'down')} />
                {/each}
            </div>
        {/if}
    </div>

    <!-- Help Info -->
    <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
        <div class="flex gap-2">
            <Icon src={InformationCircle} class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div class="text-xs text-blue-300 space-y-1">
                <p><strong>Special IDs:</strong></p>
                <ul class="list-disc list-inside">
                    <li>
                        <code class="bg-surface-800 px-1 rounded">quickconnect</code> - Shows Quick Connect
                        popup (no URL needed)
                    </li>
                    <li>
                        <code class="bg-surface-800 px-1 rounded">chat</code> - Links to AI chat
                    </li>
                    <li>
                        <code class="bg-surface-800 px-1 rounded">request</code> - Links to request service
                        (Jellyseerr)
                    </li>
                </ul>
                <p class="mt-2">
                    <strong>Style Variants:</strong> ghost-primary (cyan), ghost-secondary (gray), filled-primary
                    (solid cyan)
                </p>
            </div>
        </div>
    </div>
</div>
