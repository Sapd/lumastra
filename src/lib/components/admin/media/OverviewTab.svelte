<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import EpisodeLanguageSummary from './EpisodeLanguageSummary.svelte';
    import type { EpisodeLanguageSummary as EpisodeLanguages } from '$lib/schemas/admin-language-summary.js';
    import ArtistCreditsEditor from './ArtistCreditsEditor.svelte';
    import { onDestroy, untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { beforeNavigate } from '$app/navigation';
    import { updateMediaMetadata } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { Icon, LockClosed, LockOpen } from 'svelte-hero-icons';
    import AssignArtistSection from './AssignArtistSection.svelte';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';
    import { isNonEntertainment, isTrack } from '$lib/shared/media-types';
    import MetadataFieldRenderer from '$lib/components/library/MetadataFieldRenderer.svelte';

    interface AudioFeatures {
        bpm?: number;
        key?: string;
        energy?: number;
        danceability?: number;
        loudness_lufs?: number;
        essentia_analyzed?: boolean;
        mood_tags?: string[];
    }

    interface Props {
        languageSummary?: EpisodeLanguages | null;
        mediaId: string;
        title: string;
        titleSource?: string;
        status?: string;
        dismissed?: boolean;
        canonicalId?: string | null;
        onbusychange?: (mediaId: string, busy: boolean) => void;
        metadataBusy?: boolean;
        lockedAt?: string;
        originalTitle?: string | null;
        englishTitle?: string | null;
        year?: number | null;
        overview?: string | null;
        locked: boolean;
        lockedBy?: string | null;
        mediaType: string;
        createdAt?: string | null;
        updatedAt?: string | null;
        audioFeatures?: Record<string, unknown>;
        /** custom_metadata JSONB for non-entertainment items */
        customMetadata?: Record<string, unknown>;
        parentArtistId?: string;
        parentArtistTitle?: string | null;
        /**
         * The lock banner uses the same parent-owned unlock flow as More actions.
         */
        onUnlock?: () => void;
        /**
         * True while the parent's unlock call is in flight. Drives this tab's
         * own Unlock button's `disabled` -- it must NOT reuse the local
         * `saving` state below, which only tracks the metadata-save flow and
         * would let a slow unlock be double-submitted.
         */
        unlocking?: boolean;
        onsaved?: () => void | Promise<void>;
    }

    let {
        mediaId,
        languageSummary,
        title,
        titleSource,
        status,
        dismissed = false,
        canonicalId,
        onbusychange,
        metadataBusy = false,
        lockedAt,
        originalTitle,
        englishTitle,
        year,
        overview,
        locked,
        lockedBy,
        mediaType,
        createdAt,
        updatedAt,
        audioFeatures,
        customMetadata,
        parentArtistId,
        parentArtistTitle,
        onUnlock,
        unlocking = false,
        onsaved,
    }: Props = $props();

    let isAudioType = $derived(isTrack(mediaType));

    // Non-entertainment template metadata
    let isNonEntType = $derived(isNonEntertainment(mediaType));
    let nonEntTemplate = $derived(isNonEntType ? getLibraryTypeTemplate(mediaType) : undefined);
    function initialCustomMetadata(): Record<string, unknown> {
        return { ...(customMetadata ?? {}) };
    }

    let editCustomMetadata = $state<Record<string, unknown>>(initialCustomMetadata());

    function toAudioFeatures(raw: Record<string, unknown> | undefined): AudioFeatures | null {
        if (!raw) return null;
        const ess: Record<string, unknown> =
            raw.essentia && typeof raw.essentia === 'object'
                ? (raw.essentia as Record<string, unknown>)
                : {};
        return {
            bpm: typeof ess.bpm === 'number' ? ess.bpm : undefined,
            key: typeof ess.key === 'string' ? ess.key : undefined,
            energy: typeof ess.energy === 'number' ? ess.energy : undefined,
            danceability: typeof ess.danceability === 'number' ? ess.danceability : undefined,
            loudness_lufs: typeof ess.loudness_lufs === 'number' ? ess.loudness_lufs : undefined,
            essentia_analyzed:
                typeof ess.essentia_analyzed === 'boolean' ? ess.essentia_analyzed : undefined,
            mood_tags: Array.isArray(ess.mood_tags) ? (ess.mood_tags as string[]) : undefined,
        };
    }

    let parsedAudioFeatures = $derived(toAudioFeatures(audioFeatures));

    function formatDate(dateStr: string): string {
        return new Date(dateStr).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    let editTitle = $state('');
    let editYear = $state<number | undefined>(undefined);
    let editOverview = $state('');
    let overviewEdited = $state(false);
    let saving = $state(false);
    let isLocked = $state(false);
    let confirming = $state(false);
    let reloading = $state(false);
    let confirmedSnapshot = $state<string>();
    let confirmationSnapshot = $derived(
        JSON.stringify([mediaId, title, titleSource, locked, lockedBy, lockedAt]),
    );
    let confirmationError = $state('');
    let confirmationStale = $state(false);
    let canConfirmTitle = $derived(
        mediaType === 'track' &&
            status === 'active' &&
            !dismissed &&
            !canonicalId &&
            titleSource === 'filename' &&
            !locked &&
            !isLocked &&
            confirmationSnapshot !== confirmedSnapshot,
    );

    const attributionPending = $derived(
        confirmedSnapshot !== undefined && confirmedSnapshot === confirmationSnapshot,
    );
    let disposed = false;
    onDestroy(() => {
        disposed = true;
    });

    interface MetadataOperation {
        id: string;
        refresh: (() => void | Promise<void>) | undefined;
        current: () => boolean;
        finish: () => void;
    }

    function beginOperation(): MetadataOperation {
        // Keyed navigation destroys the form, but async continuations and prop
        // getters remain live. Release the owner that actually started this work.
        const id = mediaId;
        const busyChanged = onbusychange;
        const refresh = onsaved;
        busyChanged?.(id, true);
        return {
            id,
            refresh,
            current: () => !disposed && mediaId === id,
            finish: () => busyChanged?.(id, false),
        };
    }

    async function reloadTitle(): Promise<void> {
        if (!onsaved || saving || confirming || reloading || unlocking || metadataBusy) return;
        reloading = true;
        const operation = beginOperation();
        try {
            await operation.refresh?.();
            if (!operation.current()) return;
            confirmationError = '';
            confirmationStale = false;
        } catch {
            if (operation.current()) confirmationError = m.media_overview_confirm_reload_failed();
        } finally {
            if (operation.current()) reloading = false;
            operation.finish();
        }
    }

    async function handleConfirmTitle(): Promise<void> {
        if (
            !canConfirmTitle ||
            editing ||
            saving ||
            confirming ||
            reloading ||
            unlocking ||
            metadataBusy ||
            confirmationStale
        )
            return;
        const snapshot = {
            title,
            source: 'filename' as const,
            locked,
            ...(lockedBy != null ? { lockedBy } : {}),
            ...(lockedAt != null ? { lockedAt } : {}),
        };
        const snapshotVersion = confirmationSnapshot;
        confirming = true;
        confirmationStale = true;
        const operation = beginOperation();
        confirmationError = '';
        try {
            const result = await updateMediaMetadata(operation.id, {
                confirmFilenameTitle: snapshot,
            });
            if (!operation.current()) return;
            if (result.error || !result.data?.locked) {
                confirmationError =
                    result.status === 409
                        ? m.media_overview_confirm_stale()
                        : m.media_overview_confirm_failed();
                return;
            }
            confirmedSnapshot = snapshotVersion;
            isLocked = true;
            currentLockedBy = null;
            toasts.success(m.media_overview_confirm_success());
            try {
                await operation.refresh?.();
            } catch {
                if (operation.current())
                    confirmationError = m.media_overview_confirm_reload_failed();
            }
        } catch {
            if (operation.current()) confirmationError = m.media_overview_confirm_failed();
        } finally {
            if (operation.current()) confirming = false;
            operation.finish();
        }
    }
    /**
     * Read-only until the operator asks to edit (triage spec §7). The form used
     * to be always open, so every visit to an item looked like an edit screen
     * and a stray keystroke left it dirty.
     */
    let editing = $state(false);
    let currentLockedBy = $state<string | null | undefined>(null);

    // Lock state always follows the props (resets on navigation/refetch).
    $effect(() => {
        isLocked = locked;
        currentLockedBy = lockedBy;
    });

    // The form follows the props only while it is closed. Any invalidateAll
    // (an unlock, another tab's save, assigning an artist) hands new props in,
    // and re-seeding then would wipe what the operator is typing.
    $effect(() => {
        const nextTitle = title;
        const nextYear = year ?? undefined;
        const nextOverview = overview ?? '';
        const nextCustom = { ...(customMetadata ?? {}) };
        if (untrack(() => editing)) return;
        editTitle = nextTitle;
        editYear = nextYear;
        editOverview = nextOverview;
        overviewEdited = false;
        editCustomMetadata = nextCustom;
    });

    // A cleared number input binds null, so compare years with null ≡ undefined.
    let dirty = $derived(
        editTitle !== title ||
            (editYear ?? undefined) !== (year ?? undefined) ||
            editOverview !== (overview ?? '') ||
            (isNonEntType &&
                JSON.stringify(editCustomMetadata) !== JSON.stringify(customMetadata ?? {})),
    );

    const inputClass =
        'w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none';

    beforeNavigate(({ cancel, willUnload }) => {
        if (!editing || !dirty) return;
        // A page unload only gets the browser's own prompt; cancel() triggers it.
        if (willUnload || !window.confirm(m.media_overview_unsaved_confirm())) cancel();
    });

    async function handleSave(): Promise<void> {
        if (saving || confirming || reloading || unlocking || metadataBusy) return;
        const sent = {
            title: editTitle,
            year: editYear,
            overview: editOverview,
            overviewEdited,
            custom: JSON.stringify(editCustomMetadata),
        };
        saving = true;
        confirmationStale = true;
        const operation = beginOperation();
        try {
            const patch: Parameters<typeof updateMediaMetadata>[1] = {
                title: sent.title,
                releaseYear: sent.year,
            };
            // Omission preserves the stored overview (including NULL). An
            // input event records an intentional edit, including clearing it.
            if (sent.overviewEdited) patch.overview = sent.overview;
            if (isNonEntType) {
                patch.customMetadata = { ...editCustomMetadata };
            }
            const { data, error } = await updateMediaMetadata(operation.id, patch);
            if (!operation.current()) return;
            if (error || !data) {
                confirmationError = m.media_overview_save_failed();
                toasts.error(m.media_overview_save_failed());
                return;
            }
            isLocked = true;
            // Leave edit mode only if nothing was typed while the request ran;
            // otherwise those edits stay open and dirty instead of vanishing.
            const unchanged =
                editTitle === sent.title &&
                editYear === sent.year &&
                editOverview === sent.overview &&
                JSON.stringify(editCustomMetadata) === sent.custom;
            if (unchanged) editing = false;
            toasts.success(m.media_overview_save_success());
            try {
                await operation.refresh?.();
                if (!operation.current()) return;
                confirmationError = '';
                confirmationStale = false;
            } catch {
                if (operation.current())
                    confirmationError = m.media_overview_confirm_reload_failed();
            }
        } catch {
            if (operation.current()) {
                confirmationError = m.media_overview_save_failed();
                toasts.error(m.media_overview_save_failed());
            }
        } finally {
            if (operation.current()) saving = false;
            operation.finish();
        }
    }

    export function startEditing(expectedMediaId?: string): boolean {
        if (expectedMediaId && expectedMediaId !== mediaId) return false;
        editing = true;
        return true;
    }

    function handleCancel(): void {
        editing = false;
        editTitle = title;
        editYear = year ?? undefined;
        editOverview = overview ?? '';
        overviewEdited = false;
        editCustomMetadata = { ...(customMetadata ?? {}) };
    }
</script>

<div class="space-y-6">
    {#if mediaType === 'episode'}<EpisodeLanguageSummary summary={languageSummary} />{/if}
    <!-- Lock status banner -->
    {#if isLocked}
        <div
            class="flex items-center justify-between rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-4 py-3">
            <div class="flex items-center gap-2">
                <Icon src={LockClosed} class="w-4 h-4 text-yellow-400" />
                <span class="text-yellow-300 text-sm">
                    {attributionPending
                        ? m.media_overview_confirm_attribution_pending()
                        : m.media_overview_lock_banner({
                              user: currentLockedBy ?? m.media_overview_unknown_user(),
                          })}
                </span>
            </div>
            <button
                class="btn variant-ghost-warning text-xs px-3 py-1"
                onclick={onUnlock}
                disabled={metadataBusy || unlocking || saving || confirming || reloading}>
                <Icon src={LockOpen} class="w-3.5 h-3.5 mr-1" />
                {m.media_overview_unlock_button()}
            </button>
        </div>
    {/if}

    {#if !editing}
        <div class="flex justify-end">
            <button
                type="button"
                class="btn variant-ghost-surface text-sm px-4 py-1.5"
                onclick={() => (editing = true)}
                disabled={metadataBusy || saving || confirming || reloading || unlocking}>
                {m.edit()}
            </button>
        </div>
    {/if}

    {#if mediaType === 'track' && titleSource === 'filename' && !editing}
        <details class="text-sm text-surface-400">
            <summary class="cursor-pointer">{m.media_overview_confirm_explanation()}</summary>
            {#if canConfirmTitle}<button
                    type="button"
                    class="btn variant-filled-primary text-sm px-4 py-2"
                    onclick={handleConfirmTitle}
                    disabled={metadataBusy ||
                        confirming ||
                        reloading ||
                        saving ||
                        unlocking ||
                        confirmationStale}>
                    {confirming
                        ? m.media_overview_confirm_pending()
                        : m.media_overview_confirm_title()}
                </button>{/if}
        </details>
    {/if}
    {#if confirmationError}
        <div role="alert" class="text-sm text-error-300 space-y-2">
            <p>{confirmationError}</p>
            {#if onsaved}
                <button
                    type="button"
                    class="btn variant-ghost-surface text-sm"
                    onclick={reloadTitle}
                    disabled={metadataBusy || saving || confirming || reloading || unlocking}>
                    {reloading ? m.loading() : m.media_overview_confirm_reload()}
                </button>
            {/if}
        </div>
    {/if}

    <!-- Form fields -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Title -->
        <div class="space-y-1.5 md:col-span-2" class:hidden={!editing}>
            <label
                class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                for="edit-title">
                {m.media_overview_title_label()}
            </label>
            {#if editing}
                <input id="edit-title" type="text" class={inputClass} bind:value={editTitle} />
            {:else}
                <p id="edit-title" class="text-surface-100 text-sm py-2">{title}</p>
            {/if}
        </div>

        <!-- Original Title (read-only, from original production language) -->
        {#if originalTitle && originalTitle !== title}
            <div class="space-y-1.5">
                <span class="text-xs text-surface-400 font-medium uppercase tracking-wide block">
                    {m.media_overview_original_title_label()}
                </span>
                <p class="text-surface-300 text-sm py-2">{originalTitle}</p>
            </div>
        {/if}

        <!-- English Title (read-only, from TMDB translations) -->
        {#if englishTitle && englishTitle !== title && englishTitle !== originalTitle}
            <div class="space-y-1.5">
                <span class="text-xs text-surface-400 font-medium uppercase tracking-wide block">
                    {m.media_overview_english_title_label()}
                </span>
                <p class="text-surface-300 text-sm py-2">{englishTitle}</p>
            </div>
        {/if}

        <!-- Year -->
        <div class="space-y-1.5" class:hidden={!editing}>
            <label
                class="text-xs text-surface-400 font-medium uppercase tracking-wide"
                for="edit-year">
                {m.media_overview_year_label()}
            </label>
            {#if editing}
                <input
                    id="edit-year"
                    type="number"
                    class="w-40 bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none"
                    min="1800"
                    max="2200"
                    bind:value={editYear} />
            {:else}
                <p id="edit-year" class="text-surface-100 text-sm py-2">{year ?? '—'}</p>
            {/if}
        </div>

        {#if mediaType === 'album'}
            <div class="space-y-1.5 md:col-span-2">
                <span class="text-xs text-surface-400 font-medium uppercase tracking-wide block">
                    {m.media_overview_artist_label()}
                </span>
                <AssignArtistSection
                    albumId={mediaId}
                    currentArtistId={parentArtistId}
                    currentArtistTitle={parentArtistTitle}
                    {onsaved} />
            </div>
        {/if}
    </div>

    <!-- Overview -->
    <div class="space-y-1.5">
        <label
            class="text-xs text-surface-400 font-medium uppercase tracking-wide"
            for="edit-overview">
            {m.overview()}
        </label>
        {#if editing}
            <textarea
                id="edit-overview"
                class={inputClass}
                rows="8"
                style="resize: vertical;"
                oninput={() => (overviewEdited = true)}
                bind:value={editOverview}></textarea>
        {:else if overview}
            <p
                id="edit-overview"
                class="text-surface-200 text-sm leading-relaxed whitespace-pre-line">
                {overview}
            </p>
        {/if}
        {#if editing ? !editOverview.trim() : !overview?.trim()}
            <p class="text-xs text-surface-500 mt-1">
                {m.media_overview_no_overview_prefix()}
            </p>
        {/if}
    </div>

    <!-- Audio Features (music/audio only) -->
    {#if isAudioType}
        <div class="space-y-3 pt-2">
            <div class="flex items-center gap-3">
                <h4 class="text-xs text-surface-400 font-medium uppercase tracking-wide">
                    {m.media_overview_audio_features_heading()}
                </h4>
                {#if parsedAudioFeatures?.essentia_analyzed}
                    <span
                        class="px-2 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        {m.media_overview_essentia_analyzed()}
                    </span>
                {:else}
                    <span
                        class="px-2 py-0.5 text-xs rounded-full bg-surface-700/60 text-surface-400 border border-surface-600/30">
                        {m.media_overview_not_analyzed()}
                    </span>
                {/if}
            </div>
            {#if parsedAudioFeatures}
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {#if parsedAudioFeatures.bpm !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-3 py-2">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-0.5">
                                {m.media_overview_bpm_label()}
                            </div>
                            <div class="text-surface-100 text-sm font-medium">
                                {parsedAudioFeatures.bpm.toFixed(1)}
                            </div>
                        </div>
                    {/if}
                    {#if parsedAudioFeatures.key}
                        <div class="bg-surface-800/40 rounded-lg px-3 py-2">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-0.5">
                                {m.media_overview_key_label()}
                            </div>
                            <div class="text-surface-100 text-sm font-medium">
                                {parsedAudioFeatures.key}
                            </div>
                        </div>
                    {/if}
                    {#if parsedAudioFeatures.energy !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-3 py-2">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-0.5">
                                {m.media_overview_energy_label()}
                            </div>
                            <div class="text-surface-100 text-sm font-medium">
                                {(parsedAudioFeatures.energy * 100).toFixed(0)}%
                            </div>
                        </div>
                    {/if}
                    {#if parsedAudioFeatures.danceability !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-3 py-2">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-0.5">
                                {m.media_music_danceability_label()}
                            </div>
                            <div class="text-surface-100 text-sm font-medium">
                                {m.media_music_danceability_score({
                                    score: parsedAudioFeatures.danceability.toLocaleString(
                                        undefined,
                                        { maximumFractionDigits: 2 },
                                    ),
                                })}
                                <meter
                                    min="0"
                                    max="3"
                                    value={Math.max(
                                        0,
                                        Math.min(3, parsedAudioFeatures.danceability),
                                    )}
                                    aria-label={m.media_music_danceability_label()}
                                    aria-valuemin="0"
                                    aria-valuemax="3"
                                    aria-valuenow={parsedAudioFeatures.danceability}
                                    class="block w-full"></meter>
                            </div>
                        </div>
                    {/if}
                    {#if parsedAudioFeatures.loudness_lufs !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-3 py-2">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-0.5">
                                {m.media_overview_loudness_label()}
                            </div>
                            <div class="text-surface-100 text-sm font-medium">
                                {parsedAudioFeatures.loudness_lufs.toFixed(1)} LUFS
                            </div>
                        </div>
                    {/if}
                </div>
                {#if parsedAudioFeatures.mood_tags && parsedAudioFeatures.mood_tags.length > 0}
                    <div class="space-y-1.5">
                        <div class="text-xs text-surface-500 uppercase tracking-wide">
                            {m.media_overview_mood_tags_label()}
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                            {#each parsedAudioFeatures.mood_tags as tag, tagIdx (tag + '__' + tagIdx)}
                                <span
                                    class="px-2 py-0.5 text-xs rounded-full bg-primary-500/15 text-primary-300 border border-primary-500/20">
                                    {tag}
                                </span>
                            {/each}
                        </div>
                    </div>
                {/if}
            {:else}
                <p class="text-sm text-surface-500">
                    {m.media_overview_no_audio_features()}
                </p>
            {/if}
        </div>
    {/if}

    <!-- Non-entertainment template metadata fields -->
    {#if isNonEntType && nonEntTemplate && nonEntTemplate.metadataFields.length > 0}
        <div class="space-y-4 pt-2">
            <h4
                class="text-xs text-surface-400 font-medium uppercase tracking-wide border-t border-surface-700/50 pt-4">
                {m.media_overview_template_details_heading({ label: nonEntTemplate.label })}
            </h4>
            {#each nonEntTemplate.metadataFields as field (field.key)}
                {#if editing}
                    <MetadataFieldRenderer
                        {field}
                        value={editCustomMetadata[field.key]}
                        onchange={(v) => {
                            editCustomMetadata = { ...editCustomMetadata, [field.key]: v };
                        }} />
                {:else}
                    <div class="space-y-1">
                        <span
                            class="text-xs text-surface-400 font-medium uppercase tracking-wide block"
                            >{field.label}</span>
                        <p class="text-surface-200 text-sm">
                            {customMetadata?.[field.key] == null || customMetadata[field.key] === ''
                                ? '—'
                                : Array.isArray(customMetadata[field.key])
                                  ? (customMetadata[field.key] as unknown[]).join(', ')
                                  : String(customMetadata[field.key])}
                        </p>
                    </div>
                {/if}
            {/each}
        </div>
    {/if}

    <!-- Actions (edit mode only) -->
    {#if editing}
        <div class="flex gap-3 pt-2">
            <button
                class="btn variant-filled-primary text-sm px-5 py-2"
                onclick={handleSave}
                disabled={metadataBusy || saving || !dirty}>
                {saving ? m.media_overview_saving() : m.media_overview_save_changes()}
            </button>
            <button
                class="btn variant-ghost-surface text-sm px-5 py-2"
                onclick={handleCancel}
                disabled={metadataBusy || saving}>
                {m.cancel()}
            </button>
        </div>
    {/if}

    {#if isAudioType}<ArtistCreditsEditor
            {mediaId}
            refreshKey={confirmationSnapshot}
            {metadataBusy}
            {onbusychange}
            {onsaved} />{/if}
    <!-- Activity log -->
    <div class="space-y-3 pt-4">
        <h4 class="text-xs text-surface-400 font-medium uppercase tracking-wide">
            {m.media_overview_activity_heading()}
        </h4>
        <div class="space-y-2 text-sm">
            {#if updatedAt}
                <div class="flex items-center gap-2 text-surface-400">
                    <span class="w-1.5 h-1.5 rounded-full bg-primary-500 shrink-0"></span>
                    {m.media_overview_last_updated_label()}
                    <span class="text-surface-300">{formatDate(updatedAt)}</span>
                </div>
            {/if}
            {#if createdAt}
                <div class="flex items-center gap-2 text-surface-400">
                    <span class="w-1.5 h-1.5 rounded-full bg-surface-600 shrink-0"></span>
                    {m.media_overview_created_label()}
                    <span class="text-surface-300">{formatDate(createdAt)}</span>
                </div>
            {/if}
            {#if isLocked && currentLockedBy && !attributionPending}
                <div class="flex items-center gap-2 text-surface-400">
                    <span class="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0"></span>
                    {m.media_overview_locked_by_label()}
                    <span class="text-yellow-300">{currentLockedBy}</span>
                </div>
            {/if}
        </div>
    </div>
</div>
