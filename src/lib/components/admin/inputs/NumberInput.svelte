<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { BaseInputProps } from './registry';
    import * as m from '$lib/paraglide/messages.js';

    interface Props extends BaseInputProps {}

    let { setting, value, disabled = false, envLocked = false, onchange }: Props = $props();

    // Effective disabled state
    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);
    // Env-locked settings are still disabled, but the value should stay legible —
    // the row itself already gets a "does not apply" dim from the parent, so
    // fading the input on top of that made ENV-set values unreadable.
    let dimForDisabled = $derived(isDisabled && !envLocked);
    let envLockTitle = $derived(envLocked ? m.admin_settings_input_env_locked_title() : undefined);

    // Calculate step for number inputs
    let step = $derived(setting.uiHints?.step ?? (setting.type === 'number' ? 1 : undefined));

    // Handle number input
    function handleNumberInput(e: Event) {
        const target = e.target as HTMLInputElement;
        const inputValue = target.value;

        // Don't dispatch change while user is typing a decimal number
        // (e.g., "0." or "0.2" being typed as "0.2_")
        if (inputValue.endsWith('.') || inputValue.endsWith('-')) {
            return;
        }

        const num = parseFloat(inputValue);
        if (!isNaN(num)) {
            onchange?.(num);
        }
    }

    // An emptied (or unparseable) box dispatches nothing, so it looked cleared
    // while the old value stayed in the form and was saved. When the field is
    // left, show the value that is actually in force again.
    function handleNumberCommit(e: Event) {
        const target = e.target as HTMLInputElement;
        if (Number.isNaN(parseFloat(target.value))) {
            target.value = value === undefined || value === null ? '' : String(value);
        }
    }
</script>

<!-- Number Input -->
<div class="flex items-center gap-2">
    <input
        type="number"
        id={setting.key}
        class="input input-sm w-full sm:w-28 placeholder:italic placeholder:text-surface-500
			{isDisabled ? 'cursor-not-allowed' : ''} {dimForDisabled ? 'opacity-50' : ''}"
        disabled={isDisabled}
        {value}
        min={setting.validation?.min}
        max={setting.validation?.max}
        {step}
        placeholder={setting.uiHints?.placeholder}
        title={envLockTitle}
        oninput={handleNumberInput}
        onchange={handleNumberCommit} />
    {#if setting.uiHints?.suffix}
        <span class="text-muted">{setting.uiHints.suffix}</span>
    {/if}
</div>

<style>
    /* Remove number input spinners */
    input[type='number']::-webkit-outer-spin-button,
    input[type='number']::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    input[type='number'] {
        -moz-appearance: textfield;
        appearance: textfield;
    }
</style>
