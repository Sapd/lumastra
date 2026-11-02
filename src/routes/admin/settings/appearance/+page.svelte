<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Appearance: default theme picker + custom theme editor + custom
  CSS/JS injection. Deliberately NOT built on <AdminSettingsPage> — that
  component renders the generic per-section settings grid for whichever
  section id it's given, and all four keys this page owns
  (APPEARANCE_DEFAULT_THEME/CUSTOM_THEMES/CUSTOM_CSS/CUSTOM_JS) live in the
  'branding' section alongside APP_NAME/APP_LOGO_*/etc — those already render
  on the main Settings page. Reusing AdminSettingsPage here would either dupe
  that generic grid or require faking a dedicated section id that doesn't
  exist in the schema. So this page owns its own small save/discard flow
  (same `?/save` action + StickySaveBar as every other settings page) scoped
  to just these four keys.
-->
<script lang="ts">
    import { tick } from 'svelte';
    import { enhance } from '$app/forms';
    import {
        Icon,
        Plus,
        Trash,
        ExclamationTriangle,
        ChevronDown,
        Sparkles,
    } from 'svelte-hero-icons';
    import { AdminPageHeader, StickySaveBar } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import {
        BUILTIN_THEMES,
        DEFAULT_THEME_ID,
        type ThemeDefinition,
    } from '$lib/shared/theme/theme-model';
    import { ThemeDefinitionSchema } from '$lib/schemas/theme';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';

    let { data }: { data: PageData; form: ActionData } = $props();

    const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

    // Baseline (persisted) values for the four keys this page owns. A plain
    // snapshot, not $state — only `modifiedValues` needs to be reactive; this
    // is the "what would we revert to" reference, same pattern
    // AdminSettingsPage.svelte uses for its whole-page modifiedValues diff.
    // svelte-ignore state_referenced_locally
    const baseValues: {
        APPEARANCE_DEFAULT_THEME: string;
        APPEARANCE_CUSTOM_THEMES: ThemeDefinition[];
        APPEARANCE_CUSTOM_CSS: string;
        APPEARANCE_CUSTOM_JS: string;
    } = {
        APPEARANCE_DEFAULT_THEME:
            (data.values.APPEARANCE_DEFAULT_THEME as string | undefined) ?? DEFAULT_THEME_ID,
        APPEARANCE_CUSTOM_THEMES:
            (data.values.APPEARANCE_CUSTOM_THEMES as ThemeDefinition[] | undefined) ?? [],
        APPEARANCE_CUSTOM_CSS: (data.values.APPEARANCE_CUSTOM_CSS as string | undefined) ?? '',
        APPEARANCE_CUSTOM_JS: (data.values.APPEARANCE_CUSTOM_JS as string | undefined) ?? '',
    };

    let modifiedValues = $state<Partial<typeof baseValues>>({});
    let currentValues = $derived({ ...baseValues, ...modifiedValues });
    let modifiedCount = $derived(Object.keys(modifiedValues).length);
    let hasChanges = $derived(modifiedCount > 0);
    let isSaving = $state(false);
    let jsExpanded = $state(false);

    let defaultTheme = $derived(currentValues.APPEARANCE_DEFAULT_THEME);
    let customThemes = $derived(currentValues.APPEARANCE_CUSTOM_THEMES);
    let customCss = $derived(currentValues.APPEARANCE_CUSTOM_CSS);
    let customJs = $derived(currentValues.APPEARANCE_CUSTOM_JS);

    // Selectable themes for the default-theme picker: builtins + whatever
    // customs are currently in the (possibly unsaved) editor state, so a
    // theme the admin just added is immediately pickable as default before
    // saving.
    let selectableThemes = $derived<ThemeDefinition[]>([...BUILTIN_THEMES, ...customThemes]);

    function handleChange<K extends keyof typeof baseValues>(
        key: K,
        value: (typeof baseValues)[K],
    ): void {
        if (JSON.stringify(value) === JSON.stringify(baseValues[key])) {
            const rest = { ...modifiedValues };
            delete rest[key];
            modifiedValues = rest;
        } else {
            modifiedValues = { ...modifiedValues, [key]: value };
        }
    }

    function discardChanges(): void {
        modifiedValues = {};
    }

    // ─────────────────────────────────────────────────────────────────────
    // Custom theme editor
    // ─────────────────────────────────────────────────────────────────────

    function slugify(name: string): string {
        const base =
            name
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 32) || 'theme';
        const taken = new Set([...BUILTIN_IDS, ...customThemes.map((t) => t.id)]);
        if (!taken.has(base)) return base;
        let n = 2;
        let candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
        while (taken.has(candidate)) {
            n += 1;
            candidate = `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
        }
        return candidate;
    }

    function addTheme(): void {
        const id = slugify('custom-theme');
        const seed = BUILTIN_THEMES[0];
        const next: ThemeDefinition = {
            id,
            name: 'New theme',
            accent: seed?.accent ?? '#6366f1',
            surfaceTint: seed?.surfaceTint ?? '#4f5e8a',
            starfield: true,
        };
        handleChange('APPEARANCE_CUSTOM_THEMES', [...customThemes, next]);
    }

    function removeTheme(id: string): void {
        handleChange(
            'APPEARANCE_CUSTOM_THEMES',
            customThemes.filter((t) => t.id !== id),
        );
        if (defaultTheme === id) {
            handleChange('APPEARANCE_DEFAULT_THEME', DEFAULT_THEME_ID);
        }
    }

    function updateTheme(id: string, patch: Partial<ThemeDefinition>): void {
        handleChange(
            'APPEARANCE_CUSTOM_THEMES',
            customThemes.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        );
    }

    /** Client-side mirror of the server's per-entry validation (schema + no builtin-shadowing + unique id). */
    function themeIsInvalid(theme: ThemeDefinition): boolean {
        const result = ThemeDefinitionSchema.safeParse(theme);
        if (!result.success) return true;
        if (BUILTIN_IDS.has(theme.id)) return true;
        return customThemes.filter((t) => t.id === theme.id).length > 1;
    }

    let hasThemeErrors = $derived(customThemes.some((t) => themeIsInvalid(t)));

    // ─────────────────────────────────────────────────────────────────────
    // Save / reload (same ?/save + ?/reload actions + toasts every other
    // settings page uses)
    // ─────────────────────────────────────────────────────────────────────

    function handleSaveResult(result: import('@sveltejs/kit').ActionResult): void {
        // Only the live result: falling back to the `form` prop let an earlier
        // save's success answer for a later failed one.
        const actionData =
            result.type === 'success' || result.type === 'failure'
                ? (result.data as { success?: boolean; error?: string } | undefined)
                : undefined;
        if (result.type === 'success' && actionData?.success) {
            toasts.success('Settings saved. Reloading to apply changes…');
            modifiedValues = {};
            setTimeout(() => window.location.reload(), 600);
        } else if (result.type === 'failure' || actionData?.error) {
            const errorMsg =
                (result.type === 'failure' &&
                    (result.data as { error?: string } | undefined)?.error) ||
                actionData?.error ||
                'Unknown error';
            toasts.error(`Failed: ${errorMsg}`);
        } else {
            toasts.error('Failed: Unknown error');
        }
        isSaving = false;
    }
</script>

{#snippet themePreview(theme: { accent: string; surfaceTint: string; starfield: boolean })}
    <div class="flex items-center gap-2" aria-label={m.admin_appearance_preview()}>
        <span
            class="h-5 w-5 rounded-full border border-white/20 shadow-inner"
            style="background:{theme.accent}"
            title={m.admin_appearance_accent()}></span>
        <span
            class="h-5 w-5 rounded-full border border-white/20 shadow-inner"
            style="background:{theme.surfaceTint}"
            title={m.admin_appearance_surface_tint()}></span>
        <span
            class="rounded-md px-2.5 py-1 text-[11px] font-medium text-white shadow-inner"
            style="background: linear-gradient(135deg, {theme.surfaceTint}, {theme.accent}); border: 1px solid {theme.accent}66;">
            Aa
        </span>
        {#if theme.starfield}
            <span title={m.admin_appearance_starfield()}>
                <Icon src={Sparkles} class="h-3.5 w-3.5 text-surface-400" />
            </span>
        {/if}
    </div>
{/snippet}

<svelte:head>
    <title>{m.admin_appearance_title()}</title>
</svelte:head>

<div class="container mx-auto p-4 settings-page">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/appearance']}
        title={m.admin_appearance_title()}
        description={m.admin_appearance_description()} />

    <!-- Default theme -->
    <div class="card p-4 mt-4">
        <label class="label" for="appearance-default-theme">
            <span class="font-medium">{m.admin_appearance_default_theme()}</span>
        </label>
        <select
            id="appearance-default-theme"
            class="select mt-1 max-w-sm"
            value={defaultTheme}
            onchange={(e) => handleChange('APPEARANCE_DEFAULT_THEME', e.currentTarget.value)}>
            {#each selectableThemes as theme (theme.id)}
                <option value={theme.id}>{theme.name}</option>
            {/each}
        </select>
        <p class="text-hint mt-1">{m.admin_appearance_default_theme_hint()}</p>
    </div>

    <!-- Custom themes -->
    <div class="card p-4 mt-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="h4">{m.admin_appearance_custom_themes()}</h3>
            <button type="button" class="btn btn-sm variant-filled-primary" onclick={addTheme}>
                <Icon src={Plus} class="h-4 w-4" />
                <span>{m.admin_appearance_add_theme()}</span>
            </button>
        </div>

        <!-- Builtins: read-only reference rows -->
        <div class="mt-3 space-y-2">
            {#each BUILTIN_THEMES as theme (theme.id)}
                <div class="flex flex-wrap items-center gap-3 rounded-lg bg-surface-700/30 p-3">
                    <span class="badge variant-soft-secondary shrink-0">builtin</span>
                    <span class="min-w-32 font-medium">{theme.name}</span>
                    {@render themePreview(theme)}
                </div>
            {/each}
        </div>

        <!-- Customs: editable rows -->
        <div class="mt-3 space-y-3">
            {#each customThemes as theme (theme.id)}
                {@const invalid = themeIsInvalid(theme)}
                <div
                    class="rounded-lg border p-3 {invalid
                        ? 'border-red-700/60 bg-red-900/10'
                        : 'border-surface-700/50 bg-surface-800/30'}">
                    <div class="flex flex-wrap items-end gap-3">
                        <label class="label min-w-40 flex-1">
                            <span class="text-hint">{m.admin_appearance_theme_name()}</span>
                            <input
                                class="input"
                                type="text"
                                value={theme.name}
                                onchange={(e) =>
                                    updateTheme(theme.id, { name: e.currentTarget.value })} />
                        </label>

                        <label class="label">
                            <span class="text-hint">{m.admin_appearance_accent()}</span>
                            <input
                                class="input h-10 w-16 p-1"
                                type="color"
                                value={theme.accent}
                                onchange={(e) =>
                                    updateTheme(theme.id, { accent: e.currentTarget.value })} />
                        </label>

                        <label class="label">
                            <span class="text-hint">{m.admin_appearance_surface_tint()}</span>
                            <input
                                class="input h-10 w-16 p-1"
                                type="color"
                                value={theme.surfaceTint}
                                onchange={(e) =>
                                    updateTheme(theme.id, {
                                        surfaceTint: e.currentTarget.value,
                                    })} />
                        </label>

                        <label
                            class="flex items-center gap-2 text-sm"
                            title={m.admin_appearance_starfield_hint()}>
                            <input
                                type="checkbox"
                                class="checkbox"
                                checked={theme.starfield}
                                onchange={(e) =>
                                    updateTheme(theme.id, {
                                        starfield: e.currentTarget.checked,
                                    })} />
                            <span>{m.admin_appearance_starfield()}</span>
                        </label>

                        <button
                            type="button"
                            class="btn btn-sm variant-soft-error"
                            onclick={() => removeTheme(theme.id)}
                            aria-label={m.admin_appearance_delete_theme()}>
                            <Icon src={Trash} class="h-4 w-4" />
                        </button>
                    </div>

                    <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p class="text-hint mb-1">{m.admin_appearance_preview()}</p>
                            {@render themePreview(theme)}
                        </div>
                        {#if invalid}
                            <p class="flex items-center gap-1 text-sm text-red-400">
                                <Icon src={ExclamationTriangle} class="h-4 w-4" />
                                {m.admin_appearance_invalid_theme()}
                            </p>
                        {/if}
                    </div>
                </div>
            {/each}

            {#if customThemes.length === 0}
                <p class="text-hint">{m.admin_appearance_no_custom()}</p>
            {/if}
        </div>
    </div>

    <!-- Custom CSS -->
    <div class="card p-4 mt-4">
        <label class="label" for="appearance-custom-css">
            <span class="font-medium">{m.admin_appearance_custom_css()}</span>
        </label>
        <textarea
            id="appearance-custom-css"
            class="textarea mt-1 font-mono text-xs"
            rows="8"
            spellcheck="false"
            value={customCss}
            oninput={(e) => handleChange('APPEARANCE_CUSTOM_CSS', e.currentTarget.value)}
        ></textarea>
        <p class="text-hint mt-1">{m.admin_appearance_custom_css_hint()}</p>
    </div>

    <!-- Custom JS (dangerous, collapsed by default) -->
    <div class="card mt-4 border border-red-700/50 bg-red-950/10 p-4">
        <button
            type="button"
            class="flex w-full items-center justify-between gap-2 text-left"
            onclick={() => (jsExpanded = !jsExpanded)}
            aria-expanded={jsExpanded}>
            <span class="flex items-center gap-2 font-medium text-red-300">
                <Icon src={ExclamationTriangle} class="h-5 w-5" />
                {m.admin_appearance_custom_js()}
            </span>
            <Icon
                src={ChevronDown}
                class="h-4 w-4 text-red-400 transition-transform {jsExpanded
                    ? ''
                    : '-rotate-90'}" />
        </button>

        {#if jsExpanded}
            <div class="mt-3 space-y-3">
                <div class="flex gap-2 rounded-lg border border-red-700/60 bg-red-900/20 p-3">
                    <Icon src={ExclamationTriangle} class="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
                    <p class="text-sm text-red-200">{m.admin_appearance_custom_js_warning()}</p>
                </div>
                <textarea
                    class="textarea font-mono text-xs"
                    rows="8"
                    spellcheck="false"
                    value={customJs}
                    oninput={(e) => handleChange('APPEARANCE_CUSTOM_JS', e.currentTarget.value)}
                ></textarea>
            </div>
        {/if}
    </div>

    <!-- Save -->
    <form
        method="POST"
        action="?/save"
        use:enhance={({ cancel }) => {
            // cancel(), not a no-op result handler: returning a function only
            // replaces the result handling, the invalid themes were still POSTed.
            if (hasThemeErrors) {
                toasts.error(m.admin_appearance_invalid_theme());
                cancel();
                return;
            }
            if (isSaving || !hasChanges) {
                cancel();
                return;
            }
            isSaving = true;
            return async ({ update, result }) => {
                await update();
                await tick();
                handleSaveResult(result);
            };
        }}>
        <!-- Only what changed: posting all four load-time values reverted another
             admin's themes or CSS whenever this page saved something else. -->
        <input type="hidden" name="updates" value={JSON.stringify(modifiedValues)} />

        {#if hasChanges}
            <StickySaveBar
                {modifiedCount}
                {isSaving}
                ondiscard={discardChanges}
                onsave={() => {
                    const saveForm =
                        document.querySelector<HTMLFormElement>('form[action="?/save"]');
                    saveForm?.requestSubmit();
                }} />
        {/if}
    </form>
</div>

<style>
    .settings-page {
        padding-bottom: 100px;
    }
</style>
