<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { NavigationItem } from './NavigationItemEditor.svelte';
    import { iconsWithSuggestedFirst } from './navigation-icons';

    export type HeroButtonAction = 'search' | 'browse' | 'assistant' | 'link';

    export interface HeroButton extends NavigationItem {
        id: string;
        action: HeroButtonAction;
        label: string;
        icon: string;
        url?: string;
        external?: boolean;
        enabled: boolean;
    }

    // Built-in actions are singletons (at most one of each in the list).
    const SINGLETON_ACTIONS: readonly HeroButtonAction[] = ['search', 'browse', 'assistant'];
</script>

<script lang="ts">
    import { Icon, Plus, InformationCircle } from 'svelte-hero-icons';
    import NavigationItemEditor from './NavigationItemEditor.svelte';
    import { allLocaleLabels, JELLYFIN_CONNECT_URL } from '$lib/config/hero-button-labels';
    import type { LocalizedLabels } from '$lib/shared/localized-label';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        links?: HeroButton[];
        availableLocalIcons?: string[];
        /** Server feature flags — gate quick-adds whose destination needs one. */
        featureFlags?: Record<string, boolean>;
        onchange?: (detail: HeroButton[]) => void;
    }

    let {
        links = $bindable([]),
        availableLocalIcons = [],
        featureFlags = {},
        onchange,
    }: Props = $props();

    /**
     * Deep link that opens the Connect Jellyfin Client modal on the user's
     * connections page (ConnectionsSection reads `?connect=` in afterNavigate).
     */

    /**
     * A quick-add for the connect flow, in the same row as Search/Browse. It is
     * an ordinary `link` button with everything pre-filled — no new action type,
     * nothing special at render time, and the admin can rename, re-icon or
     * delete it like any other link.
     *
     * Gated on the flag its destination needs: with jellyfinCompat off, the
     * settings page ignores `?connect=jellyfin` and the button would lead to a
     * page with no modal. Hidden once one exists, since a second is pointless.
     */
    let showJellyfinConnect = $derived(
        featureFlags.jellyfinCompat === true &&
            !links.some((link) => link.url === JELLYFIN_CONNECT_URL),
    );

    function jellyfinConnectButton(): HeroButton {
        return {
            id: crypto.randomUUID(),
            action: 'link',
            label: m.settings_connections_connect_client(),
            labels: allLocaleLabels(m.settings_connections_connect_client),
            icon: 'server-stack',
            url: JELLYFIN_CONNECT_URL,
            // Internal: a new tab would strand the viewer on a settings page.
            external: false,
            enabled: true,
        };
    }

    function addJellyfinConnect() {
        links = [...links, jellyfinConnectButton()];
        emitChange();
    }

    // Track which link is being edited (for auto-edit on create)
    let editingLinkIndex = $state<number | null>(null);
    // Stable id of the link that was just created (null when no unsaved new link exists).
    let editingNewLinkId = $state<string | null>(null);

    function emitChange() {
        onchange?.(links);
    }

    // Defensive: stored HERO_BUTTONS configs can contain buttons with missing or
    // duplicate ids, which crashes the keyed {#each links (link.id)} with a Svelte
    // "duplicate key" error. Backfill unique ids once. The `changed` guard makes
    // this converge — after the first pass every id is unique, so the effect
    // re-runs but writes nothing (no loop).
    $effect(() => {
        // Plain object for local dedup tracking (not reactive state — avoids the
        // svelte/prefer-svelte-reactivity rule that bans native Set in components).
        const seen: Record<string, true> = {};
        let changed = false;
        const normalized = links.map((link) => {
            if (!link.id || seen[link.id]) {
                changed = true;
                const id = crypto.randomUUID();
                seen[id] = true;
                return { ...link, id };
            }
            seen[link.id] = true;
            return link;
        });
        if (changed) {
            links = normalized;
            emitChange();
        }
    });

    // Default toolbar matching the homepage's hardcoded fallback. Search & Browse
    // default ON; the env-backed link buttons (Movies/Audiobooks/Books) start
    // enabled with empty URLs for the admin to fill. With /j on, the fallback
    // also shows "Set up a Jellyfin app" after Browse, so the loaded list does too:
    // loading the defaults must not silently drop a button users already see.
    function loadDefaults() {
        links = [
            {
                id: crypto.randomUUID(),
                action: 'search',
                label: m.search(),
                labels: allLocaleLabels(m.search),
                icon: 'magnifying-glass',
                enabled: true,
            },
            {
                id: crypto.randomUUID(),
                action: 'browse',
                label: m.browse(),
                labels: allLocaleLabels(m.browse),
                icon: 'rectangle-group',
                enabled: true,
            },
            ...(featureFlags.jellyfinCompat === true ? [jellyfinConnectButton()] : []),
            {
                id: crypto.randomUUID(),
                action: 'assistant',
                label: m.assistant_label(),
                labels: allLocaleLabels(m.assistant_label),
                icon: 'sparkles',
                enabled: true,
            },
            {
                id: crypto.randomUUID(),
                action: 'link',
                label: m.allMoviesAndShows(),
                labels: allLocaleLabels(m.allMoviesAndShows),
                icon: 'film',
                url: '',
                external: true,
                enabled: true,
            },
            {
                id: crypto.randomUUID(),
                action: 'link',
                label: m.allAudiobooks(),
                labels: allLocaleLabels(m.allAudiobooks),
                icon: 'speaker-wave',
                url: '',
                external: true,
                enabled: true,
            },
            {
                id: crypto.randomUUID(),
                action: 'link',
                label: m.allBooks(),
                labels: allLocaleLabels(m.allBooks),
                icon: 'book-open',
                url: '',
                external: true,
                enabled: true,
            },
        ];
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    // Built-in defaults are stored with every language's text (`labels`), so a
    // button created by a German-speaking admin does not read "Suchen" for an
    // English viewer. See $lib/config/hero-button-labels.
    function defaultsForAction(action: HeroButtonAction): {
        label: string;
        labels?: LocalizedLabels;
        icon: string;
    } {
        switch (action) {
            case 'search':
                return {
                    label: m.search(),
                    labels: allLocaleLabels(m.search),
                    icon: 'magnifying-glass',
                };
            case 'browse':
                return {
                    label: m.browse(),
                    labels: allLocaleLabels(m.browse),
                    icon: 'rectangle-group',
                };
            case 'assistant':
                return {
                    label: m.assistant_label(),
                    labels: allLocaleLabels(m.assistant_label),
                    icon: 'sparkles',
                };
            default:
                return { label: 'New Link', icon: 'film' };
        }
    }

    function addButton(action: HeroButtonAction) {
        // Built-in actions are singletons — dedup like FooterEditor's quickconnect.
        if (SINGLETON_ACTIONS.includes(action) && links.some((l) => l.action === action)) {
            toasts.error(m.admin_navigation_hero_toast_duplicate_action());
            return;
        }
        const newId = crypto.randomUUID();
        const { label, labels, icon } = defaultsForAction(action);
        const newButton: HeroButton = {
            id: newId,
            action,
            label,
            ...(labels ? { labels } : {}),
            icon,
            enabled: true,
            ...(action === 'link' ? { url: '', external: true } : {}),
        };
        // Append at the end so existing editors' indices are not shifted.
        links = [...links, newButton];
        editingLinkIndex = links.length - 1;
        editingNewLinkId = newId;
        emitChange();
    }

    function updateButton(index: number, updated: NavigationItem) {
        links = links.map((link, i) =>
            i === index
                ? {
                      ...link,
                      ...(updated as Partial<HeroButton>),
                      // Built-in actions never carry a URL/external flag.
                      ...(link.action === 'link' ? {} : { url: undefined, external: undefined }),
                  }
                : link,
        );
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function deleteButton(index: number) {
        links = links.filter((_, i) => i !== index);
        editingLinkIndex = null;
        editingNewLinkId = null;
        emitChange();
    }

    function handleCancel(index: number) {
        const link = links[index];
        if (link && editingNewLinkId !== null && link.id === editingNewLinkId) {
            links = links.filter((_, i) => i !== index);
            emitChange();
        }
        editingLinkIndex = null;
        editingNewLinkId = null;
    }

    function moveButton(index: number, direction: 'up' | 'down') {
        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= links.length) return;
        const newLinks = [...links];
        [newLinks[index], newLinks[newIndex]] = [newLinks[newIndex], newLinks[index]];
        links = newLinks;
        emitChange();
    }

    function toggleEnabled(index: number) {
        links = links.map((link, i) => (i === index ? { ...link, enabled: !link.enabled } : link));
        emitChange();
    }

    function actionLabel(action: HeroButtonAction): string {
        switch (action) {
            case 'search':
                return m.admin_navigation_hero_action_search();
            case 'browse':
                return m.admin_navigation_hero_action_browse();
            case 'assistant':
                return m.admin_navigation_hero_action_assistant();
            default:
                return m.admin_navigation_hero_action_link();
        }
    }

    // Available icons for hero buttons
    const heroIconsSuggested = [
        'magnifying-glass',
        'rectangle-group',
        'sparkles',
        'film',
        'tv',
        'book-open',
        'speaker-wave',
        'musical-note',
        'squares-2x2',
        'queue-list',
        'home',
        'chat-bubble-left-right',
        // Client-connect style link buttons (e.g. "Connect Jellyfin client"),
        // which read as a server/device, not as a media type.
        'server-stack',
        'computer-desktop',
        'device-phone-mobile',
    ];

    // The picker offers the whole catalog; these just surface first.
    const heroIcons = iconsWithSuggestedFirst(heroIconsSuggested);
</script>

<div class="space-y-4">
    <div class="card-glass border border-surface-700">
        <div class="between mb-3">
            <h4 class="text-sm font-medium text-surface-300">
                {m.admin_navigation_hero_buttons_header()}
            </h4>
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    class="btn btn-sm btn-gray flex items-center gap-1"
                    onclick={() => addButton('search')}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_navigation_hero_action_search()}
                </button>
                <button
                    type="button"
                    class="btn btn-sm btn-gray flex items-center gap-1"
                    onclick={() => addButton('browse')}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_navigation_hero_action_browse()}
                </button>
                <button
                    type="button"
                    class="btn btn-sm btn-gray flex items-center gap-1"
                    onclick={() => addButton('assistant')}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_navigation_hero_action_assistant()}
                </button>
                {#if showJellyfinConnect}
                    <button
                        type="button"
                        class="btn btn-sm btn-gray flex items-center gap-1"
                        onclick={addJellyfinConnect}>
                        <Icon src={Plus} class="w-4 h-4" />
                        {m.settings_connections_connect_client()}
                    </button>
                {/if}
                <button
                    type="button"
                    class="btn btn-sm btn-soft-cyan flex items-center gap-1"
                    onclick={() => addButton('link')}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_navigation_hero_add_link()}
                </button>
            </div>
        </div>

        <p class="text-caption mb-4">
            {m.admin_navigation_hero_description()}
        </p>

        {#if links.length === 0}
            <div class="text-center py-8 text-surface-500">
                <p>{m.admin_navigation_hero_empty()}</p>
                <p class="text-xs mt-2 text-surface-400">
                    {m.admin_navigation_hero_empty_hint()}
                </p>
                <button type="button" class="btn btn-gray mt-4" onclick={loadDefaults}>
                    {m.admin_navigation_hero_load_defaults()}
                </button>
            </div>
        {:else}
            <div class="space-y-2">
                {#each links as link, index (link.id)}
                    <div
                        class="rounded-lg border border-surface-600/30 {link.enabled
                            ? ''
                            : 'opacity-60'}">
                        <div
                            class="flex items-center gap-3 px-3 pt-3 pb-1 border-b border-surface-700/40">
                            <label class="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={link.enabled}
                                    onchange={() => toggleEnabled(index)}
                                    class="w-4 h-4 rounded bg-surface-800 border-surface-600 text-cyan-500 focus:ring-cyan-500" />
                                <span class="text-sm text-surface-300"
                                    >{m.admin_navigation_hero_enabled_label()}</span>
                            </label>
                            <span
                                class="px-1.5 py-0.5 text-[10px] bg-cyan-500/10 text-cyan-300 rounded border border-cyan-500/20">
                                {actionLabel(link.action)}
                            </span>
                        </div>
                        <NavigationItemEditor
                            item={link}
                            {index}
                            isFirst={index === 0}
                            isLast={index === links.length - 1}
                            startInEditMode={editingLinkIndex === index}
                            showUrl={link.action === 'link'}
                            showExternal={link.action === 'link'}
                            externalLabel="Open in new tab"
                            showGroups={false}
                            availableIcons={heroIcons}
                            suggestedIcons={heroIconsSuggested}
                            {availableLocalIcons}
                            onupdate={(detail) => updateButton(index, detail)}
                            ondelete={() => deleteButton(index)}
                            oncancel={() => handleCancel(index)}
                            onmoveUp={() => moveButton(index, 'up')}
                            onmoveDown={() => moveButton(index, 'down')} />
                    </div>
                {/each}
            </div>
        {/if}
    </div>

    <!-- Help Info -->
    <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
        <div class="flex gap-2">
            <Icon src={InformationCircle} class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div class="text-xs text-blue-300 space-y-1">
                <p><strong>{m.admin_navigation_hero_help_actions()}</strong></p>
                <ul class="list-disc list-inside">
                    <li>
                        <code class="bg-surface-800 px-1 rounded">search</code> — {m.admin_navigation_hero_help_search()}
                    </li>
                    <li>
                        <code class="bg-surface-800 px-1 rounded">browse</code> — {m.admin_navigation_hero_help_browse()}
                    </li>
                    <li>
                        <code class="bg-surface-800 px-1 rounded">assistant</code> — {m.admin_navigation_hero_help_assistant()}
                    </li>
                    <li>{m.admin_navigation_hero_help_link()}</li>
                </ul>
                <p class="mt-2">{m.admin_navigation_hero_help_fallback()}</p>
            </div>
        </div>
    </div>
</div>
