<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { parseMarkdownLinks } from '$lib/utils/assistant-utils';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    import { Icon, CodeBracket, DocumentText, Lifebuoy } from 'svelte-hero-icons';
    import tmdbLogo from '$lib/assets/providers/tmdb.svg';
    import AudiobookshelfAttribution from '$lib/components/settings/AudiobookshelfAttribution.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import {
        InstanceProfileResponseSchema,
        type InstanceProfileDiffEntry,
    } from '$lib/schemas/api-admin-navigation.js';
    import { apiPost } from '$lib/api/client.js';
    import {
        LICENSE_MODULES,
        LICENSE_MODULE_LABELS,
        ENTERPRISE_LICENSE_MODULES,
    } from '$lib/shared/license-modules.js';
    import { licensePhase, tierLabel } from '$lib/components/admin/settings/license-status-summary';
    import UseCaseTiles from '$lib/components/setup/UseCaseTiles.svelte';
    import type { PageData, ActionData } from './$types';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    let reviewingSecurity = $state(false);

    function formatDate(iso: string): string {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(getLocale());
    }

    // ── Instance profile (ex /admin/instance-profile) ──────────────────────
    // svelte-ignore state_referenced_locally
    let selected = $state<string[]>([...data.selected]);
    // svelte-ignore state_referenced_locally
    let landingPath = $state<string>(data.landingPath);
    // Sent only once the admin edits the field: echoing the loaded value back
    // made it an override on every apply, so switching profile never moved
    // the landing page to the new profile's default.
    let landingEdited = $state(false);
    let saving = $state(false);
    // What the last apply could not do (environment-owned keys, library types
    // that failed to activate). Shown in place, not only as a passing toast.
    let applyNotice = $state<{ envLocked: string[]; libraryTypes: string[] } | null>(null);
    let previewing = $state(false);
    let preview = $state<InstanceProfileDiffEntry[] | null>(null);
    // Bumped whenever the selection changes or Apply runs, so a dry-run that
    // was in flight cannot land a diff for a selection the operator left.
    let previewSeq = 0;

    function discardPreview(): void {
        previewSeq++;
        preview = null;
        previewing = false;
    }

    function toggle(id: string): void {
        selected = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
        discardPreview();
    }

    // The 'enterprise' preset's data label ("Home Videos / Training / Enterprise")
    // reads as enterprise-only vocabulary on an open-core, home-user install —
    // the preset itself (LMS/training toggles) is fully usable here. Relabel just
    // that one preset for display; the other presets' labels are plain data.
    function presetLabel(preset: { id: string; label: string }): string {
        return preset.id === 'enterprise'
            ? m.admin_instance_preset_enterprise_label()
            : preset.label;
    }

    const musicSelected = $derived(selected.includes('music'));
    const musicReady = $derived(
        data.capabilities.hasEmbeddings && data.capabilities.hasSonicEmbedder,
    );

    function formatValue(v: unknown): string {
        if (Array.isArray(v)) return v.join(', ') || m.admin_instance_profile_value_empty();
        if (v === '') return m.admin_instance_profile_value_empty();
        return String(v);
    }

    function onLandingInput(): void {
        landingEdited = true;
        discardPreview();
    }

    type ProfileRequest = {
        useCases: ('vod' | 'music' | 'enterprise' | 'showcase')[];
        landingPath?: string;
        dryRun?: boolean;
        expectedRevision: string | null;
    };

    function profileRequest(dryRun: boolean): ProfileRequest {
        return {
            useCases: selected as ProfileRequest['useCases'],
            ...(landingEdited ? { landingPath: landingPath.trim() } : {}),
            ...(dryRun ? { dryRun: true } : {}),
            // The profile this form was built from: a newer apply from another
            // tab or admin is refused (409) instead of silently overwritten.
            expectedRevision: data.profileRevision,
        };
    }

    // Someone applied the profile since this page loaded.
    let profileConflict = $state(false);

    async function reloadProfile(): Promise<void> {
        await invalidateAll();
        selected = [...data.selected];
        landingPath = data.landingPath;
        landingEdited = false;
        profileConflict = false;
    }

    async function loadPreview(): Promise<void> {
        const seq = ++previewSeq;
        previewing = true;
        const {
            data: result,
            error,
            status,
        } = await apiPost(
            '/api/admin/instance-profile',
            InstanceProfileResponseSchema,
            profileRequest(true),
        );
        if (seq !== previewSeq) return;
        previewing = false;
        if (status === 409) {
            profileConflict = true;
            preview = null;
            return;
        }
        if (error || !result?.diff) {
            // A preview without a diff is not "no changes".
            toasts.error(error ?? m.admin_instance_profile_unconfirmed());
            preview = null;
        } else {
            preview = result.diff;
        }
    }

    async function apply(): Promise<void> {
        if (saving || selected.length === 0) return;
        discardPreview();
        applyNotice = null;
        saving = true;
        const {
            data: result,
            error,
            status,
        } = await apiPost(
            '/api/admin/instance-profile',
            InstanceProfileResponseSchema,
            profileRequest(false),
        );
        if (status === 409) {
            saving = false;
            profileConflict = true;
            return;
        }
        if (error || !result?.applied) {
            saving = false;
            toasts.error(error ?? m.admin_instance_profile_unconfirmed());
            return;
        }
        const envLocked = result.envLocked ?? [];
        const libraryTypes = result.libraryTypesNotActivated ?? [];
        if (envLocked.length > 0 || libraryTypes.length > 0) {
            applyNotice = { envLocked, libraryTypes };
            toasts.warning(m.admin_instance_profile_applied_partly());
        } else {
            toasts.success(m.admin_instance_profile_applied());
        }
        // Re-read what is now in force rather than keep the pre-apply load.
        try {
            await reloadProfile();
        } finally {
            saving = false;
        }
    }

    // ── Licensing (ex /admin/licensing) ─────────────────────────────────────
    function licenseErrorMessage(code: string, detail: string | undefined): string {
        switch (code) {
            case 'invalid':
                return m.admin_licensing_error_invalid();
            case 'empty':
                return m.admin_licensing_error_empty();
            case 'env_locked':
                return m.admin_licensing_error_env_locked();
            default:
                return m.admin_licensing_error_save_failed({ detail: detail ?? '' });
        }
    }

    // Reflect the latest action result if present, else the loaded state.
    const licenseKeySet = $derived(
        form && 'licenseKeySet' in form ? Boolean(form.licenseKeySet) : data.licenseKeySet,
    );
    let savingLicense = $state(false);

    const status = $derived(data.licenseStatus);

    // What this install runs on right now: grace / early access / licensed /
    // free tier / unrestricted. Same helper as the Settings card.
    const phase = $derived(
        status
            ? licensePhase({
                  validity: status.validity,
                  tier: status.tier,
                  enforcementEnabled: status.enforcementEnabled,
              })
            : null,
    );

    // Map the verified validity to a badge label + Skeleton variant class.
    const validityBadge = $derived.by(() => {
        // The status lookup failed in the load: say so rather than fall through
        // to "Enforcement off", which reads as a real license posture.
        if (!status) {
            return { label: m.admin_licensing_status_unavailable(), cls: 'variant-filled-warning' };
        }
        if (phase === 'early-access' && status?.validity === 'valid') {
            return { label: m.admin_licensing_early_access(), cls: 'variant-filled-success' };
        }
        switch (status?.validity) {
            case 'grace':
                return { label: m.admin_licensing_grace(), cls: 'variant-filled-warning' };
            case 'valid':
                return { label: m.admin_licensing_valid(), cls: 'variant-filled-success' };
            case 'expiring-soon':
                return { label: m.admin_licensing_expiring_soon(), cls: 'variant-filled-warning' };
            case 'expired':
                return { label: m.admin_licensing_expired(), cls: 'variant-filled-error' };
            case 'free-tier':
                return { label: m.admin_licensing_free_tier(), cls: 'variant-soft-surface' };
            default:
                return { label: m.admin_licensing_enforcement_off(), cls: 'variant-soft-surface' };
        }
    });

    const expiresLabel = $derived(
        status?.expiresAt
            ? new Date(status.expiresAt).toLocaleDateString(getLocale(), { timeZone: 'UTC' })
            : null,
    );

    // This process's contact with lumastra.org (null in a build without the
    // verifier, or when enforcement is off and push needs no relay token).
    const contact = $derived(data.licenseServerContact);
    // Contact switched off — only meaningful while enforcement is on (a build
    // without enforcement gates nothing either way).
    const contactOff = $derived(
        data.licenseServerContactEnabled === false && status?.enforcementEnabled === true,
    );
    const fmtTime = (iso: string | null): string =>
        iso
            ? new Date(iso).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
            : '—';
    const contactReason = $derived.by(() => {
        const failure = contact?.lastFailure;
        if (!failure || failure === 'unreachable')
            return m.admin_licensing_contact_reason_unreachable();
        if (failure === 'http-429') return m.admin_licensing_contact_reason_rate_limited();
        return m.admin_licensing_contact_reason_http({ status: failure.replace('http-', '') });
    });

    /**
     * Localized rendering of `status.reason` — the server field is plain
     * English prose (it can be generated outside any paraglide request
     * context), which used to be shown verbatim regardless of the viewer's UI
     * language ("License is valid." under a fully-German admin). Maps the
     * stable `reasonCode` to a message; an code-less/unrecognized status
     * (older cached entry, a future code this build doesn't know) falls back
     * to the raw English `reason` rather than showing nothing.
     */
    const reasonLabel = $derived.by(() => {
        switch (status?.reasonCode) {
            case 'valid':
                return m.admin_licensing_reason_valid();
            case 'valid-expiring-soon':
                return m.admin_licensing_reason_valid_expiring_soon();
            case 'grace-active':
                return m.admin_licensing_reason_grace_active();
            case 'no-key-free':
                return m.admin_licensing_reason_no_key_free();
            case 'grace-ended-free':
                return m.admin_licensing_reason_grace_ended_free();
            case 'expired-in-grace':
                return m.admin_licensing_reason_expired_in_grace();
            case 'expired-beyond-grace':
                return m.admin_licensing_reason_expired_beyond_grace();
            case 'invalid-key-free':
                return m.admin_licensing_reason_invalid_key_free();
            case 'db-unavailable-free':
                return m.admin_licensing_reason_db_unavailable_free();
            case 'install-identity-unavailable-free':
                return m.admin_licensing_reason_install_identity_unavailable_free();
            case 'check-failed-free':
                return m.admin_licensing_reason_check_failed_free();
            case 'no-provider-free':
                return m.admin_licensing_reason_no_provider_free();
            case 'enforcement-disabled':
                return m.admin_licensing_reason_enforcement_disabled();
            case 'contact-off-free':
                return m.admin_licensing_reason_contact_off_free();
            case 'contact-off-key-until-expiry':
                return m.admin_licensing_reason_contact_off_key_until_expiry();
            case 'contact-off-expired-free':
                return m.admin_licensing_reason_contact_off_expired_free();
            default:
                return status?.reason ?? null;
        }
    });

    let copied = $state(false);
    async function copyInstallUuid(): Promise<void> {
        if (!data.installUuid) return;
        try {
            await navigator.clipboard.writeText(data.installUuid);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // Clipboard unavailable — operator can select the text manually.
        }
    }

    // Edition display helpers.
    const editionLabel = $derived.by(() => {
        switch (status?.entitlements?.edition) {
            case 'pro':
                return 'Pro';
            case 'enterprise':
                return 'Enterprise';
            case 'unlimited':
                return 'Unlimited';
            case 'free':
                return 'Community (Free)';
            default:
                return status?.tier ?? 'Unknown';
        }
    });

    // Module display config: id → label. Imported rather than declared inline
    // because tsgo (what `npm run typecheck` runs) does not check .svelte
    // files — an exhaustive Record written here would be enforced by nothing
    // CI runs, and this map having silently missed `push` is exactly the bug
    // being fixed. See LICENSE_MODULE_LABELS for the full reasoning.
    const MODULE_LABELS = LICENSE_MODULE_LABELS;
    const ALL_MODULES = LICENSE_MODULES;
    const licensedModules = $derived<Set<string>>(
        status?.entitlements?.modules
            ? new Set([...(status.entitlements.modules as Set<string>)])
            : new Set<string>(),
    );

    // Seat overflow banner.
    const seatsInUse = $derived(status?.seatsInUse ?? null);
    const seatLimit = $derived(status?.seatLimit ?? null);
    const seatOverflow = $derived(
        seatsInUse !== null && seatLimit !== null && seatsInUse > seatLimit,
    );
</script>

<svelte:head>
    <title>{m.admin_instance_page_title()}</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/system/instance']}
        title={m.admin_nav_page_system_instance()}
        description={m.admin_nav_desc_system_instance()} />

    <nav
        aria-label={m.admin_instance_sections()}
        class="sticky top-2 z-10 flex gap-1 lg:top-16 overflow-x-auto rounded-lg border border-surface-700/70 bg-surface-950/90 p-1 backdrop-blur">
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#profile">{m.admin_instance_nav_profile()}</a>
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#about">{m.admin_instance_nav_about()}</a>
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#licenses">{m.admin_instance_nav_licenses()}</a>
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#license-status">{m.admin_instance_nav_license_status()}</a>
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#data-flows">{m.admin_instance_nav_data_flows()}</a>
    </nav>

    <!-- Instance profile -->
    <section id="profile" class="card scroll-mt-16 lg:scroll-mt-32 space-y-4 bg-surface-800/50 p-5">
        <div>
            <h2 class="font-semibold" id="instance-profile-heading">
                {m.admin_instance_profile_heading()}
            </h2>
            <p class="mt-1 text-sm text-surface-400">{m.admin_instance_profile_subtitle()}</p>
        </div>

        <UseCaseTiles
            appearance="admin"
            labelledby="instance-profile-heading"
            options={data.presets.map((p) => ({
                id: p.id,
                label: presetLabel(p),
                note:
                    p.id === 'enterprise'
                        ? m.admin_instance_profile_enterprise_note({ path: p.landingPath })
                        : undefined,
            }))}
            {selected}
            ontoggle={toggle} />

        {#if musicSelected && !musicReady}
            <div class="section-warning">
                <p class="font-medium text-yellow-300">
                    {m.admin_instance_profile_music_setup_title()}
                </p>
                <p class="text-sm text-yellow-200/80 mt-1">
                    {m.admin_instance_profile_music_setup_body_pre()}
                    <a class="underline hover:text-yellow-100" href={resolve('/admin/settings/ai')}
                        >{m.admin_nav_page_settings_ai()}</a>
                    {m.admin_instance_profile_music_setup_body_mid()}
                    <a
                        class="underline hover:text-yellow-100"
                        href={resolve('/admin/settings/music')}
                        >{m.admin_nav_page_settings_music()}</a
                    >{m.admin_instance_profile_music_setup_body_post()}
                </p>
            </div>
        {/if}

        <div class="space-y-1">
            <label class="block text-sm font-medium text-surface-300" for="landing-path">
                {m.admin_instance_profile_landing_path_label()}
            </label>
            <input
                id="landing-path"
                class="input"
                type="text"
                bind:value={landingPath}
                oninput={onLandingInput}
                aria-describedby="landing-path-hint"
                placeholder={m.admin_instance_profile_landing_path_placeholder()} />
            <p id="landing-path-hint" class="text-xs text-surface-500">
                {m.admin_instance_profile_landing_path_hint()}
            </p>
        </div>

        <p class="text-sm text-surface-400">{m.admin_instance_profile_reapply_note()}</p>

        <div class="flex flex-wrap items-center gap-3">
            <button
                type="button"
                class="btn btn-primary"
                disabled={saving || selected.length === 0}
                aria-describedby={selected.length === 0 ? 'profile-select-one' : undefined}
                onclick={apply}>
                {saving ? m.admin_instance_profile_applying() : m.admin_instance_profile_apply()}
            </button>
            <button
                type="button"
                class="btn variant-soft"
                disabled={previewing || saving || selected.length === 0}
                onclick={loadPreview}>
                {previewing
                    ? m.admin_instance_profile_loading()
                    : m.admin_instance_profile_preview_changes()}
            </button>
            {#if selected.length === 0}
                <p id="profile-select-one" class="text-sm text-surface-400">
                    {m.admin_instance_profile_select_one()}
                </p>
            {/if}
        </div>

        <div role="status" class="space-y-1">
            {#if profileConflict}
                <div class="section-warning text-sm text-yellow-200/90 space-y-2">
                    <p>{m.admin_instance_profile_conflict()}</p>
                    <button type="button" class="btn btn-sm variant-soft" onclick={reloadProfile}>
                        {m.admin_instance_profile_conflict_reload()}
                    </button>
                </div>
            {:else if data.profileUpdates.length > 0 && !applyNotice}
                <div class="section-warning text-sm text-yellow-200/90">
                    <p>
                        {m.admin_instance_profile_pending_updates({
                            keys: data.profileUpdates.join(', '),
                        })}
                    </p>
                </div>
            {/if}
            {#if applyNotice}
                <div class="section-warning text-sm text-yellow-200/90 space-y-1">
                    {#if applyNotice.envLocked.length > 0}
                        <p>
                            {m.admin_instance_profile_env_locked_notice({
                                keys: applyNotice.envLocked.join(', '),
                            })}
                        </p>
                    {/if}
                    {#if applyNotice.libraryTypes.length > 0}
                        <p>
                            {m.admin_instance_profile_library_types_failed({
                                types: applyNotice.libraryTypes.join(', '),
                            })}
                        </p>
                    {/if}
                </div>
            {/if}
        </div>

        {#if preview !== null}
            <div
                class="rounded-lg border border-surface-700 bg-surface-900 p-4 space-y-2"
                aria-live="polite">
                <p class="text-sm font-semibold text-surface-300" id="profile-diff-heading">
                    {m.admin_instance_profile_config_diff()}
                </p>
                {#if preview.length === 0}
                    <p class="text-sm text-surface-400">{m.admin_instance_profile_no_changes()}</p>
                {:else}
                    <table
                        class="w-full text-xs text-left border-collapse"
                        aria-labelledby="profile-diff-heading">
                        <thead>
                            <tr class="text-surface-400 border-b border-surface-700">
                                <th class="py-1 pr-4 font-medium"
                                    >{m.admin_instance_profile_col_key()}</th>
                                <th class="py-1 pr-4 font-medium"
                                    >{m.admin_instance_profile_col_from()}</th>
                                <th class="py-1 font-medium"
                                    >{m.admin_instance_profile_col_to()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each preview as row (row.key)}
                                <tr class="border-b border-surface-800">
                                    <td class="py-1 pr-4 font-mono text-surface-300 break-all"
                                        >{row.key}</td>
                                    <td class="py-1 pr-4 text-surface-400 break-all"
                                        >{formatValue(row.from)}</td>
                                    <td class="py-1 text-white break-all">
                                        {formatValue(row.to)}
                                        {#if row.envLocked}
                                            <span class="block text-yellow-300"
                                                >{m.admin_instance_profile_row_env_locked()}</span>
                                        {:else if row.newInProfile}
                                            <span class="block text-surface-400"
                                                >{m.admin_instance_profile_row_new_in_profile()}</span>
                                        {:else if row.overridesChange}
                                            <span class="block text-yellow-300"
                                                >{m.admin_instance_profile_row_overrides_change()}</span>
                                        {/if}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                {/if}
            </div>
        {/if}

        <p class="text-sm text-surface-400">
            {m.admin_instance_profile_footer_pre()}
            <a class="underline hover:text-surface-200" href={resolve('/admin/library/sources')}
                >{m.admin_nav_page_library_sources()}</a>
            {m.admin_instance_profile_footer_post()}
        </p>
    </section>

    <!-- About this software -->
    <section id="about" class="card scroll-mt-16 lg:scroll-mt-32 space-y-3 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_about_title()}</h2>
        <p class="text-sm leading-relaxed text-surface-300">
            {m.admin_licensing_about_part1()}
            <code>/j</code>
            {m.admin_licensing_about_part2()}
        </p>
        <p class="text-xs text-surface-500">
            {m.admin_licensing_version({ version: data.appVersion })}
        </p>
        {#if data.buildInfo?.commitShort}
            <p class="text-xs text-surface-500">
                {m.admin_instance_build_commit({ commit: data.buildInfo.commitShort })}
            </p>
        {/if}
        {#if data.buildInfo?.buildTime}
            <p class="text-xs text-surface-500">
                {m.admin_instance_build_time({ time: data.buildInfo.buildTime })}
            </p>
        {/if}
        {#if data.buildInfo?.branch}
            <p class="text-xs text-surface-500">
                {m.admin_instance_build_branch({ branch: data.buildInfo.branch })}
            </p>
        {/if}
        <!-- Update check: the attention notice links here (#updates). -->
        <div id="updates" class="scroll-mt-16 lg:scroll-mt-32 space-y-1 text-xs">
            {#if !data.updateCheckEnabled}
                <p class="text-surface-500">{m.admin_instance_update_disabled()}</p>
            {:else if data.updateCheck?.latest}
                <p
                    class={data.updateCheck.securityFixedIn
                        ? 'rounded border border-red-500/50 bg-red-950/40 px-2 py-1.5 text-red-200'
                        : 'text-surface-300'}>
                    {data.updateCheck.securityFixedIn
                        ? m.admin_instance_update_security({
                              version: data.updateCheck.latest.version,
                              fixed: data.updateCheck.securityFixedIn,
                          })
                        : m.admin_instance_update_available({
                              version: data.updateCheck.latest.version,
                          })}
                    <a
                        class="underline hover:text-surface-100"
                        href={data.updateCheck.latest.url}
                        target="_blank"
                        rel="noopener noreferrer">{m.admin_instance_update_release_notes()}</a>
                </p>
                {#if data.updateCheck.securityFixedIn}
                    <!-- The only way to quiet the red notice short of updating:
                         an explicit, audited "reviewed" for this one release. -->
                    <details class="text-surface-400">
                        <summary class="cursor-pointer select-none hover:text-surface-200">
                            {m.admin_instance_update_review_summary()}
                        </summary>
                        <form
                            method="POST"
                            action="?/reviewSecurity"
                            use:enhance={() => {
                                reviewingSecurity = true;
                                return async ({ update }) => {
                                    await update();
                                    reviewingSecurity = false;
                                };
                            }}
                            class="mt-1 space-y-1">
                            <p>
                                {m.admin_instance_update_review_explain({
                                    fixed: data.updateCheck.securityFixedIn,
                                })}
                            </p>
                            <input
                                type="hidden"
                                name="version"
                                value={data.updateCheck.securityFixedIn} />
                            <button
                                type="submit"
                                class="btn btn-sm variant-ghost-surface"
                                disabled={reviewingSecurity}>
                                {m.admin_instance_update_review_confirm({
                                    fixed: data.updateCheck.securityFixedIn,
                                })}
                            </button>
                        </form>
                    </details>
                {:else if data.updateCheck.securityReviewed}
                    <form
                        method="POST"
                        action="?/unreviewSecurity"
                        use:enhance={() => {
                            reviewingSecurity = true;
                            return async ({ update }) => {
                                await update();
                                reviewingSecurity = false;
                            };
                        }}
                        class="flex flex-wrap items-center gap-2 text-surface-500">
                        <span>
                            {m.admin_instance_update_reviewed({
                                fixed: data.updateCheck.securityReviewed,
                            })}
                        </span>
                        <input
                            type="hidden"
                            name="version"
                            value={data.updateCheck.securityReviewed} />
                        <button
                            type="submit"
                            class="underline hover:text-surface-200"
                            disabled={reviewingSecurity}>
                            {m.admin_instance_update_review_undo()}
                        </button>
                    </form>
                {/if}
            {:else if data.updateCheck && !data.updateCheck.comparable}
                <p class="text-surface-500">{m.admin_instance_update_not_comparable()}</p>
            {:else if data.updateCheck?.checkedAt}
                <p class="text-surface-500">
                    {m.admin_instance_update_current({
                        date: formatDate(data.updateCheck.checkedAt),
                    })}
                </p>
            {:else}
                <p class="text-surface-500">{m.admin_instance_update_never()}</p>
            {/if}
            {#if data.updateCheckEnabled && data.updateCheck?.lastErrorAt}
                <p class="text-surface-500">
                    {m.admin_instance_update_last_error({
                        date: formatDate(
                            data.updateCheck.failingSince ?? data.updateCheck.lastErrorAt,
                        ),
                    })}
                </p>
            {/if}
            {#if form && 'updateReviewError' in form && form.updateReviewError}
                <p class="text-error-400" role="alert">{m.admin_instance_update_review_error()}</p>
            {/if}
        </div>
        <div class="flex flex-wrap gap-2 pt-1">
            <a
                class="btn btn-sm variant-filled-surface"
                href={data.repoUrl}
                target="_blank"
                rel="noopener noreferrer">
                <Icon src={CodeBracket} class="h-4 w-4" />
                <span>{m.admin_licensing_source_code()}</span>
            </a>
            <a
                class="btn btn-sm variant-ghost-surface"
                href={data.licensingUrl}
                target="_blank"
                rel="noopener noreferrer">
                <Icon src={DocumentText} class="h-4 w-4" />
                <span>{m.admin_licensing_notices_link()}</span>
            </a>
            <!-- This block answers "what version is this?"; the diagnostics
                 export answers the same question in a form that can be pasted
                 into an issue, so the two belong next to each other. -->
            <a class="btn btn-sm variant-ghost-surface" href={resolve('/admin/system/diagnostics')}>
                <Icon src={Lifebuoy} class="h-4 w-4" />
                <span>{m.admin_nav_page_system_diagnostics()}</span>
            </a>
        </div>
    </section>

    <!-- Third-party open-source notices (bundled attribution) -->
    <section
        id="licenses"
        class="card scroll-mt-16 lg:scroll-mt-32 space-y-3 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_oss_title()}</h2>
        <p class="text-sm leading-relaxed text-surface-300">
            {m.admin_licensing_oss_intro()}
            (<code>third-party-npm-licenses.json</code>).
        </p>
        {#if data.thirdPartyNotices}
            <details class="group">
                <summary
                    class="cursor-pointer select-none text-sm font-medium text-primary-400 hover:text-primary-300">
                    {m.admin_licensing_view_notices()}
                </summary>
                <div
                    class="mt-3 max-h-96 overflow-auto break-words rounded bg-surface-900/70 p-4 text-xs leading-relaxed text-surface-300">
                    {@html parseMarkdownLinks(data.thirdPartyNotices)}
                </div>
            </details>
        {:else}
            <p class="text-sm text-surface-400">
                {m.admin_licensing_notices_fallback()}
            </p>
        {/if}
        <div class="flex flex-wrap gap-2 pt-1">
            <a
                class="btn btn-sm variant-ghost-surface"
                href={data.noticesUrl}
                target="_blank"
                rel="noopener noreferrer">
                <Icon src={DocumentText} class="h-4 w-4" />
                <span>{m.admin_licensing_notices_github()}</span>
            </a>
        </div>
    </section>

    <!-- License status -->
    <section
        id="license-status"
        class="card scroll-mt-16 lg:scroll-mt-32 space-y-4 bg-surface-800/50 p-5">
        <div class="flex items-center justify-between gap-3">
            <h2 class="font-semibold">{m.admin_licensing_status_title()}</h2>
            <span class="badge {validityBadge.cls}">{validityBadge.label}</span>
        </div>

        <!-- Seat overflow banner (observe policy — informational only) -->
        {#if seatOverflow}
            <div
                class="rounded border border-warning-500/40 bg-warning-500/10 px-4 py-2 text-sm text-warning-300">
                <strong>{m.admin_licensing_seat_limit_exceeded()}</strong>
                {m.admin_licensing_seat_limit_detail({
                    inUse: seatsInUse ?? 0,
                    limit: seatLimit ?? 0,
                })}
                {#if status?.entitlements?.seatOverflowPolicy === 'degrade'}
                    {m.admin_licensing_seat_degrade_note()}
                {:else}
                    {m.admin_licensing_seat_contact_note()}
                {/if}
            </div>
        {/if}

        {#if phase}
            <p class="text-sm font-medium text-surface-200" data-testid="license-phase">
                {#if phase === 'grace'}
                    {expiresLabel
                        ? m.admin_licensing_phase_grace({ date: expiresLabel })
                        : m.admin_licensing_phase_grace_no_date()}
                {:else if phase === 'early-access'}
                    {m.admin_licensing_phase_early_access({ date: expiresLabel ?? '—' })}
                {:else if phase === 'licensed'}
                    {m.admin_licensing_phase_licensed()}
                {:else if phase === 'free-tier'}
                    {m.admin_licensing_phase_free()}
                {:else}
                    {m.admin_licensing_phase_unrestricted()}
                {/if}
            </p>
            {#if contactOff}
                <!-- Admin → Settings → General → Licensing switched contact off:
                     nothing below (last contact, next attempt) applies. -->
                <p class="text-xs text-surface-300" data-testid="license-server-contact">
                    {phase === 'free-tier'
                        ? m.admin_licensing_contact_off()
                        : m.admin_licensing_contact_off_key({ date: expiresLabel ?? '—' })}
                </p>
                <p class="text-xs text-surface-400" data-testid="license-contact-off-losses">
                    {m.admin_licensing_contact_off_losses()}
                </p>
            {:else if contact?.failingSince}
                <p class="text-xs text-warning-300" data-testid="license-server-contact">
                    {m.admin_licensing_contact_failing({
                        since: fmtTime(contact.failingSince),
                        reason: contactReason,
                        attempts: contact.failedAttempts,
                        next: fmtTime(contact.nextAttemptAt),
                    })}
                </p>
            {:else if contact?.lastSuccessAt}
                <p class="text-xs text-surface-400" data-testid="license-server-contact">
                    {m.admin_licensing_contact_ok({ when: fmtTime(contact.lastSuccessAt) })}
                </p>
            {:else if contact && !contact.checkedAt && contact.nextAttemptAt}
                <p class="text-xs text-surface-400" data-testid="license-server-contact">
                    {m.admin_licensing_contact_pending({ next: fmtTime(contact.nextAttemptAt) })}
                </p>
            {/if}
            {#if phase === 'grace' || phase === 'free-tier'}
                <p class="text-xs text-surface-400">
                    <a
                        href="https://lumastra.org/license/"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-primary-300 hover:text-primary-200"
                        >{m.admin_licensing_manual_key_hint()}</a>
                </p>
            {/if}
        {/if}

        <dl class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div class="sm:col-span-2">
                <dt class="text-xs uppercase tracking-wide text-surface-500">
                    {m.admin_licensing_install_id()}
                </dt>
                <dd class="mt-1 flex items-center gap-2">
                    {#if data.installUuid}
                        <code
                            class="break-all rounded bg-surface-900/70 px-2 py-1 font-mono text-xs"
                            >{data.installUuid}</code>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-surface shrink-0"
                            onclick={copyInstallUuid}>
                            {copied ? m.admin_licensing_copied() : m.player_tt_action_copy()}
                        </button>
                    {:else}
                        <span class="text-surface-400">{m.req_unavailable()}</span>
                    {/if}
                </dd>
                <p class="mt-1 text-xs text-surface-500">
                    {m.admin_licensing_install_id_note()}
                </p>
            </div>
            <div>
                <dt class="text-xs uppercase tracking-wide text-surface-500">
                    {m.admin_licensing_enforcement()}
                </dt>
                <dd class="mt-1">
                    {status?.enforcementEnabled ? m.common_enabled() : m.player_forced_disabled()}
                </dd>
            </div>
            <div>
                <dt class="text-xs uppercase tracking-wide text-surface-500">
                    {m.admin_licensing_edition()}
                </dt>
                <dd class="mt-1 font-medium">{editionLabel}</dd>
            </div>
            <div>
                <dt class="text-xs uppercase tracking-wide text-surface-500">
                    {m.admin_licensing_tier()}
                </dt>
                <dd class="mt-1">{status?.tier ? tierLabel(status.tier) : m.misc_unknown()}</dd>
            </div>
            {#if expiresLabel && (phase === 'licensed' || phase === 'early-access')}
                <div>
                    <dt class="text-xs uppercase tracking-wide text-surface-500">
                        {m.admin_licensing_expires()}
                    </dt>
                    <dd class="mt-1">{expiresLabel}</dd>
                </div>
            {/if}
            {#if seatLimit !== null}
                <div>
                    <dt class="text-xs uppercase tracking-wide text-surface-500">
                        {m.admin_licensing_seats()}
                    </dt>
                    <dd class="mt-1">
                        {#if seatsInUse !== null}
                            <span class={seatOverflow ? 'text-warning-400 font-semibold' : ''}>
                                {seatsInUse} / {seatLimit}
                            </span>
                        {:else}
                            — / {seatLimit}
                        {/if}
                        <span class="ml-1 text-xs text-surface-500"
                            >{m.admin_licensing_seats_window()}</span>
                    </dd>
                </div>
            {/if}
        </dl>

        {#if reasonLabel}
            <p class="text-sm text-surface-400">{reasonLabel}</p>
        {/if}

        <!-- Module checklist -->
        {#if status?.entitlements}
            <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-500">
                    {m.admin_licensing_modules_heading()}
                </h3>
                <ul class="space-y-1">
                    {#each ALL_MODULES as moduleId (moduleId)}
                        <li class="flex items-center gap-2 text-sm">
                            {#if licensedModules.has(moduleId)}
                                <span class="text-success-400 select-none" aria-hidden="true"
                                    >✓</span>
                                <span>{MODULE_LABELS[moduleId]}</span>
                            {:else}
                                <span class="text-surface-600 select-none" aria-hidden="true"
                                    >–</span>
                                <span class="text-surface-500">{MODULE_LABELS[moduleId]}</span>
                                {#if ENTERPRISE_LICENSE_MODULES.has(moduleId)}
                                    <span
                                        class="badge variant-soft-secondary text-[10px] leading-none"
                                        >{m.admin_licensing_module_enterprise_badge()}</span>
                                {/if}
                            {/if}
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}
    </section>

    <!-- Commercial license -->
    <section class="card space-y-4 bg-surface-800/50 p-5">
        <div class="flex items-center justify-between gap-3">
            <h2 class="font-semibold">{m.admin_licensing_commercial_title()}</h2>
            {#if licenseKeySet && phase === 'early-access'}
                <!-- The key set here can be one the licensing server minted automatically
                     (early-access auto-enrol, see license-refresh.ts) rather than one the
                     operator pasted — "Configured" read as if they had entered it. -->
                <span class="badge variant-soft-primary"
                    >{m.admin_licensing_auto_early_access()}</span>
            {:else if licenseKeySet}
                <span class="badge variant-filled-success">{m.providers_stat_configured()}</span>
            {:else}
                <span class="badge variant-soft-surface">{m.admin_licensing_not_configured()}</span>
            {/if}
        </div>
        <p class="text-sm leading-relaxed text-surface-300">
            {m.admin_licensing_commercial_desc()}
        </p>
        {#if licenseKeySet && phase === 'early-access'}
            <p class="text-sm text-surface-400">{m.admin_licensing_auto_early_access_note()}</p>
        {/if}

        {#if form && 'errorCode' in form && form.errorCode}
            <p class="text-sm text-error-400">
                {licenseErrorMessage(
                    form.errorCode,
                    'errorDetail' in form ? form.errorDetail : undefined,
                )}
            </p>
        {/if}

        <form
            method="POST"
            action="?/save"
            use:enhance={() => {
                savingLicense = true;
                return async ({ update }) => {
                    await update();
                    savingLicense = false;
                };
            }}
            class="space-y-3">
            <input
                type="password"
                name="licenseKey"
                autocomplete="off"
                placeholder={licenseKeySet
                    ? m.admin_licensing_key_placeholder_set()
                    : m.admin_licensing_key_placeholder_empty()}
                class="input w-full font-mono text-sm" />
            <div class="flex gap-2">
                <button type="submit" class="btn variant-filled-primary" disabled={savingLicense}>
                    {savingLicense ? m.modal_progress_saving() : m.admin_licensing_save_key()}
                </button>
                {#if licenseKeySet}
                    <button
                        type="submit"
                        formaction="?/clear"
                        class="btn variant-ghost-surface"
                        disabled={savingLicense}>
                        {m.btn_remove()}
                    </button>
                {/if}
            </div>
        </form>
    </section>

    <!-- Operator responsibilities -->
    <section class="card space-y-3 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_responsibilities_title()}</h2>
        <p class="text-sm leading-relaxed text-surface-300">
            {m.admin_licensing_responsibilities_desc()}
        </p>
    </section>

    <!-- Third-party services -->
    <section
        id="data-flows"
        class="card scroll-mt-16 lg:scroll-mt-32 space-y-3 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_services_title()}</h2>
        <p class="text-sm leading-relaxed text-surface-300">
            {m.admin_licensing_services_intro()}
        </p>
        <ul class="ml-4 list-disc space-y-1 text-sm text-surface-400">
            <li>
                <strong>{m.admin_licensing_services_metadata()}</strong> TMDB, MDBList, MusicBrainz, Cover
                Art Archive, AcoustID, Last.fm, Discogs, TheAudioDB, Deezer, lrclib, AniDB, MyAnimeList,
                Trakt
            </li>
            <li>
                <strong>{m.admin_licensing_services_audiobooks()}</strong>
                <p class="mt-1">{m.admin_licensing_services_audiobooks_value()}</p>
                <div class="mt-2"><AudiobookshelfAttribution /></div>
            </li>
            <li>
                <strong>{m.admin_licensing_services_ai()}</strong>
                {m.admin_licensing_services_ai_value()}
            </li>
            <li>
                <strong>{m.admin_licensing_services_licensing()}</strong>
                {m.admin_licensing_services_licensing_value()}
            </li>
        </ul>
        <p class="text-sm leading-relaxed text-surface-400">
            {m.admin_licensing_services_note()}
            <a
                href="https://lumastra.org/reference/data-flows/"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary-400 hover:underline">lumastra.org/reference/data-flows</a
            >.
        </p>
    </section>

    <!-- Warranty & trademarks -->
    <section class="card space-y-2 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_warranty_title()}</h2>
        <p class="text-xs leading-relaxed text-surface-400">
            THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
            INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
            NON-INFRINGEMENT, TO THE MAXIMUM EXTENT PERMITTED BY LAW.
        </p>
        <p class="text-xs leading-relaxed text-surface-400">
            {m.admin_licensing_trademarks_note()}
        </p>
        {#if data.metadataAttributionProviders?.includes('tmdb')}
            <p class="flex items-center gap-2 text-xs leading-relaxed text-surface-400">
                <img src={tmdbLogo} alt="TMDB" class="h-3 w-auto shrink-0" />
                <span
                    >This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
            </p>
        {/if}
    </section>
</div>
