<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import type { IconSource } from 'svelte-hero-icons';
    import { page } from '$app/stores';
    import { invalidateAll } from '$app/navigation';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import { addNavPin, removeNavPin } from '$lib/api/admin';
    import { getAllAdminNavPaths } from '$lib/config/admin-nav.js';

    interface Props {
        icon: IconSource;
        title: string;
        description?: string;
        /** Set false to hide pin button (e.g. Dashboard which is always pinned) */
        pinnable?: boolean;
        children?: import('svelte').Snippet;
    }

    let { icon, title, description, pinnable = true, children }: Props = $props();

    // Read navPins from layout data
    let navPins = $derived($page.data?.navPins as Array<{ href: string }> | undefined);
    let currentPath = $derived($page.url.pathname);
    // A stored pin href may carry `?query`/`#anchor` (legacy self-heal targets),
    // so match on its pathname and unpin with the href as stored.
    let pinnedHref = $derived(navPins?.find((p) => p.href.split(/[?#]/)[0] === currentPath)?.href);
    let isPinned = $derived(pinnedHref !== undefined);
    // Dashboard is always pinned, never show button
    let isDashboard = $derived(currentPath === '/admin');
    // Only nav-manifest pages can be pinned (the API refuses anything else).
    let showPinButton = $derived(
        pinnable &&
            !isDashboard &&
            navPins !== undefined &&
            (isPinned || getAllAdminNavPaths().has(currentPath)),
    );

    let toggling = $state(false);

    async function togglePin(): Promise<void> {
        toggling = true;
        const wasPinned = isPinned;
        try {
            const { error } = wasPinned
                ? await removeNavPin({ href: pinnedHref ?? currentPath })
                : await addNavPin({ href: currentPath, label: title });

            if (error) {
                throw new Error(error);
            }

            // Re-run layout load to refresh navPins everywhere
            await invalidateAll();

            toasts.success(wasPinned ? m.admin_pin_removed() : m.admin_pin_added());
        } catch (err) {
            toasts.error(err instanceof Error ? err.message : m.admin_pin_failed());
        } finally {
            toggling = false;
        }
    }
</script>

<!-- Stacks on phones: side by side, a two-word title and two buttons each
     wrapped into narrow columns. The header owns its gap to the content below
     (mb-6) so a page doesn't have to wrap it in a space-y parent; inside one,
     this wins over the parent's spacing, giving every admin page the same gap.
     Put header actions in `children`, not in a flex row beside the header. -->
<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="min-w-0">
        <h2 class="text-2xl font-semibold flex items-center gap-2">
            <Icon src={icon} class="w-7 h-7 text-cyan-400" />
            {title}
            {#if showPinButton}
                <button
                    type="button"
                    class="pin-toggle"
                    class:pin-toggle-active={isPinned}
                    onclick={togglePin}
                    disabled={toggling}
                    title={isPinned ? m.admin_pin_remove() : m.admin_pin_add()}
                    aria-label={isPinned ? m.admin_pin_remove() : m.admin_pin_add()}
                    aria-pressed={isPinned}>
                    <svg
                        class="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill={isPinned ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round">
                        <path d="M12 17v5" />
                        <path d="M9 2h6l-1 7h4l-1.5 4H7.5L6 9h4z" />
                    </svg>
                </button>
            {/if}
        </h2>
        {#if description}
            <p class="text-muted mt-1">{description}</p>
        {/if}
    </div>
    {#if children}
        <!--
            Group the action buttons so the parent `.between` (justify-between)
            sees exactly two items — the title block and this group — instead of
            spreading each button edge-to-edge across the header.
        -->
        <div class="flex items-center gap-2 flex-wrap sm:justify-end">
            {@render children()}
        </div>
    {/if}
</div>

<style>
    .pin-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border-radius: 0.375rem;
        color: rgb(107 114 128); /* surface-500 */
        transition: all 150ms ease;
        cursor: pointer;
        border: none;
        background: transparent;
    }

    .pin-toggle:hover {
        color: rgb(250 204 21); /* yellow-400 */
        background: rgb(250 204 21 / 0.1);
    }

    .pin-toggle-active {
        color: rgb(250 204 21); /* yellow-400 */
    }

    .pin-toggle-active:hover {
        color: rgb(239 68 68); /* red-400 — hint at "unpin" */
        background: rgb(239 68 68 / 0.1);
    }

    .pin-toggle:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
