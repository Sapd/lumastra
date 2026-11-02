<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';

    import { Icon, ChevronDown, type IconSource } from 'svelte-hero-icons';
    import { slide } from 'svelte/transition';

    // Accordion item type
    type AccordionItem = {
        id: string;
        title: string;
        icon?: IconSource;
        disabled?: boolean;
    };

    // Additional classes
    interface Props {
        // Props
        items?: AccordionItem[];
        // Only allow one item open at a time
        exclusive?: boolean;
        /** Initially open items (by id) - captured once, not reactive */
        defaultOpen?: string[];
        /** Persist open state to localStorage - captured once as storage key */
        persistKey?: string;
        class?: string;
        content?: import('svelte').Snippet<[{ item: AccordionItem; open: boolean }]>;
        ontoggle?: (detail: { id: string; open: boolean }) => void;
    }

    let {
        items = [],
        exclusive = false,
        defaultOpen = [],
        persistKey = '',
        class: className = '',
        content,
        ontoggle,
    }: Props = $props();

    let openItems = new SvelteSet<string>();

    $effect(() => {
        let initialOpen: string[] = defaultOpen;

        if (persistKey && typeof localStorage !== 'undefined') {
            try {
                const stored = localStorage.getItem(`accordion-${persistKey}`);
                if (stored) {
                    const parsed: unknown = JSON.parse(stored);
                    const parsedIds = Array.isArray(parsed)
                        ? parsed.filter((value): value is string => typeof value === 'string')
                        : null;
                    initialOpen = parsedIds ?? defaultOpen;
                }
            } catch {
                /* expected: JSON.parse failure on corrupt localStorage accordion state */
            }
        }

        openItems = new SvelteSet(initialOpen);
    });

    // Save to localStorage when changed
    function persistState() {
        if (persistKey && typeof localStorage !== 'undefined') {
            localStorage.setItem(`accordion-${persistKey}`, JSON.stringify([...openItems]));
        }
    }

    function isOpen(id: string): boolean {
        return openItems.has(id);
    }

    function toggle(id: string) {
        const item = items.find((i) => i.id === id);
        if (item?.disabled) return;

        if (openItems.has(id)) {
            openItems.delete(id);
        } else {
            if (exclusive) {
                openItems.clear();
            }
            openItems.add(id);
        }

        openItems = openItems; // Trigger reactivity
        persistState();
        ontoggle?.({ id, open: openItems.has(id) });
    }

    function handleKeydown(event: KeyboardEvent, id: string) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle(id);
        }
    }
</script>

<div class="accordion-group space-y-2 {className}">
    {#each items as item (item.id)}
        {@const open = isOpen(item.id)}
        <div
            class="accordion-item rounded-lg border border-surface-700 overflow-hidden"
            class:opacity-50={item.disabled}>
            <!-- Header -->
            <button
                type="button"
                onclick={() => toggle(item.id)}
                onkeydown={(e) => handleKeydown(e, item.id)}
                disabled={item.disabled}
                aria-expanded={open}
                aria-controls="accordion-panel-{item.id}"
                class="accordion-header w-full flex items-center justify-between gap-3 p-4 text-left bg-surface-800 hover:bg-surface-700/50 transition-colors disabled:cursor-not-allowed">
                <div class="flex items-center gap-3">
                    {#if item.icon}
                        <Icon src={item.icon} class="w-5 h-5 text-surface-400" />
                    {/if}
                    <span class="font-medium text-white">{item.title}</span>
                </div>

                <Icon
                    src={ChevronDown}
                    class="w-5 h-5 text-surface-400 transition-transform duration-200 {open
                        ? 'rotate-180'
                        : ''}" />
            </button>

            <!-- Panel -->
            {#if open}
                <div
                    id="accordion-panel-{item.id}"
                    transition:slide={{ duration: 200 }}
                    class="accordion-panel border-t border-surface-700">
                    <div class="p-4">
                        {@render content?.({ item, open })}
                    </div>
                </div>
            {/if}
        </div>
    {/each}
</div>
