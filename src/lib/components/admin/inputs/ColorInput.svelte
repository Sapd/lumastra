<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { BaseInputProps } from './registry';
    import * as m from '$lib/paraglide/messages.js';
    import { HEX_COLOR_PATTERN } from '$lib/config/schema';

    interface Props extends BaseInputProps {}

    let { setting, value, disabled = false, envLocked = false, onchange }: Props = $props();

    // Effective disabled state
    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);
    // Env-locked settings are still disabled, but the text should stay legible —
    // the row itself already gets a "does not apply" dim from the parent, so
    // fading the input on top of that made ENV-set values unreadable.
    let dimForDisabled = $derived(isDisabled && !envLocked);
    let envLockTitle = $derived(envLocked ? m.admin_settings_input_env_locked_title() : undefined);

    let textValue = $derived(String(value ?? ''));

    // Same rule the server enforces on save (HEX_COLOR_PATTERN): #rgb, #rgba,
    // #rrggbb, #rrggbbaa. Only #rgb/#rrggbb (no alpha) can drive the native
    // <input type="color">, which has no alpha channel.
    let isValidHex = $derived(textValue === '' || HEX_COLOR_PATTERN.test(textValue.trim()));
    let hasError = $derived(!isValidHex);

    let swatchValue = $derived.by(() => {
        const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(textValue);
        if (!match) return undefined;
        const hex = match[1];
        if (hex.length === 3) {
            return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
        }
        return `#${hex}`;
    });

    let errorId = $derived(`${setting.key}-color-error`);

    function handleTextInput(e: Event) {
        onchange?.((e.target as HTMLInputElement).value);
    }

    function handleSwatchInput(e: Event) {
        onchange?.((e.target as HTMLInputElement).value);
    }
</script>

<!-- Color Input -->
<div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-2">
        {#if swatchValue}
            <input
                type="color"
                aria-label={m.admin_settings_color_swatch_label({ label: setting.label })}
                class="h-8 w-8 shrink-0 rounded border border-surface-500/50 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-50"
                value={swatchValue}
                disabled={isDisabled}
                title={envLockTitle}
                oninput={handleSwatchInput} />
        {/if}
        <input
            type="text"
            id={setting.key}
            class="input input-sm w-full sm:w-36 placeholder:italic placeholder:text-surface-500
				{isDisabled ? 'cursor-not-allowed' : ''} {dimForDisabled ? 'opacity-50' : ''}"
            disabled={isDisabled}
            value={textValue}
            placeholder={setting.uiHints?.placeholder}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : undefined}
            title={envLockTitle}
            oninput={handleTextInput} />
    </div>
    {#if hasError}
        <span id={errorId} class="text-xs text-red-400">{m.admin_settings_color_invalid()}</span>
    {/if}
</div>
