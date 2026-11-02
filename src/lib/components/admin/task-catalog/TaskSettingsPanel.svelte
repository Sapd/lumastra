<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { apiGet, apiPut } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        TaskSettingsResponseSchema,
        OkResponseSchema,
    } from '$lib/schemas/task-definition.schema.js';
    import type {
        TaskSettingsResponse,
        TaskSettingsField,
    } from '$lib/schemas/task-definition.schema.js';

    interface Props {
        taskId: string;
    }

    let { taskId }: Props = $props();

    let settings = $state<TaskSettingsResponse | null>(null);
    let basicFields = $derived(settings?.fields.filter((f) => !f.advanced) ?? []);
    let advancedFields = $derived(settings?.fields.filter((f) => f.advanced === true) ?? []);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let localValues = $state<Record<string, unknown>>({});
    let localSecrets = $state<Record<string, string>>({});
    let pristineValues = $state<Record<string, unknown>>({});
    let saving = $state(false);
    let fetchToken = 0;
    let destroyed = false;

    function deepEqual(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (a === null || b === null) return a === b;
        if (typeof a !== typeof b) return false;
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
        }
        if (typeof a === 'object' && typeof b === 'object') {
            const aKeys = Object.keys(a as object).sort();
            const bKeys = Object.keys(b as object).sort();
            if (!deepEqual(aKeys, bKeys)) return false;
            return aKeys.every((k) =>
                deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
            );
        }
        return false;
    }

    // SDK select options are `{ value, label }` objects (SettingField.options).
    // Stringifying the whole object yields "[object Object]" for every entry —
    // which collapses the {#each} keys to a single duplicate and crashes the
    // render (svelte each_key_duplicate). Read value/label explicitly, with a
    // primitive fallback for any plugin that declares bare-string options.
    function optionValue(opt: unknown): string {
        if (opt !== null && typeof opt === 'object' && 'value' in opt) {
            return String((opt as { value: unknown }).value);
        }
        return String(opt);
    }
    function optionLabel(opt: unknown): string {
        if (opt !== null && typeof opt === 'object') {
            const o = opt as { label?: unknown; value?: unknown };
            if (o.label != null) return String(o.label);
            if (o.value != null) return String(o.value);
        }
        return String(opt);
    }

    let dirty = $derived.by(() => {
        if (!settings) return false;
        for (const f of settings.fields.filter((f) => f.type !== 'secret')) {
            if (!deepEqual(localValues[f.key] ?? null, pristineValues[f.key] ?? null)) return true;
        }
        for (const key of Object.keys(localSecrets)) {
            if (localSecrets[key] !== '') return true;
        }
        return false;
    });

    async function load(): Promise<void> {
        const my = ++fetchToken;
        loading = true;
        loadError = null;

        const { data, error } = await apiGet(
            `/api/tasks/${encodeURIComponent(taskId)}/settings`,
            TaskSettingsResponseSchema,
        );

        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            loadError = error ?? 'Could not load settings';
        } else {
            settings = data;
            localValues = { ...data.values };
            pristineValues = { ...data.values };
            localSecrets = {};
        }
        loading = false;
    }

    async function save(): Promise<void> {
        if (!dirty || saving) return;
        saving = true;
        try {
            const payload: {
                values?: Record<string, unknown>;
                secrets?: Record<string, string>;
            } = {};

            const changedValues: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(localValues)) {
                if (!deepEqual(v ?? null, pristineValues[k] ?? null)) {
                    changedValues[k] = v;
                }
            }
            if (Object.keys(changedValues).length > 0) payload.values = changedValues;

            const nonEmptySecrets: Record<string, string> = {};
            for (const [k, v] of Object.entries(localSecrets)) {
                if (v !== '') nonEmptySecrets[k] = v;
            }
            if (Object.keys(nonEmptySecrets).length > 0) payload.secrets = nonEmptySecrets;

            const { error } = await apiPut(
                `/api/tasks/${encodeURIComponent(taskId)}/settings`,
                OkResponseSchema,
                payload,
            );

            if (error) {
                toasts.error(`Save failed: ${error}`);
            } else {
                toasts.success('Settings saved');
                // Mark only what was SENT as saved: fields edited while the PUT
                // was in flight stay dirty instead of silently counting as saved.
                pristineValues = { ...pristineValues, ...changedValues };
                // Reflect newly-saved secrets immediately so the "••••••••"
                // set-indicator appears without a page reload (the GET only
                // returns which keys are set, never the values).
                if (settings && Object.keys(nonEmptySecrets).length > 0) {
                    const existing = settings.secrets ?? [];
                    const added = Object.keys(nonEmptySecrets).filter((k) => !existing.includes(k));
                    if (added.length > 0) {
                        settings = { ...settings, secrets: [...existing, ...added] };
                    }
                }
                // Clear only the secrets that were sent and not retyped meanwhile.
                localSecrets = Object.fromEntries(
                    Object.entries(localSecrets).filter(([k, v]) => nonEmptySecrets[k] !== v),
                );
            }
        } finally {
            saving = false;
        }
    }

    function setField(field: TaskSettingsField, value: unknown): void {
        localValues = { ...localValues, [field.key]: value };
    }

    function setSecret(key: string, value: string): void {
        localSecrets = { ...localSecrets, [key]: value };
    }

    function getNumberValue(field: TaskSettingsField): number {
        const val = localValues[field.key] ?? field.default;
        if (typeof val === 'number') return val;
        const n = Number(val);
        if (Number.isNaN(n)) {
            console.warn(`[TaskSettingsPanel] Non-numeric value for field "${field.key}":`, val);
            const def = typeof field.default === 'number' ? field.default : undefined;
            return def ?? 0;
        }
        return n;
    }

    onMount(() => {
        return () => {
            destroyed = true;
        };
    });

    $effect(() => {
        // Reading taskId makes this effect re-run when the prop changes.
        // $effect fires once on mount, so no separate onMount load() needed.
        // Skip while taskId is missing so the initial render doesn't fetch
        // /api/tasks/undefined/settings.
        if (!taskId) return;
        void load();
    });
</script>

<div class="space-y-6">
    {#if loading}
        <div class="py-6 text-center text-sm text-surface-500">Loading settings…</div>
    {:else if loadError}
        <div class="rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
            {loadError}
            <button
                type="button"
                class="ml-3 text-xs text-red-200 underline"
                onclick={() => void load()}>
                Retry
            </button>
        </div>
    {:else if !settings || settings.fields.length === 0}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
            No configurable settings for this task.
        </div>
    {:else}
        <div class="space-y-5">
            {#snippet fieldRow(field: TaskSettingsField)}
                <div>
                    <label
                        class="block text-sm font-medium text-surface-300 mb-1"
                        for="setting-{taskId}-{field.key}">
                        {field.label}
                        {#if field.required}
                            <span class="text-red-400 ml-0.5">*</span>
                        {/if}
                    </label>
                    {#if field.description}
                        <p class="text-xs text-surface-500 mb-2">
                            {field.description}
                        </p>
                    {/if}

                    {#if field.type === 'secret'}
                        <div class="flex items-center gap-2">
                            {#if settings?.secrets.includes(field.key)}
                                <span class="text-xs text-surface-500 italic mr-1">••••••••</span>
                            {/if}
                            <input
                                id="setting-{taskId}-{field.key}"
                                type="password"
                                autocomplete="new-password"
                                class="flex-1 rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 focus:border-surface-500 focus:outline-none"
                                placeholder={settings?.secrets.includes(field.key)
                                    ? 'Replace value…'
                                    : 'Enter value…'}
                                value={localSecrets[field.key] ?? ''}
                                oninput={(e) => setSecret(field.key, e.currentTarget.value)} />
                        </div>
                    {:else if field.type === 'boolean'}
                        <label class="flex cursor-pointer items-center gap-2">
                            <input
                                id="setting-{taskId}-{field.key}"
                                type="checkbox"
                                class="h-4 w-4 rounded border-surface-600 bg-surface-900 text-blue-500 focus:ring-0"
                                checked={Boolean(localValues[field.key] ?? field.default)}
                                onchange={(e) => setField(field, e.currentTarget.checked)} />
                            <span class="text-sm text-surface-400">
                                {(localValues[field.key] ?? field.default) ? 'Enabled' : 'Disabled'}
                            </span>
                        </label>
                    {:else if field.type === 'number'}
                        <input
                            id="setting-{taskId}-{field.key}"
                            type="number"
                            class="w-full rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 focus:border-surface-500 focus:outline-none"
                            value={getNumberValue(field)}
                            min={field.validation?.min}
                            max={field.validation?.max}
                            oninput={(e) => {
                                const n = e.currentTarget.valueAsNumber;
                                if (Number.isNaN(n)) {
                                    // Empty input — revert to the saved value. Dropping the
                                    // key made the panel dirty while sending nothing, so
                                    // Save reported success for a change never made.
                                    if (field.key in pristineValues) {
                                        setField(field, pristineValues[field.key]);
                                    } else {
                                        const { [field.key]: _dropped, ...rest } = localValues;
                                        localValues = rest;
                                    }
                                } else {
                                    setField(field, n);
                                }
                            }} />
                        {#if field.validation?.min !== undefined || field.validation?.max !== undefined}
                            <p class="mt-1 text-xs text-surface-500">
                                {#if field.validation?.min !== undefined && field.validation?.max !== undefined}
                                    Range: {field.validation.min} – {field.validation.max}
                                {:else if field.validation?.min !== undefined}
                                    Min: {field.validation.min}
                                {:else}
                                    Max: {field.validation.max}
                                {/if}
                            </p>
                        {/if}
                    {:else if field.options && Array.isArray(field.options) && field.options.length > 0}
                        <select
                            id="setting-{taskId}-{field.key}"
                            class="w-full rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 focus:border-surface-500 focus:outline-none"
                            value={String(localValues[field.key] ?? field.default ?? '')}
                            onchange={(e) => {
                                const raw = e.currentTarget.value;
                                const isNumericField =
                                    field.type === 'number' || typeof field.default === 'number';
                                if (isNumericField) {
                                    const n = Number(raw);
                                    setField(field, Number.isFinite(n) ? n : raw);
                                } else {
                                    setField(field, raw);
                                }
                            }}>
                            {#each field.options as opt (optionValue(opt))}
                                <option value={optionValue(opt)}>{optionLabel(opt)}</option>
                            {/each}
                        </select>
                    {:else}
                        <input
                            id="setting-{taskId}-{field.key}"
                            type="text"
                            class="w-full rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 focus:border-surface-500 focus:outline-none"
                            value={String(localValues[field.key] ?? field.default ?? '')}
                            oninput={(e) => setField(field, e.currentTarget.value)} />
                    {/if}
                </div>
            {/snippet}

            <!-- Everyday settings first; tuning knobs a task marks `advanced`
                 fold away below. The intro analyzer opened as twenty fields in
                 one list, its chromaprint bit-shift beside its on/off switches. -->
            {#each basicFields as field (field.key)}
                {@render fieldRow(field)}
            {/each}

            {#if advancedFields.length > 0}
                <details class="rounded border border-surface-700/50 bg-surface-900/20 p-3">
                    <summary class="cursor-pointer text-sm font-medium text-surface-300">
                        {m.admin_task_settings_advanced({ count: advancedFields.length })}
                    </summary>
                    <p class="mt-2 text-xs text-surface-500">
                        {m.admin_task_settings_advanced_hint()}
                    </p>
                    <div class="mt-4 space-y-5">
                        {#each advancedFields as field (field.key)}
                            {@render fieldRow(field)}
                        {/each}
                    </div>
                </details>
            {/if}

            <div class="flex items-center gap-3 border-t border-surface-700/40 pt-4">
                <button
                    type="button"
                    class="rounded bg-blue-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                    onclick={save}
                    disabled={!dirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                </button>
                {#if dirty}
                    <span class="text-xs text-amber-400">Unsaved changes</span>
                {/if}
            </div>
        </div>
    {/if}
</div>
