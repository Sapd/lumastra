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

    // Get display value for arrays
    function getArrayDisplayValue(val: unknown): string {
        if (Array.isArray(val)) {
            return val.join(', ');
        }
        return String(val || '');
    }

    // Handle array (comma-separated) input
    function handleArrayInput(e: Event) {
        const target = e.target as HTMLInputElement;
        // Store as string, will be parsed when saving
        onchange?.(target.value);
    }
</script>

<!-- Array (comma-separated) Input -->
<input
    type="text"
    id={setting.key}
    class="input input-sm w-64
		{isDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
    disabled={isDisabled}
    value={getArrayDisplayValue(value)}
    placeholder={setting.uiHints?.placeholder || m.admin_settings_array_placeholder()}
    oninput={handleArrayInput} />
