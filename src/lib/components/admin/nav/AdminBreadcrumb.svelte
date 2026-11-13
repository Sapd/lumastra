<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin breadcrumb (admin IA redesign, spec §4) — "Section / Page" derived from
  the nav manifest. Section link targets the section landing; the page segment is
  the current page.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { findNavPage } from '$lib/config/admin-nav.js';
    import ModuleBadge from './ModuleBadge.svelte';

    let hit = $derived(findNavPage($page.url.pathname));
    let sectionLanding = $derived(hit ? hit.section.pages[0].path : '/admin');
    // Show the section segment everywhere except Home. It used to be dropped on
    // every section's LANDING page too, so /admin/tasks read "Admin › Overview"
    // — which overview? — while the page's own heading said something else.
    let showSection = $derived(hit ? sectionLanding !== '/admin' : false);
</script>

{#if hit}
    <nav class="breadcrumb" aria-label={m.admin_nav_breadcrumb_label()}>
        {#if showSection}
            <a class="crumb crumb-link" href={resolve(sectionLanding)}>{hit.section.title()}</a>
            <span class="sep" aria-hidden="true">/</span>
        {/if}
        <span class="crumb crumb-current" aria-current="page">{hit.page.title()}</span>
        {#if hit.page.privateModule}
            <ModuleBadge compact />
        {/if}
    </nav>
{/if}

<style>
    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        min-width: 0;
        font-size: 0.8125rem;
        color: rgb(156 163 175); /* surface-400 */
    }
    .crumb {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .crumb-link {
        color: rgb(156 163 175);
        text-decoration: none;
        transition: color 120ms ease;
    }
    .crumb-link:hover {
        color: rgb(229 231 235); /* surface-200 */
    }
    .crumb-current {
        color: rgb(229 231 235);
        font-weight: 600;
    }
    .sep {
        color: rgb(75 85 99); /* surface-600 */
    }
</style>
