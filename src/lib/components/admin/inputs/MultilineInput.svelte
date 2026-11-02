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

    // Handle text input
    function handleTextInput(e: Event) {
        const target = e.target as HTMLInputElement;
        onchange?.(target.value);
    }
</script>

<!-- Multiline Text -->
<textarea
    id={setting.key}
    class="textarea input-sm w-64
		{isDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
    disabled={isDisabled}
    rows={setting.uiHints?.rows || 3}
    placeholder={setting.uiHints?.placeholder}
    value={String(value ?? '')}
    oninput={handleTextInput}></textarea>
