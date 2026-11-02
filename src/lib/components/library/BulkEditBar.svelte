<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  BulkEditBar — slide-up action bar shown when items are selected in bulk-select mode.
  Allows picking one metadata field and applying a value to all selected items.
-->

<script lang="ts">
    import type { MetadataFieldDef } from '$lib/shared/library-type-templates';
    import { bulkUpdateMediaMetadata, getLibraryMetadataValues } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import MetadataFieldRenderer from './MetadataFieldRenderer.svelte';

    interface Props {
        selectedIds: string[];
        /** All template fields available for bulk editing */
        metadataFields: MetadataFieldDef[];
        mediaType: string;
        oncancel: () => void;
        onsaved: () => void;
    }

    let { selectedIds, metadataFields, mediaType, oncancel, onsaved }: Props = $props();

    let selectedFieldKey = $state<string>('');
    let fieldValue = $state<unknown>(null);
    let applying = $state(false);
    let autocompleteOptions = $state<string[]>([]);

    let selectedField = $derived(metadataFields.find((f) => f.key === selectedFieldKey) ?? null);

    // When field selection changes, reset value and fetch autocomplete options
    $effect(() => {
        const field = selectedField;
        fieldValue = null;
        autocompleteOptions = [];
        if (!field || !field.autocompleteFrom) return;
        void getLibraryMetadataValues(mediaType, field.autocompleteFrom).then(({ data }) => {
            if (data?.values) autocompleteOptions = data.values;
        });
    });

    async function handleApply(): Promise<void> {
        if (!selectedField || selectedIds.length === 0 || fieldValue === null || fieldValue === '')
            return;
        applying = true;
        try {
            const { data, error } = await bulkUpdateMediaMetadata(selectedIds, {
                [selectedField.key]: fieldValue,
            });
            if (error) {
                toasts.error('Bulk update failed: ' + error);
                return;
            }
            toasts.success(`Updated ${data?.updatedCount ?? selectedIds.length} items`);
            onsaved();
            oncancel();
        } finally {
            applying = false;
        }
    }
</script>

<!-- Slide-up bar -->
<div
    class="fixed bottom-0 left-0 right-0 bg-surface-800 border-t border-surface-600 shadow-2xl px-6 py-4 flex flex-wrap items-end gap-4"
    style="z-index: 50;"
    role="region"
    aria-label="Bulk edit bar">
    <!-- Selection count -->
    <div class="shrink-0">
        <p class="text-sm font-semibold text-white">{selectedIds.length} selected</p>
        <button
            class="text-xs text-surface-400 hover:text-surface-300 underline mt-0.5"
            onclick={oncancel}>
            Deselect all
        </button>
    </div>

    <!-- Field picker -->
    <div class="flex flex-col gap-1 flex-1 min-w-40">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="bulk-field-picker">
            Field to set
        </label>
        <select
            id="bulk-field-picker"
            class="px-3 py-2 bg-surface-700 border border-surface-600 rounded-lg text-sm text-white focus:outline-none focus:border-primary-500"
            bind:value={selectedFieldKey}>
            <option value="">— Choose field —</option>
            {#each metadataFields as field (field.key)}
                <option value={field.key}>{field.label}</option>
            {/each}
        </select>
    </div>

    <!-- Value input (only when a field is selected) -->
    {#if selectedField}
        <div class="flex flex-col gap-1 flex-1 min-w-48">
            <MetadataFieldRenderer
                field={selectedField}
                value={fieldValue}
                {autocompleteOptions}
                onchange={(v) => {
                    fieldValue = v;
                }} />
        </div>
    {/if}

    <!-- Actions -->
    <div class="flex gap-2 shrink-0">
        <button
            class="btn variant-filled-primary text-sm px-5 py-2"
            onclick={handleApply}
            disabled={applying ||
                !selectedField ||
                selectedIds.length === 0 ||
                fieldValue === null ||
                fieldValue === ''}>
            {applying ? 'Applying…' : 'Apply'}
        </button>
        <button
            class="btn variant-ghost-surface text-sm px-4 py-2"
            onclick={oncancel}
            disabled={applying}>
            Cancel
        </button>
    </div>
</div>
