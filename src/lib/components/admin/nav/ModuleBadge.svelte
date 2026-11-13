<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Small "Private" pill for admin-nav entries whose page carries the manifest's
  `privateModule` flag (admin-nav.ts). Marks a private module in the nav
  renderers (mega-menu, mobile drawer, breadcrumb). Amber/bronze tint stays
  distinct from the
  gold active-link colour and the indigo developer-tools accent.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** Slightly smaller variant for dense rows (drawer/breadcrumb). */
        compact?: boolean;
    }
    let { compact = false }: Props = $props();
</script>

<span
    class="ent-badge"
    class:ent-badge-compact={compact}
    title={m.admin_nav_module_badge_title()}>
    {m.admin_nav_module_badge()}
</span>

<style>
    .ent-badge {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: 0.0625rem 0.375rem;
        font-size: 0.625rem;
        font-weight: 700;
        line-height: 1.4;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: rgb(251 191 36); /* amber-400 */
        background: rgb(180 120 20 / 0.14);
        border: 1px solid rgb(217 160 60 / 0.4);
        border-radius: 9999px;
        white-space: nowrap;
    }
    .ent-badge-compact {
        padding: 0 0.3125rem;
        font-size: 0.5625rem;
    }
</style>
