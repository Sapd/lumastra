<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { BaseInputProps } from './registry';

    interface Props extends BaseInputProps {}

    let { setting, value, disabled = false, envLocked = false, onchange }: Props = $props();

    // Effective disabled state
    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);

    /**
     * Some settings (the `DISABLE_*` killswitches) store an "off means running"
     * boolean but are labeled positively ("Run this task"). `uiHints.invert`
     * flips only what the switch SHOWS — the on/off position and its
     * aria-checked state — never the stored value, so the env var and the
     * persisted config key keep meaning exactly what their name says.
     */
    let displayChecked = $derived(setting.uiHints?.invert ? !value : !!value);

    // Handle toggle — always flips the STORED value, regardless of display inversion.
    function handleToggle() {
        if (!isDisabled) {
            onchange?.(!value);
        }
    }
</script>

<!-- Toggle Switch -->
<!-- id like every other input, so a <label for={key}> names the switch. -->
<button
    type="button"
    id={setting.key}
    role="switch"
    aria-checked={displayChecked}
    aria-label={setting.label}
    class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-hidden focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 focus:ring-offset-surface-800
		{displayChecked ? 'bg-yellow-500' : 'bg-surface-600'}
		{isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}"
    disabled={isDisabled}
    onclick={handleToggle}>
    <span
        class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform
			{displayChecked ? 'translate-x-6' : 'translate-x-1'}"></span>
</button>
