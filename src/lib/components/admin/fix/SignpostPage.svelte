<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Renders one entry from signposts.ts.

  The disclaimer at the top is not boilerplate to be trimmed later. A page that
  reads like a diagnostic but silently checked nothing is worse than no page:
  the operator finishes it believing the checks were done and stops looking.
  Stating it plainly is what lets the "Checks this server" badge on the index
  mean something.
-->
<script lang="ts">
    import { Icon, InformationCircle, ArrowTopRightOnSquare } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import type { Signpost } from './signposts.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        signpost: Signpost;
    }

    let { signpost }: Props = $props();
</script>

<div class="space-y-5">
    <p
        class="flex items-start gap-2 rounded border border-surface-600/40 bg-surface-800/40 p-3 text-xs text-surface-300">
        <Icon src={InformationCircle} class="mt-px h-4 w-4 shrink-0 text-surface-400" />
        <span>{m.admin_fix_signpost_disclaimer()}</span>
    </p>

    <p class="text-sm leading-relaxed text-surface-100">{signpost.lede()}</p>
    <p class="text-sm leading-relaxed text-surface-300">{signpost.body()}</p>

    <div class="space-y-2">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-surface-400">
            {m.admin_fix_where_to_look()}
        </h3>
        <ul class="space-y-2">
            {#each signpost.links as link (link.path + (link.query ?? ''))}
                <li>
                    <a
                        href="{resolve(link.path)}{link.query ?? ''}"
                        class="group flex items-center gap-2 rounded border border-surface-700/50 bg-surface-800/40 p-3 text-sm text-surface-100 transition-colors hover:border-primary-500/50 hover:bg-surface-800/80">
                        <span class="min-w-0 flex-1">{link.label()}</span>
                        <Icon
                            src={ArrowTopRightOnSquare}
                            class="h-4 w-4 shrink-0 text-surface-500 group-hover:text-primary-400" />
                    </a>
                </li>
            {/each}
        </ul>
    </div>
</div>
