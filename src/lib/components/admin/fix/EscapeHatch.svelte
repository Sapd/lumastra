<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The way out, at the bottom of the index and of every diagnostic.

  It links to the EXISTING report at /admin/system/diagnostics rather than
  offering its own export. Two "copy your system info" flows inevitably drift,
  and the one that drifts is the one a bug report ends up carrying.
-->
<script lang="ts">
    import { Icon, Lifebuoy } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
</script>

<div
    class="flex flex-col gap-2 rounded border border-surface-700/50 bg-surface-800/40 p-4 sm:flex-row sm:items-center sm:justify-between">
    <div class="space-y-1">
        <p class="text-sm font-medium text-surface-100">{m.admin_fix_escape_title()}</p>
        <p class="text-xs text-surface-400">{m.admin_fix_escape_body()}</p>
    </div>
    <a
        href={resolve('/admin/system/diagnostics')}
        class="btn btn-sm variant-soft inline-flex shrink-0 items-center gap-1">
        <Icon src={Lifebuoy} class="h-4 w-4" />
        <span>{m.admin_fix_escape_link()}</span>
    </a>
</div>
