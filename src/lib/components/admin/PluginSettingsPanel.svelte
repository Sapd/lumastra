<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A plugin's declared `settings.fields`, rendered with the SAME components as
  the host settings pages (SettingSection / SettingInput): the same inputs,
  masked-secret handling, dependsOn nesting, Advanced folding and unsaved-change
  guard. There used to be two more renderers — a modal and an older inline
  panel — each with its own subset of that behaviour.

  Values persist to `plugin_settings` / `plugin_secrets` through the plugin
  settings API — the store these keys are actually read from. (Host connection
  settings live in the config system; plugins must not re-declare them.)
-->

<script lang="ts">
    import { beforeNavigate } from '$app/navigation';
    import * as adminApi from '$lib/api/admin';
    import SettingSection from '$lib/components/admin/SettingSection.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import * as m from '$lib/paraglide/messages.js';
    import type { SectionDefinition, SettingDefinition, SettingType } from '$lib/config/schema';
    import type {
        PluginSettingsConfig,
        PluginSettingField,
    } from '$lib/server/plugins/types/base-plugin';

    interface Props {
        pluginId: string;
        heading: string;
        description?: string;
        /** Called after a successful save, e.g. to re-run the page load. */
        onSaved?: () => void;
        /** Shown as a "Close" action when the panel is opened from a card. */
        onClose?: () => void;
    }

    let { pluginId, heading, description, onSaved, onClose }: Props = $props();

    // The SDK field shape plus the optional hints, with `type` widened: the
    // server type predates `secret` / `multiline` and some hints.
    type Field = Omit<PluginSettingField, 'type'> & {
        type: string;
        advanced?: boolean;
        dependsOn?: string;
        groups?: boolean;
    };

    let loading = $state(true);
    let saving = $state(false);
    let loadError = $state<string | null>(null);
    let fields = $state<Field[]>([]);
    let baseline = $state<Record<string, unknown>>({});
    let modified = $state<Record<string, unknown>>({});
    let showAdvanced = $state(false);

    let values = $derived({ ...baseline, ...modified });

    // Connection test for plugins that support one (Discogs). Sends the typed
    // token; the server falls back to the stored one for the sentinel/empty.
    const TESTABLE_PLUGINS = new Set(['discogs']);
    let testing = $state(false);
    let testResult = $state<{ ok: boolean; message: string } | null>(null);

    async function testConnection(): Promise<void> {
        testing = true;
        testResult = null;
        try {
            const typed = values.DISCOGS_TOKEN;
            const { data, error } = await adminApi.testPluginConnection(
                pluginId,
                typeof typed === 'string' ? typed : undefined,
            );
            if (error || !data) {
                testResult = { ok: false, message: error || m.plugin_settings_test_failed() };
            } else if (data.ok) {
                testResult = {
                    ok: true,
                    message: data.username
                        ? m.plugin_settings_test_connected_as({ username: data.username })
                        : m.plugin_settings_test_token_valid(),
                };
            } else {
                testResult = {
                    ok: false,
                    message: data.error || m.plugin_settings_test_token_invalid(),
                };
            }
        } catch (e) {
            testResult = {
                ok: false,
                message: getErrorMessage(e, m.plugin_settings_test_failed()),
            };
        } finally {
            testing = false;
        }
    }
    let dirty = $derived(Object.keys(modified).length > 0);
    let hasAdvanced = $derived(fields.some((f) => f.advanced));

    let section = $derived<SectionDefinition>({
        id: `plugin-${pluginId}`,
        label: heading,
        description: description ?? '',
        order: 0,
    });

    /** Plugin field → host setting definition, so the host renderer applies. */
    function toSetting(field: Field): SettingDefinition {
        const uiHints: SettingDefinition['uiHints'] = {};
        let type = field.type as SettingType;
        if (field.type === 'secret') {
            type = 'string';
            uiHints.sensitive = true;
        } else if (field.type === 'multiline') {
            type = 'string';
            uiHints.multiline = true;
        }
        if (field.groups) uiHints.groups = true;
        if (field.advanced) uiHints.advanced = true;
        return {
            key: field.key,
            label: field.label,
            description: field.description ?? '',
            type,
            defaultValue: field.default,
            section: section.id,
            validation: field.options
                ? { ...field.validation, options: field.options }
                : field.validation,
            uiHints,
            ...(field.dependsOn ? { dependsOn: field.dependsOn } : {}),
        };
    }

    let settings = $derived(fields.map(toSetting));

    // Only the newest load may land: a plugin switch, Retry and the reload after
    // a save can overlap, and an older answer used to overwrite a newer one.
    let loadSeq = 0;

    /**
     * `sent`: the edits a save just wrote. Edits made while that save ran are
     * kept as unsaved instead of being wiped by the reload, and the form is not
     * swapped for the loading text (it used to unmount mid-typing).
     */
    async function load(sent?: Record<string, unknown>): Promise<void> {
        const seq = ++loadSeq;
        if (!sent) loading = true;
        loadError = null;
        try {
            const { data, error } = await adminApi.getPluginSettings(pluginId);
            if (seq !== loadSeq) return;
            if (error || !data) {
                loadError = error ?? m.plugin_settings_load_failed();
                return;
            }
            const typed = data as unknown as {
                settingsConfig: PluginSettingsConfig | null;
                currentSettings: Record<string, unknown>;
            };
            const declared = (typed.settingsConfig?.fields ?? []) as Field[];
            const initial: Record<string, unknown> = {};
            for (const f of declared) {
                // `??` not `||`: a stored 0 is a real value, not "unset".
                initial[f.key] = typed.currentSettings?.[f.key] ?? f.default;
            }
            const kept: Record<string, unknown> = {};
            if (sent) {
                for (const [key, value] of Object.entries(modified)) {
                    const same = (a: unknown, b: unknown): boolean =>
                        JSON.stringify(a) === JSON.stringify(b);
                    if (key in sent && same(value, sent[key])) continue;
                    if (same(value, initial[key])) continue;
                    kept[key] = value;
                }
            }
            fields = declared;
            baseline = initial;
            modified = kept;
        } catch (e) {
            if (seq === loadSeq) loadError = getErrorMessage(e, m.plugin_settings_load_failed());
        } finally {
            if (seq === loadSeq) loading = false;
        }
    }

    function handleChange(detail: { key: string; value: unknown }): void {
        const { key, value } = detail;
        if (JSON.stringify(value) === JSON.stringify(baseline[key])) {
            const { [key]: _, ...rest } = modified;
            modified = rest;
        } else {
            modified = { ...modified, [key]: value };
        }
    }

    /**
     * Clamp numeric fields to their declared bounds. Consumers clamp when they
     * READ the setting, so an out-of-range value would save "successfully" and
     * then show a different number than the one in force.
     */
    function clamp(changes: Record<string, unknown>): {
        values: Record<string, unknown>;
        clamped: string[];
    } {
        const out = { ...changes };
        const clamped: string[] = [];
        for (const field of fields) {
            if (field.type !== 'number' || !(field.key in out)) continue;
            const raw = out[field.key];
            const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
            if (!Number.isFinite(n)) continue;
            let next = n;
            const { min, max } = field.validation ?? {};
            if (typeof min === 'number' && next < min) next = min;
            if (typeof max === 'number' && next > max) next = max;
            if (next !== n) {
                out[field.key] = next;
                clamped.push(`${field.label} → ${next}`);
            }
        }
        return { values: out, clamped };
    }

    async function save(): Promise<void> {
        if (saving || !dirty) return;
        saving = true;
        try {
            const sent = { ...modified };
            const { values: toSave, clamped } = clamp(sent);
            const { error } = await adminApi.updatePluginSettings(pluginId, { settings: toSave });
            if (error) {
                toasts.error(error);
                return;
            }
            if (clamped.length > 0) {
                toasts.warning(m.plugin_settings_saved_clamped({ fields: clamped.join(', ') }));
            } else {
                toasts.success(m.plugin_settings_saved());
            }
            await load(sent); // secrets come back masked; arrays come back normalised
            onSaved?.();
        } catch (e) {
            toasts.error(getErrorMessage(e, m.plugin_settings_save_failed()));
        } finally {
            saving = false;
        }
    }

    // Same promise as the host settings pages: unsaved edits are not dropped by
    // navigating away without a word.
    beforeNavigate((navigation) => {
        if (!dirty || navigation.willUnload) return;
        if (!window.confirm(m.plugin_settings_unsaved_confirm({ name: heading }))) {
            navigation.cancel();
        }
    });

    function close(): void {
        if (dirty && !window.confirm(m.plugin_settings_unsaved_confirm({ name: heading }))) return;
        onClose?.();
    }

    $effect(() => {
        void pluginId;
        void load();
    });
</script>

<section class="rounded-lg border border-surface-700 bg-surface-900/40 p-4">
    {#if loading}
        <p class="text-sm text-surface-400">{m.plugin_settings_loading()}</p>
    {:else if loadError}
        <div class="text-sm">
            <p class="text-red-400">{loadError}</p>
            <button
                type="button"
                class="mt-2 underline text-surface-300 hover:text-white"
                onclick={() => void load()}>
                {m.admin_settings_test_connection_retry()}
            </button>
        </div>
    {:else if fields.length === 0}
        <p class="text-sm text-surface-400">{m.plugin_settings_none()}</p>
    {:else}
        {#if hasAdvanced}
            <label class="mb-2 flex items-center justify-end gap-2 text-xs text-surface-300">
                <input type="checkbox" bind:checked={showAdvanced} />
                {m.admin_setting_badge_advanced()}
            </label>
        {/if}
        <SettingSection
            {section}
            {values}
            envOverrides={new Set<string>()}
            collapsible={false}
            {showAdvanced}
            settingsOverride={showAdvanced
                ? settings
                : settings.filter((s) => !s.uiHints?.advanced)}
            onchange={handleChange} />
    {/if}

    {#if TESTABLE_PLUGINS.has(pluginId) && fields.length > 0}
        <div class="mt-3 flex items-center gap-3">
            <button
                type="button"
                class="btn btn-sm btn-ghost border border-surface-600"
                onclick={() => void testConnection()}
                disabled={testing}>
                {m.plugin_settings_test_token()}
            </button>
            {#if testResult}
                <span class="text-sm {testResult.ok ? 'text-green-400' : 'text-red-400'}">
                    {testResult.message}
                </span>
            {/if}
        </div>
    {/if}

    <div
        class="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-surface-700 pt-3">
        {#if dirty}
            <span class="mr-auto text-xs text-amber-300" aria-live="polite"
                >{m.admin_navigation_unsaved_changes()}</span>
            <button
                type="button"
                class="rounded-md px-3 py-1.5 text-sm text-surface-300 hover:text-white"
                onclick={() => (modified = {})}>
                {m.admin_sticky_discard()}
            </button>
        {/if}
        {#if onClose}
            <button
                type="button"
                class="rounded-md px-3 py-1.5 text-sm text-surface-300 hover:text-white"
                onclick={close}>
                {m.close()}
            </button>
        {/if}
        {#if fields.length > 0}
            <button
                type="button"
                class="btn btn-sm btn-primary"
                onclick={() => void save()}
                disabled={saving || !dirty}>
                {saving ? m.admin_settings_saving() : m.plugin_settings_save()}
            </button>
        {/if}
    </div>
</section>
