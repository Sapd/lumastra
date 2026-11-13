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
    import { TRAINING_USE_CASE, type UseCaseId } from '$lib/config/use-case-ids.js';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import {
        InstanceProfileResponseSchema,
        type InstanceProfileDiffEntry,
    } from '$lib/schemas/api-admin-navigation.js';
    import { apiPost } from '$lib/api/client.js';
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

    // The training preset id is stored in existing profiles, so it stays.
    // Its display label comes from the messages, like a translated name; the
    // other presets' labels are plain data.
    function presetLabel(preset: { id: string; label: string }): string {
        return preset.id === TRAINING_USE_CASE
            ? m.admin_instance_preset_training_label()
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
        useCases: UseCaseId[];
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
            href="#install-id">{m.admin_instance_nav_license_status()}</a>
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
                    p.id === TRAINING_USE_CASE
                        ? m.admin_instance_profile_training_note({ path: p.landingPath })
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

    <!-- Install ID -->
    <section
        id="install-id"
        class="card scroll-mt-16 lg:scroll-mt-32 space-y-4 bg-surface-800/50 p-5">
        <h2 class="font-semibold">{m.admin_licensing_install_id()}</h2>
        <div class="flex items-center gap-2">
            {#if data.installUuid}
                <code class="break-all rounded bg-surface-900/70 px-2 py-1 font-mono text-xs"
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
        </div>
        <p class="text-xs text-surface-500">{m.admin_licensing_install_id_note()}</p>
        {#if data.licenseServerContactEnabled === false}
            <p class="text-xs text-surface-300" data-testid="lumastra-org-contact">
                {m.admin_instance_contact_off()}
            </p>
        {/if}
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
