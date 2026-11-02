<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        LockClosed,
        ArrowPath,
        ArrowDownTray,
        ArrowTopRightOnSquare,
    } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { SettingDefinition } from '$lib/config/schema';
    import { getInputComponentForSetting } from './inputs/registry';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        setting: SettingDefinition;
        value: unknown;
        disabled?: boolean;
        envLocked?: boolean;
        /** ENV-locked AND already saved in settings.json. */
        inConfigFile?: boolean;
        /** Queued to be copied into settings.json on the next save. */
        persistPending?: boolean;
        disabledHref?: string;
        disabledReason?: string | undefined; // Shows why setting is disabled (e.g., "Requires Auto Quality")
        allValues?: Record<string, unknown>; // All setting values for option dependency filtering
        /**
         * Small badge linking back to this setting's home settings page — used by
         * cross-cutting audit panels (e.g. Access → Group-based rules) that render a
         * setting outside its own section. Absent on every normal settings page.
         */
        originChip?: { label: string; href: string };
        // Callbacks
        onchange?: (value: unknown) => void;
        onsaveEnvToConfig?: (value: unknown) => void;
    }

    let {
        setting,
        value,
        disabled = false,
        envLocked = false,
        inConfigFile = false,
        persistPending = false,
        disabledReason = undefined,
        disabledHref,
        allValues = {},
        originChip = undefined,
        onchange,
        onsaveEnvToConfig,
    }: Props = $props();

    let displaySetting = $derived(
        setting.key === 'DEFAULT_ACTIVITY_SHARING'
            ? {
                  ...setting,
                  label: m.activity_sharing_default_label(),
                  description: m.activity_sharing_default_description(),
              }
            : setting,
    );

    // Effective disabled state (includes envOnly settings)
    let isDisabled = $derived(
        disabled || envLocked || setting.uiHints?.envOnly || setting.envOnlyEnforced,
    );
    // ENV-locked rows stay at full opacity — an ENV override is a normal, valid
    // configuration state (not "does not apply here" like a dependency-disabled
    // row), and dimming the whole row on top of the input's own disabled state
    // made the value hard to read.
    let dimRow = $derived(isDisabled && !envLocked);

    // Derive input component based on setting type or UI hints
    let InputComponent = $derived(getInputComponentForSetting(setting));

    // Toggle rows can keep the switch at the end of the row even when the row
    // stacks on mobile — a boolean control has no width to fight the label for.
    let isToggleRow = $derived(setting.type === 'boolean');
    let rowClass = $derived(
        isToggleRow
            ? 'flex flex-row items-center justify-between gap-3 sm:gap-4'
            : 'flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4',
    );
    let controlClass = $derived(isToggleRow ? 'shrink-0' : 'w-full sm:w-auto sm:shrink-0');

    // Save ENV value to config (user will need to remove ENV manually)
    function handleSaveEnvToConfig() {
        onsaveEnvToConfig?.(value);
    }
</script>

<div id={`setting-${setting.key}`} class="setting-input" class:disabled={dimRow}>
    <div class={rowClass}>
        <div class="flex-1 min-w-0">
            <label
                class="flex flex-wrap items-center gap-2 text-sm font-medium text-surface-200"
                for={setting.key}>
                {displaySetting.label}
                {#if setting.requiresRestart}
                    <Tooltip text={m.admin_setting_badge_restart_hint()} position="top" fixed>
                        <span class="badge badge-warning gap-1">
                            <Icon src={ArrowPath} class="w-3 h-3" />
                            {m.admin_setting_badge_restart()}
                        </span>
                    </Tooltip>
                {/if}
                {#if setting.uiHints?.devOnly}
                    <Tooltip text={m.admin_setting_badge_dev_only_hint()} position="top" fixed>
                        <span class="badge badge-orange gap-1"
                            >{m.admin_setting_badge_dev_only()}</span>
                    </Tooltip>
                {/if}
                {#if setting.uiHints?.beta}
                    <Tooltip text={m.admin_setting_badge_beta_hint()} position="top" fixed>
                        <span class="badge badge-purple gap-1">{m.admin_setting_badge_beta()}</span>
                    </Tooltip>
                {/if}
                {#if setting.uiHints?.advanced}
                    <Tooltip text={m.admin_setting_badge_advanced_hint()} position="top" fixed>
                        <span
                            class="badge gap-1 border border-surface-500/40 bg-surface-600/40 text-surface-300">
                            {m.admin_setting_badge_advanced()}
                        </span>
                    </Tooltip>
                {/if}
                {#if setting.uiHints?.envOnly}
                    <Tooltip text={m.admin_setting_badge_env_only_hint()} position="top" fixed>
                        <span class="badge badge-cyan gap-1"
                            >{m.admin_setting_badge_env_only()}</span>
                    </Tooltip>
                {/if}
                {#if envLocked}
                    <Tooltip text={m.admin_setting_badge_env_hint()} position="top" fixed>
                        <span class="badge badge-info gap-1">
                            <Icon src={LockClosed} class="w-3 h-3" />
                            ENV
                        </span>
                    </Tooltip>
                    {#if setting.envOnlyEnforced}
                        <!-- Env-only: settings.json is never read for it, nothing to copy. -->
                    {:else if inConfigFile}
                        <!-- Already copied: nothing to do until the variable is removed. -->
                        <span
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-surface-400"
                            title={m.admin_setting_env_in_file_hint()}>
                            {m.admin_setting_env_in_file()}
                        </span>
                    {:else}
                        <button
                            type="button"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded transition-colors {persistPending
                                ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                                : 'bg-surface-600 hover:bg-surface-500 text-surface-200'}"
                            title={m.admin_setting_env_copy_hint()}
                            aria-pressed={persistPending}
                            onclick={handleSaveEnvToConfig}>
                            <Icon src={ArrowDownTray} class="w-3 h-3" />
                            {persistPending
                                ? m.admin_setting_env_copy_pending()
                                : m.admin_setting_env_copy()}
                        </button>
                    {/if}
                {/if}
                {#if originChip}
                    <a
                        href={resolve(originChip.href)}
                        class="badge badge-info gap-1 hover:brightness-110 transition-[filter]"
                        title={m.admin_settings_go_to({ label: originChip.label })}>
                        <Icon src={ArrowTopRightOnSquare} class="w-3 h-3" />
                        {originChip.label}
                    </a>
                {/if}
            </label>
            <p class="text-hint mt-0.5">{displaySetting.description}</p>
            {#if disabled && disabledReason}
                <p class="mt-2 text-sm text-amber-200">
                    {disabledReason}
                    {#if disabledHref}<a
                            class="underline underline-offset-2"
                            href={resolve(disabledHref)}>{m.admin_settings_open_prerequisite()}</a
                        >{/if}
                </p>
            {/if}
            {#if setting.uiHints?.envOnly || setting.envOnlyEnforced}
                <p class="mt-2 text-sm text-cyan-200">
                    {m.admin_settings_environment_only({ key: setting.key })}
                </p>
            {:else if envLocked}
                <p class="mt-2 text-sm text-cyan-200">
                    {m.admin_settings_environment_override({ key: setting.key })}
                </p>
            {/if}
        </div>

        <div class={controlClass}>
            <!-- Component Registry Pattern - eliminates type-based branching -->
            <InputComponent
                setting={displaySetting}
                {value}
                disabled={!!isDisabled}
                {envLocked}
                {allValues}
                {onchange}
                {onsaveEnvToConfig} />
        </div>
    </div>
</div>

<style>
    .setting-input {
        padding: 0.75rem 0;
    }

    .setting-input.disabled {
        opacity: 0.7;
    }

    /* Duration matches HIGHLIGHT_DURATION_MS in utils/admin/settings-highlight.ts —
       the class is removed on that timer, so a longer animation would be cut off. */
    :global(.setting-input.search-highlight) {
        animation: setting-search-glow 3s ease-out;
        border-radius: 0.5rem;
    }

    @keyframes setting-search-glow {
        0% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
            background-color: rgb(250 204 21 / 0.12);
        }
        100% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0);
            background-color: rgb(250 204 21 / 0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        :global(.setting-input.search-highlight) {
            animation: none;
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
        }
    }
</style>
