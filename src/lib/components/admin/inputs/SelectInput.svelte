<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { BaseInputProps, SettingOption } from './registry';
    import * as m from '$lib/paraglide/messages.js';

    interface Props extends BaseInputProps {}

    let {
        setting,
        value,
        disabled = false,
        envLocked = false,
        allValues = {},
        onchange,
    }: Props = $props();

    // Effective disabled state
    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);
    // Env-locked settings are still disabled, but the value should stay legible —
    // the row itself already gets a "does not apply" dim from the parent, so
    // fading the input on top of that made ENV-set values unreadable.
    let dimForDisabled = $derived(isDisabled && !envLocked);
    let envLockTitle = $derived(envLocked ? m.admin_settings_input_env_locked_title() : undefined);

    // Filter options based on optionDependencies
    // Options may live in validation.options (most settings) or the top-level options array
    let filteredOptions = $derived(
        (setting.validation?.options ?? setting.options ?? []).filter((option: SettingOption) => {
            const deps = setting.validation?.optionDependencies;
            if (!deps) return true;
            const depKey = deps[String(option.value)];
            if (!depKey) return true;
            return !!allValues[depKey];
        }),
    );

    // Handle select change
    function handleSelect(e: Event) {
        const target = e.target as HTMLSelectElement;
        onchange?.(target.value);
    }
</script>

<!-- Select Dropdown -->
<select
    id={setting.key}
    class="select input-sm w-full sm:w-48
		{isDisabled ? 'cursor-not-allowed' : ''} {dimForDisabled ? 'opacity-50' : ''}"
    disabled={isDisabled}
    {value}
    title={envLockTitle}
    onchange={handleSelect}>
    {#each filteredOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
    {/each}
</select>
