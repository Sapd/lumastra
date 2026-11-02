<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { normalizeLanguageTag } from '$lib/shared/metadata-language';
    import type { BaseInputProps } from './registry';
    import { checkProviderHealth } from '$lib/api/admin';
    import { url } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { SECRET_CONFIGURED_SENTINEL, isSecretSentinel } from '$lib/shared/secret-sentinel';
    import { PROVIDER_CONNECTION_KEYS } from '$lib/shared/provider-connection-keys';

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

    // Health check state
    let healthResult = $state<'loading' | 'success' | 'error'>('success');
    let healthInfo = $state<string>('');

    const provider = $derived(setting.uiHints?.healthCheckProvider);
    const connectionKeys = $derived(provider ? PROVIDER_CONNECTION_KEYS[provider] : undefined);

    // The form values the check runs against — the operator's current (maybe
    // unsaved) URL and API key, not the saved config.
    let testOverrides = $derived.by((): Record<string, string> => {
        if (!connectionKeys) return {};
        const out: Record<string, string> = { [connectionKeys.url]: String(value ?? '') };
        const key = allValues[connectionKeys.apiKey];
        if (typeof key === 'string') out[connectionKeys.apiKey] = key;
        return out;
    });
    let testSignature = $derived(JSON.stringify(testOverrides));
    // A result only describes the values it was run against: editing the URL
    // or the key drops it back to "Test connection" instead of leaving a stale
    // "Connected" next to a value nobody tested.
    let testedSignature = $state<string | null>(null);
    let healthState = $derived<'idle' | 'loading' | 'success' | 'error'>(
        testedSignature === testSignature ? healthResult : 'idle',
    );
    let canTest = $derived(String(value ?? '').trim() !== '' && !hasUrlErrorForTest());
    function hasUrlErrorForTest(): boolean {
        return isUrlType && !isValidUrlValue(String(value ?? ''));
    }

    // Secrets arrive masked: the sentinel means "a value is stored", '' means
    // "not set". The input never shows the sentinel; typing replaces the stored
    // value, and emptying the box again reverts to "keep stored" — removing a
    // stored secret takes the explicit Clear button, so a stray backspace can't.
    let isSensitive = $derived(!!setting.uiHints?.sensitive);
    // svelte-ignore state_referenced_locally
    const storedAtLoad = isSecretSentinel(value);
    let secretStored = $derived(isSensitive && isSecretSentinel(value));
    let secretCleared = $derived(isSensitive && storedAtLoad && value === '');
    let inputValue = $derived(secretStored ? '' : String(value ?? ''));
    let placeholderText = $derived(
        isSensitive
            ? secretStored
                ? envLocked
                    ? m.admin_settings_secret_stored_env()
                    : m.admin_settings_secret_stored()
                : m.admin_settings_secret_not_set()
            : setting.uiHints?.placeholder,
    );

    let isUrlType = $derived(setting.type === 'url');
    let textValue = $derived(String(value ?? ''));

    // Root-relative paths (the app's own documented convention, e.g.
    // "/custom/logo.png") and absolute http(s) URLs are both valid. A native
    // type="url" input rejects the former, which is why this renders type="text"
    // with inputmode="url" instead and validates by hand.
    // Mirrors the server's save-time rule (validateSettingFormat in schema.ts).
    function isValidUrlValue(v: string): boolean {
        return v === '' || /^(?:https?:\/\/\S+|\/\S*)$/i.test(v.trim());
    }

    // Unchanged legacy and environment-owned values must not block other settings.
    // svelte-ignore state_referenced_locally
    const languageAtLoad = String(value ?? '');
    const hasLanguageError = $derived(
        !!setting.validation?.languageTag &&
            !envLocked &&
            textValue !== languageAtLoad &&
            !normalizeLanguageTag(textValue),
    );
    const languageErrorId = $derived(`${setting.key}-language-error`);

    let hasUrlError = $derived(isUrlType && !isValidUrlValue(textValue));
    let urlErrorId = $derived(`${setting.key}-url-error`);

    let hasImagePreview = $derived(setting.uiHints?.preview === 'image');

    let previewSrc = $derived.by(() => {
        if (!hasImagePreview || textValue === '') return undefined;
        return textValue.startsWith('/') ? url(textValue) : textValue;
    });

    // Tracks which src last failed to load, rather than a plain boolean, so the
    // "failed" state clears itself the moment the value (and therefore
    // previewSrc) changes — no effect needed to reset it by hand.
    let failedPreviewSrc = $state<string | undefined>(undefined);
    let imageLoadFailed = $derived(
        failedPreviewSrc !== undefined && failedPreviewSrc === previewSrc,
    );

    function handleImageError() {
        failedPreviewSrc = previewSrc;
    }

    // Handle text input
    function handleTextInput(e: Event) {
        const target = e.target as HTMLInputElement;
        if (isSensitive && storedAtLoad && target.value === '') {
            onchange?.(SECRET_CONFIGURED_SENTINEL);
            return;
        }
        onchange?.(target.value);
    }

    async function testConnection() {
        if (!provider || !canTest) return;
        const signature = testSignature;
        testedSignature = signature;
        healthResult = 'loading';
        healthInfo = '';
        const { data, error } = await checkProviderHealth(
            provider,
            connectionKeys ? testOverrides : undefined,
        );
        if (testedSignature !== signature) return; // values changed mid-test
        if (error || !data) {
            healthResult = 'error';
            healthInfo = error || m.admin_settings_test_connection_failed();
            return;
        }
        if (data.healthy) {
            healthResult = 'success';
            const info = data.serverInfo;
            const parts: string[] = [`${data.latencyMs}ms`];
            if (info?.version) parts.push(`v${String(info.version)}`);
            if (info?.serverName) parts.push(String(info.serverName));
            if (info?.username) parts.push(String(info.username));
            healthInfo = parts.join(' · ');
        } else {
            healthResult = 'error';
            healthInfo = data.error || m.admin_settings_test_connection_failed();
        }
    }
</script>

<!-- Text/URL/Path Input -->
<div class="flex flex-col gap-1.5">
    <div class="flex items-center gap-2">
        {#if setting.uiHints?.prefix}
            <span class="text-muted">{setting.uiHints.prefix}</span>
        {/if}
        <input
            type={setting.uiHints?.sensitive ? 'password' : 'text'}
            id={setting.key}
            class="input input-sm w-full placeholder:italic placeholder:text-surface-500
				{setting.type === 'url' || setting.uiHints?.sensitive ? 'sm:w-80' : 'sm:w-64'}
				{isDisabled ? 'cursor-not-allowed' : ''} {dimForDisabled ? 'opacity-50' : ''}"
            disabled={isDisabled}
            value={inputValue}
            placeholder={placeholderText}
            inputmode={isUrlType ? 'url' : undefined}
            autocomplete={isUrlType || setting.uiHints?.sensitive ? 'off' : undefined}
            spellcheck={isUrlType ? false : undefined}
            aria-invalid={hasUrlError || hasLanguageError}
            aria-describedby={hasUrlError
                ? urlErrorId
                : hasLanguageError
                  ? languageErrorId
                  : undefined}
            title={envLockTitle}
            oninput={handleTextInput} />
        {#if setting.uiHints?.suffix}
            <span class="text-muted">{setting.uiHints.suffix}</span>
        {/if}
        {#if secretStored && !isDisabled}
            <button
                type="button"
                class="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-surface-300 hover:bg-surface-700 hover:text-white"
                aria-label={m.admin_settings_secret_clear_label({ label: setting.label })}
                onclick={() => onchange?.('')}>
                {m.admin_settings_secret_clear()}
            </button>
        {/if}
        {#if provider}
            <button
                type="button"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors
                    {healthState === 'loading'
                    ? 'bg-surface-600 text-surface-300 cursor-wait'
                    : healthState === 'success'
                      ? 'bg-green-800/50 text-green-300 hover:bg-green-800/70'
                      : healthState === 'error'
                        ? 'bg-red-800/50 text-red-300 hover:bg-red-800/70'
                        : 'bg-surface-600 text-surface-200 hover:bg-surface-500'} disabled:cursor-not-allowed disabled:opacity-50"
                disabled={healthState === 'loading' || !canTest}
                title={canTest ? undefined : m.admin_settings_test_connection_needs_url()}
                onclick={testConnection}>
                {#if healthState === 'loading'}
                    <span
                        class="w-3 h-3 border-2 border-surface-400 border-t-transparent rounded-full animate-spin"
                    ></span>
                    {m.admin_settings_test_connection_testing()}
                {:else if healthState === 'success'}
                    <span class="w-2 h-2 rounded-full bg-green-400"></span>
                    {m.admin_settings_test_connection_connected()}
                {:else if healthState === 'error'}
                    <span class="w-2 h-2 rounded-full bg-red-400"></span>
                    {m.admin_settings_test_connection_retry()}
                {:else}
                    {m.admin_settings_test_connection()}
                {/if}
            </button>
        {/if}
    </div>
    {#if healthInfo && healthState !== 'idle'}
        <span
            class="text-xs pl-0.5 {healthState === 'success' ? 'text-green-400' : 'text-red-400'}">
            {healthInfo}
        </span>
    {/if}
    {#if secretCleared}
        <span class="flex items-center gap-2 text-xs text-amber-300">
            {m.admin_settings_secret_will_clear()}
            <button
                type="button"
                class="underline hover:text-amber-200"
                onclick={() => onchange?.(SECRET_CONFIGURED_SENTINEL)}>
                {m.admin_settings_secret_undo_clear()}
            </button>
        </span>
    {/if}
    {#if hasLanguageError}
        <span id={languageErrorId} class="text-xs text-red-400"
            >{m.setup_metadata_lang_error()}</span>
    {/if}
    {#if hasUrlError}
        <span id={urlErrorId} class="text-xs text-red-400">{m.admin_settings_url_invalid()}</span>
    {/if}
    {#if previewSrc}
        {#if imageLoadFailed}
            <span class="text-xs text-surface-400">{m.admin_settings_preview_load_failed()}</span>
        {:else}
            <img
                src={previewSrc}
                alt={m.admin_settings_preview_alt({ label: setting.label })}
                loading="lazy"
                class="preview-thumb h-10 w-auto max-w-[8rem] rounded object-contain"
                onerror={handleImageError} />
        {/if}
    {/if}
</div>

<style>
    /* Neutral checkerboard so a transparent-background image preview (a PNG
       logo, most commonly) doesn't read as "blank". */
    .preview-thumb {
        background-color: var(--color-surface-700);
        background-image:
            linear-gradient(45deg, var(--color-surface-500) 25%, transparent 25%),
            linear-gradient(-45deg, var(--color-surface-500) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, var(--color-surface-500) 75%),
            linear-gradient(-45deg, transparent 75%, var(--color-surface-500) 75%);
        background-size: 8px 8px;
        background-position:
            0 0,
            0 4px,
            4px -4px,
            -4px 0px;
        opacity: 1;
    }
</style>
