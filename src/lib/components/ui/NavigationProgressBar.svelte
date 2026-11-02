<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { navigating } from '$app/stores';
    import * as m from '$lib/paraglide/messages';

    let { active }: { active?: boolean } = $props();

    const visible = $derived(!!active || !!$navigating);
</script>

{#if visible}
    <div class="nav-loading-bar" aria-label={m.loading_default()}>
        <div class="nav-loading-bar-inner"></div>
    </div>
{/if}

<style>
    .nav-loading-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        z-index: 501; /* Z.NAV_PROGRESS — above Z.NAVBAR (500) so it isn't hidden by the transparent header */
        overflow: hidden;
        background: rgba(56, 189, 248, 0.15);
    }

    .nav-loading-bar-inner {
        height: 100%;
        width: 40%;
        background: rgb(56 189 248);
        border-radius: 0 2px 2px 0;
        animation: nav-loading-slide 1.2s ease-in-out infinite;
    }

    @keyframes nav-loading-slide {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(350%);
        }
    }
</style>
