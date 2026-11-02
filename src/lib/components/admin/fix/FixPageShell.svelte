<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Chrome shared by every leaf page under /admin/fix.

  Two things belong on all of them and nowhere else: a way back to the symptom
  list, and the escape hatch. The escape hatch links to the EXISTING diagnostics
  export at /admin/system/diagnostics — this surface deliberately does not build
  a second one, because two "copy your system info" flows that drift apart is
  how bug reports end up carrying the older, thinner bundle.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, ArrowLeft, type IconSource } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import EscapeHatch from './EscapeHatch.svelte';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        title: string;
        description?: string;
        icon: IconSource;
        children: Snippet;
    }

    let { title, description, icon, children }: Props = $props();
</script>

<div class="space-y-6">
    <a
        href={resolve('/admin/fix')}
        class="inline-flex items-center gap-1 text-xs text-surface-400 hover:text-surface-200">
        <Icon src={ArrowLeft} class="h-3.5 w-3.5" />
        <span>{m.admin_fix_back_to_list()}</span>
    </a>

    <AdminPageHeader {icon} {title} {description} />

    {@render children()}

    <EscapeHatch />
</div>
