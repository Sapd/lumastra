<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';

    interface Props {
        label: string;
        /** Optional explanation under the label. */
        hint?: string;
        value: number;
        min: number;
        max: number;
        onchange: (value: number) => void;
    }
    let { label, hint = '', value, min, max, onchange }: Props = $props();
    const id = $props.id();
    let invalid = $state(false);

    function change(event: Event): void {
        const input = event.currentTarget as HTMLInputElement;
        const next = input.valueAsNumber;
        invalid = !Number.isInteger(next) || next < min || next > max;
        if (!invalid) onchange(next);
    }
</script>

<div class="py-3 px-4">
    <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
            <label for={id} class="text-sm">{label}</label>
            {#if hint}
                <p id={`${id}-hint`} class="text-xs text-surface-400 mt-0.5">{hint}</p>
            {/if}
        </div>
        <div class="flex shrink-0 items-center gap-1">
            <input
                {id}
                type="number"
                {min}
                {max}
                step="1"
                required
                {value}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-error` : hint ? `${id}-hint` : undefined}
                class="input input-sm w-20 text-center"
                onchange={change} />
            <span class="text-xs text-surface-400">{m.settings_unit_seconds_short()}</span>
        </div>
    </div>
    {#if invalid}
        <p id={`${id}-error`} role="alert" class="text-sm text-error-400 mt-2">
            {m.viewer_settings_number_range({ min, max })}
        </p>
    {/if}
</div>
