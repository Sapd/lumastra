<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  MetadataFieldRenderer — renders a single MetadataFieldDef as the appropriate input.
  Consumed by ContentEditDrawer (single-item full edit) and BulkEditBar (bulk field set).
-->

<script lang="ts">
    import type { MetadataFieldDef } from '$lib/shared/library-type-templates';

    interface Props {
        field: MetadataFieldDef;
        value: unknown;
        /** Distinct values fetched from API for autocompleteFrom fields */
        autocompleteOptions?: string[];
        onchange: (newValue: unknown) => void;
    }

    let { field, value, autocompleteOptions = [], onchange }: Props = $props();

    const inputClass =
        'w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none';

    // Datalist id — unique per field so multiple renderers on the same page don't collide
    const datalistId = $derived(`meta-datalist-${field.key}`);

    // -------------------------------------------------------------------------
    // Tags helpers
    // -------------------------------------------------------------------------

    /** Parse a tags value (string[] | string | null) → string[] */
    function parseTags(v: unknown): string[] {
        if (Array.isArray(v)) return v.map(String).filter(Boolean);
        if (typeof v === 'string') {
            return v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        return [];
    }

    function parseInitialTags(): string[] {
        return parseTags(value);
    }

    let tagInput = $state('');
    // eslint-disable-next-line svelte/prefer-writable-derived -- tags is also mutated directly in addTag/removeTag; $derived would discard local edits
    let tags = $state<string[]>(parseInitialTags());

    // When the parent value prop changes (e.g. drawer re-opens) resync tags
    $effect(() => {
        tags = parseTags(value);
    });

    function addTag(raw: string): void {
        const trimmed = raw.trim();
        if (!trimmed || tags.includes(trimmed)) return;
        tags = [...tags, trimmed];
        tagInput = '';
        onchange(tags);
    }

    function removeTag(tag: string): void {
        tags = tags.filter((t) => t !== tag);
        onchange(tags);
    }

    function handleTagKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag(tagInput);
        } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
            removeTag(tags[tags.length - 1] ?? '');
        }
    }

    // -------------------------------------------------------------------------
    // Scalar value helpers
    // -------------------------------------------------------------------------

    function asString(v: unknown): string {
        if (v == null) return '';
        return String(v);
    }

    function asBoolean(v: unknown): boolean {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return v === 'true' || v === '1';
        return Boolean(v);
    }

    function asNumber(v: unknown): string {
        if (v == null || v === '') return '';
        return String(v);
    }
</script>

{#if field.type === 'text'}
    <div class="space-y-1">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="mfr-{field.key}">
            {field.label}
        </label>
        <input
            id="mfr-{field.key}"
            type="text"
            class={inputClass}
            value={asString(value)}
            list={autocompleteOptions.length > 0 ? datalistId : undefined}
            oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value || null)} />
        {#if autocompleteOptions.length > 0}
            <datalist id={datalistId}>
                {#each autocompleteOptions as opt (opt)}
                    <option value={opt}></option>
                {/each}
            </datalist>
        {/if}
    </div>
{:else if field.type === 'date'}
    <div class="space-y-1">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="mfr-{field.key}">
            {field.label}
        </label>
        <input
            id="mfr-{field.key}"
            type="date"
            class={inputClass}
            value={asString(value)}
            onchange={(e) => onchange((e.currentTarget as HTMLInputElement).value || null)} />
    </div>
{:else if field.type === 'number'}
    <div class="space-y-1">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="mfr-{field.key}">
            {field.label}
        </label>
        <input
            id="mfr-{field.key}"
            type="number"
            class={inputClass}
            value={asNumber(value)}
            oninput={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                onchange(v === '' ? null : Number(v));
            }} />
    </div>
{:else if field.type === 'boolean'}
    <div class="flex items-center justify-between gap-3">
        <span class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            >{field.label}</span>
        <label class="relative inline-flex items-center cursor-pointer">
            <input
                type="checkbox"
                class="sr-only peer"
                checked={asBoolean(value)}
                onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)} />
            <div
                class="w-10 h-5 bg-surface-700 rounded-full peer peer-checked:bg-primary-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5">
            </div>
        </label>
    </div>
{:else if field.type === 'select'}
    <div class="space-y-1">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="mfr-{field.key}">
            {field.label}
        </label>
        <select
            id="mfr-{field.key}"
            class={inputClass}
            value={asString(value)}
            onchange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                onchange(v || null);
            }}>
            <option value="">— None —</option>
            {#each field.options ?? [] as opt (opt)}
                <option value={opt}>{opt}</option>
            {/each}
        </select>
    </div>
{:else if field.type === 'tags'}
    <div class="space-y-1.5">
        <span class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            >{field.label}</span>
        <!-- Existing tag pills -->
        {#if tags.length > 0}
            <div class="flex flex-wrap gap-1.5">
                {#each tags as tag (tag)}
                    <span
                        class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary-500/15 text-primary-300 border border-primary-500/20">
                        {tag}
                        <button
                            type="button"
                            class="text-primary-400 hover:text-primary-200 leading-none"
                            onclick={() => removeTag(tag)}
                            aria-label="Remove {tag}">
                            &times;
                        </button>
                    </span>
                {/each}
            </div>
        {/if}
        <!-- Tag input -->
        <input
            type="text"
            class={inputClass}
            placeholder="Add tag… (Enter or comma to add)"
            bind:value={tagInput}
            list={autocompleteOptions.length > 0 ? datalistId : undefined}
            onkeydown={handleTagKeydown}
            onblur={() => {
                if (tagInput.trim()) addTag(tagInput);
            }} />
        {#if autocompleteOptions.length > 0}
            <datalist id={datalistId}>
                {#each autocompleteOptions as opt (opt)}
                    <option value={opt}></option>
                {/each}
            </datalist>
        {/if}
    </div>
{/if}
