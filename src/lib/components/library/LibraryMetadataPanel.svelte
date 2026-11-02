<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { getDetailFields } from '$lib/shared/library-metadata-panel.utils';
    import type { MetadataFieldDef } from '$lib/shared/library-type-templates';

    interface Props {
        fields: MetadataFieldDef[];
        metadata: Record<string, unknown>;
    }

    let { fields, metadata }: Props = $props();

    const detailFields = $derived(getDetailFields(fields, metadata));
</script>

{#if detailFields.length > 0}
    <div class="mb-4">
        <h3 class="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-2">
            {m.library_metadata_panel_title()}
        </h3>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {#each detailFields as field (field.key)}
                <dt class="text-xs text-surface-400 self-start pt-0.5">{field.label}</dt>
                <dd class="text-xs text-surface-200">
                    {#if field.formatted.type === 'boolean'}
                        <span
                            class={field.formatted.value
                                ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success-900/40 text-success-300'
                                : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-700 text-surface-400'}>
                            {field.formatted.value
                                ? m.library_metadata_boolean_yes()
                                : m.library_metadata_boolean_no()}
                        </span>
                    {:else if field.formatted.type === 'tags'}
                        <span class="flex flex-wrap gap-1">
                            {#each field.formatted.tags as tag, i (i + '-' + tag)}
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-surface-700 text-surface-300">
                                    {tag}
                                </span>
                            {/each}
                        </span>
                    {:else if field.formatted.type === 'date'}
                        {field.formatted.formatted}
                    {:else}
                        {field.formatted.text}
                    {/if}
                </dd>
            {/each}
        </dl>
    </div>
{/if}
