<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The list that IS /admin/fix.

  Deliberately a plain list of ten sentences and not a search box: search only
  helps someone who already knows the vocabulary, and not knowing the vocabulary
  is the entire reason this page exists. The operator's job here is recognition,
  not recall.

  Each row carries a badge saying whether the page behind it CHECKS this server
  or merely points the way. That badge is the honesty contract of the whole
  surface — see symptoms.ts.
-->
<script lang="ts">
    import { Icon, ArrowRight } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { SYMPTOMS } from './symptoms.js';
    import * as m from '$lib/paraglide/messages.js';
</script>

<ul class="space-y-2">
    {#each SYMPTOMS as symptom (symptom.id)}
        {@const isDiagnostic = symptom.kind === 'diagnostic'}
        <li>
            <a
                href={resolve(symptom.href)}
                class="group flex items-center gap-3 rounded border border-surface-700/50 bg-surface-800/40 p-3 transition-colors hover:border-primary-500/50 hover:bg-surface-800/80">
                <Icon
                    src={symptom.icon}
                    class="h-5 w-5 shrink-0 text-surface-400 group-hover:text-primary-400" />
                <span class="min-w-0 flex-1 text-sm text-surface-100">{symptom.title()}</span>
                <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-tight {isDiagnostic
                        ? 'bg-primary-500/15 text-primary-300'
                        : 'bg-surface-600/40 text-surface-300'}"
                    title={isDiagnostic
                        ? m.admin_fix_kind_diagnostic_hint()
                        : m.admin_fix_kind_signpost_hint()}>
                    {isDiagnostic ? m.admin_fix_kind_diagnostic() : m.admin_fix_kind_signpost()}
                </span>
                <Icon
                    src={ArrowRight}
                    class="h-4 w-4 shrink-0 text-surface-500 group-hover:text-primary-400" />
            </a>
        </li>
    {/each}
</ul>
