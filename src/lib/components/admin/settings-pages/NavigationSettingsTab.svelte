<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Navigation tab content for Settings → Homepage & navigation (admin IA
  redesign, spec §3.6: homepage + navigation as tabs on ONE page). Ported
  near-verbatim from the deleted standalone `/admin/navigation` page — its
  save/reload forms post to the SAME `?/save` / `?/reload` actions the
  parent route's settings-framework load already wires up, so no server
  changes were needed for this tab beyond loading the `navigation` section.
-->
<script lang="ts">
    import { settingValueEqual } from '$lib/utils/admin/setting-value-equal';
    import * as m from '$lib/paraglide/messages';
    import { SvelteSet } from 'svelte/reactivity';

    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    import { tick } from 'svelte';
    import { Icon, ArrowPath, Check, ExclamationTriangle, Bars3 } from 'svelte-hero-icons';
    import { AdminPageHeader, StickySaveBar } from '$lib/components/admin';
    import { NavigationSettings } from '$lib/components/admin/navigation';
    import { toasts } from '$lib/stores/toast.store';
    import type { SettingsLoadResult } from '$lib/server/admin/settings-helpers';

    type FormData =
        | { success: true; reloaded?: true; error?: never }
        | { success?: never; error: string }
        | null;

    interface Props {
        data: SettingsLoadResult & {
            warnings: string[];
            availableGroups?: string[];
            localNavIcons?: string[];
            featureFlags?: Record<string, boolean>;
        };
        form: FormData;
    }

    let props: Props = $props();
    let data = $derived(props.data);

    let modifiedValues: Record<string, unknown> = $state({});
    let hasChanges = $derived(Object.keys(modifiedValues).length > 0);
    let isSaving = $state(false);
    let isReloading = $state(false);
    // True while the post-save invalidateAll() is in flight. hasChanges is
    // already false in this window (modifiedValues cleared), so it gates the
    // Reload button — clicking Reload mid-invalidate could interleave a file
    // reload with the resolving load() and momentarily show stale state.
    let isApplying = $state(false);

    let currentValues = $derived({ ...data.values, ...modifiedValues });
    let envOverridesSet = $derived(new SvelteSet(data.envOverrides));
    let modifiedCount = $derived(Object.keys(modifiedValues).length);

    // The four navigation keys this page can edit. Used both for building the
    // save payload and for detecting which of the user's pending edits target
    // ENV-locked keys (which the server silently refuses to persist).
    const NAV_KEYS = [
        'SIDEBAR_LINKS',
        'SIDEBAR_SECTIONS',
        'FOOTER_LINKS',
        'USER_MENU_LINKS',
        'HERO_BUTTONS',
    ] as const;

    // Only the navigation-related keys are ever editable on this page. Build a
    // narrow save payload so we never ship the entire decrypted config (incl.
    // secrets) back to the server on save. ENV-overridden keys are excluded:
    // config.service.doSaveConfig() silently skips persisting them, so shipping
    // them would (a) risk sending an empty `[]` that mismatches a genuinely
    // empty default and (b) make the admin believe locked edits were saved.
    // Only lists that actually differ from what was loaded: the editor reports
    // all five on any change, and re-posting the untouched ones from this page's
    // load-time snapshot reverted another admin's edit to them.
    let savePayload = $derived(
        Object.fromEntries(
            NAV_KEYS.filter(
                (key) =>
                    !envOverridesSet.has(key) &&
                    key in modifiedValues &&
                    !settingValueEqual(modifiedValues[key], data.values[key]),
            ).map((key) => [key, currentValues[key]]),
        ),
    );

    // Pending edits that target an ENV-locked key. These will NOT be persisted
    // (server discards them), so we warn the admin instead of silently dropping.
    let lockedPendingKeys = $derived(
        Object.keys(modifiedValues).filter((key) =>
            envOverridesSet.has(key as (typeof NAV_KEYS)[number]),
        ),
    );

    // Writable derived: seeded from server data and auto-resyncs on ANY load()
    // refresh — not just the post-Save invalidateAll(). If any other navigation
    // event or re-fetch triggers load(), the optimistic value written by
    // handleGroupAdded will be silently reset to whatever the server returns.
    // This is safe TODAY because the only refresh path is the post-Save
    // invalidateAll(), by which point the added group is already persisted
    // server-side and will be included in the refreshed data.availableGroups.
    // If a new refresh path is ever introduced (e.g., a periodic poll or a
    // background invalidation), revisit this assumption.
    let availableGroups = $derived<string[]>(data.availableGroups ?? []);

    function handleGroupAdded(groups: string[]): void {
        availableGroups = groups;
    }

    let collapsed = $state(false);

    let saveForm: HTMLFormElement | undefined = $state();

    let navigationEnvOverrides = $derived({
        sidebarLinks: envOverridesSet.has('SIDEBAR_LINKS'),
        sidebarSections: envOverridesSet.has('SIDEBAR_SECTIONS'),
        footerLinks: envOverridesSet.has('FOOTER_LINKS'),
        userMenuLinks: envOverridesSet.has('USER_MENU_LINKS'),
        heroButtons: envOverridesSet.has('HERO_BUTTONS'),
    });

    function handleNavigationChange(detail: {
        sidebarLinks: unknown[];
        sidebarSections: unknown[];
        footerLinks: unknown[];
        userMenuLinks: unknown[];
        heroButtons: unknown[];
    }) {
        const { sidebarLinks, sidebarSections, footerLinks, userMenuLinks, heroButtons } = detail;
        modifiedValues = {
            ...modifiedValues,
            SIDEBAR_LINKS: sidebarLinks,
            SIDEBAR_SECTIONS: sidebarSections,
            FOOTER_LINKS: footerLinks,
            USER_MENU_LINKS: userMenuLinks,
            HERO_BUTTONS: heroButtons,
        };
    }

    function resetChanges() {
        modifiedValues = {};
    }

    function handleSaveResult(result: import('@sveltejs/kit').ActionResult) {
        // Success is determined ONLY from the live result. props.form can be
        // stale from a prior action, so an OR against actionData?.success would
        // fire a false-positive on an error-type result.
        if (result.type === 'success') {
            // Capture before clearing: warn if any pending edits targeted an
            // ENV-locked key, since the server silently discarded those and
            // invalidateAll() is about to revert them to the ENV value.
            const discarded = lockedPendingKeys;
            toasts.success(m.admin_toast_settings_saved_reloading_to_apply_changes());
            if (discarded.length > 0) {
                toasts.error(
                    'Some navigation settings are locked by an environment variable and were not saved.',
                );
            }
            modifiedValues = {};
            // Re-run load() to refresh data.values without a full-page reload,
            // which can race a clustered deploy and show stale config. Hold
            // isApplying until it resolves so Reload stays disabled in the gap.
            isApplying = true;
            void invalidateAll().finally(() => {
                isApplying = false;
            });
        } else if (result.type === 'failure') {
            const errorMsg = (result.data as FormData | undefined)?.error;
            toasts.error(
                errorMsg
                    ? m.admin_toast_failed_with_message({ message: errorMsg })
                    : m.admin_toast_failed_unknown_error(),
            );
        } else if (result.type === 'error') {
            toasts.error(m.admin_toast_failed_unknown_error());
        }
        isSaving = false;
    }

    function handleReloadResult(result: import('@sveltejs/kit').ActionResult) {
        // Success is determined ONLY from the live result (see handleSaveResult).
        if (result.type === 'success') {
            toasts.success(m.admin_toast_settings_reloaded_from_file());
            // Clear stale local edits so freshly-loaded data is not overlaid and
            // the unsaved-changes banner does not persist.
            modifiedValues = {};
        } else if (result.type === 'failure') {
            const errorMsg = (result.data as FormData | undefined)?.error;
            toasts.error(
                errorMsg
                    ? m.admin_toast_failed_with_message({ message: errorMsg })
                    : m.admin_toast_failed_unknown_error(),
            );
        } else if (result.type === 'error') {
            toasts.error(m.admin_toast_failed_unknown_error());
        }
        isReloading = false;
    }
</script>

<div class="settings-page">
    <div class="mb-6">
        <AdminPageHeader
            icon={Bars3}
            title={m.admin_navigation_title()}
            description={m.admin_navigation_description()}>
            <div class="flex items-center gap-3">
                {#if hasChanges}
                    <span class="text-sm text-yellow-400 flex items-center gap-1">
                        <Icon src={ExclamationTriangle} class="w-4 h-4" />
                        {m.admin_navigation_unsaved_changes()}
                    </span>
                    <button
                        type="button"
                        class="px-3 py-2 text-sm text-surface-400 hover:text-white transition-colors"
                        onclick={resetChanges}>
                        {m.admin_navigation_discard()}
                    </button>
                {/if}

                <form
                    method="POST"
                    action="?/reload"
                    use:enhance={({ cancel }) => {
                        // Reloading from file overwrites in-memory config, which
                        // would silently discard unsaved local edits.
                        if (hasChanges && !window.confirm(m.admin_navigation_reload_confirm())) {
                            cancel();
                            return;
                        }
                        isReloading = true;
                        return async ({ update, result }) => {
                            await update();
                            await tick();
                            handleReloadResult(result);
                        };
                    }}>
                    <button
                        type="submit"
                        class="btn btn-sm btn-gray flex items-center gap-2"
                        disabled={isReloading || isSaving || isApplying}>
                        <Icon src={ArrowPath} class="w-4 h-4 {isReloading ? 'animate-spin' : ''}" />
                        {m.admin_navigation_reload()}
                    </button>
                </form>

                <form
                    bind:this={saveForm}
                    method="POST"
                    action="?/save"
                    use:enhance={() => {
                        isSaving = true;
                        return async ({ update, result }) => {
                            await update();
                            await tick();
                            handleSaveResult(result);
                        };
                    }}>
                    <input type="hidden" name="updates" value={JSON.stringify(savePayload)} />
                    <button
                        type="submit"
                        class="flex items-center gap-2 px-4 py-2 text-sm bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!hasChanges || isSaving}>
                        {#if isSaving}
                            <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                            {m.admin_navigation_saving()}
                        {:else}
                            <Icon src={Check} class="w-4 h-4" />
                            {m.admin_navigation_save_changes()}
                        {/if}
                    </button>
                </form>
            </div>
        </AdminPageHeader>
    </div>

    {#if !data.storageStatus?.willPersist}
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-6">
            <div class="flex items-start gap-3">
                <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div class="text-sm">
                    <p class="text-red-200 font-medium">{m.admin_navigation_no_persist()}</p>
                    <p class="text-red-300/70 mt-1">
                        {data.storageStatus?.message}
                    </p>
                </div>
            </div>
        </div>
    {/if}

    <NavigationSettings
        sidebarLinks={Array.isArray(currentValues.SIDEBAR_LINKS) ? currentValues.SIDEBAR_LINKS : []}
        sidebarSections={Array.isArray(currentValues.SIDEBAR_SECTIONS)
            ? currentValues.SIDEBAR_SECTIONS
            : []}
        footerLinks={Array.isArray(currentValues.FOOTER_LINKS) ? currentValues.FOOTER_LINKS : []}
        userMenuLinks={Array.isArray(currentValues.USER_MENU_LINKS)
            ? currentValues.USER_MENU_LINKS
            : []}
        heroButtons={Array.isArray(currentValues.HERO_BUTTONS) ? currentValues.HERO_BUTTONS : []}
        envOverrides={navigationEnvOverrides}
        {availableGroups}
        localNavIcons={data.localNavIcons || []}
        featureFlags={data.featureFlags ?? {}}
        bind:collapsed
        onchange={handleNavigationChange}
        onaddgroup={handleGroupAdded} />

    {#if hasChanges}
        <StickySaveBar
            {modifiedCount}
            {isSaving}
            ondiscard={resetChanges}
            onsave={() => saveForm?.requestSubmit()} />
    {/if}
</div>

<style>
    .settings-page {
        padding-bottom: 100px;
    }
</style>
