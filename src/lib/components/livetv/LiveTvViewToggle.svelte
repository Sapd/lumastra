<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/state';
    import { resolve } from '$lib/paths';
    import { Icon, Squares2x2, ListBullet } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    let isGuide = $derived(page.url.pathname.startsWith(resolve('/livetv/guide')));
    // Switching view keeps the selected category.
    let genreQuery = $derived.by(() => {
        const genre = page.url.searchParams.get('genre');
        return genre ? `?genre=${encodeURIComponent(genre)}` : '';
    });
</script>

<div class="view-toggle">
    <a
        href={resolve('/livetv') + genreQuery}
        aria-current={!isGuide ? 'page' : undefined}
        class="toggle-btn {!isGuide ? 'active' : ''}">
        <Icon src={Squares2x2} class="h-4 w-4" />
        <span>{m.livetv_view_grid()}</span>
    </a>
    <a
        href={resolve('/livetv/guide') + genreQuery}
        aria-current={isGuide ? 'page' : undefined}
        class="toggle-btn {isGuide ? 'active' : ''}">
        <Icon src={ListBullet} class="h-4 w-4" />
        <span>{m.livetv_view_guide()}</span>
    </a>
</div>

<style lang="postcss">
    .view-toggle {
        display: flex;
        gap: 0.25rem;
        background: var(--color-surface-700);
        border-radius: 0.5rem;
        padding: 0.25rem;
    }

    .toggle-btn {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.75rem;
        border-radius: 0.375rem;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--color-surface-300);
        text-decoration: none;
        transition: all 0.15s ease;
    }

    .toggle-btn.active {
        background: var(--color-surface-500);
        color: var(--color-surface-50);
    }

    .toggle-btn:hover:not(.active) {
        color: var(--color-surface-100);
    }
</style>
