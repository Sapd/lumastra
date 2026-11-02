<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Radio tab content for Settings → Live TV (admin IA redesign, spec §3.6:
  sources/channels/proxy/radio as tabs on ONE page). Ported near-verbatim
  from the deleted standalone `/admin/radio` page — fully self-fetching, no
  props from the parent route needed.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import {
        uploadMediaImage,
        uploadMediaImageByUrl,
        deleteMediaImage,
        getAdminRadioStations,
        createAdminRadioStation,
        updateAdminRadioStation,
        deleteAdminRadioStation,
        getAdminRadioStreamInfo,
    } from '$lib/api/admin';
    import type { AdminRadioStationItem } from '$lib/schemas/api-admin-responses.js';
    import { toasts } from '$lib/stores/toast.store';
    import { AdminPageHeader } from '$lib/components/admin';
    import { type RadioMetadataSource as RadioMetadataSourceType } from '$lib/schemas/radio';
    import RadioMetadataSource from '$lib/components/admin/RadioMetadataSource.svelte';
    import type { RadioMetadataSourceChange } from '$lib/components/admin/radio-metadata-source';
    import { Icon, Microphone, Plus, Pencil, Trash, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    type Station = AdminRadioStationItem;

    let stations = $state<Station[]>([]);
    let loading = $state(true);
    let saving = $state(false);

    // Form state
    let editingId = $state<string | null>(null);
    let showCreateForm = $state(false);
    let formName = $state('');
    let formStreamUrl = $state('');
    let formGenre = $state('');
    let formDescription = $state('');
    let formLogoUrl = $state('');
    let formMetadataSource = $state<RadioMetadataSourceType | null>(null);
    let formMetadataValid = $state(true);
    let formMetadataDirty = $state(false);
    /** Bumped per form open so the now-playing editor remounts with fresh state. */
    let formKey = $state(0);
    let metadataOpen = $state(false);
    let probingStream = $state(false);
    let prefilledFields = $state<string[]>([]);
    /** Stream URL last probed successfully, so re-blurring it does not refetch. */
    let probedStreamUrl = '';
    /** Only the newest stream probe may touch the form. */
    let probeSeq = 0;

    async function load(): Promise<void> {
        loading = true;
        const { data, error } = await getAdminRadioStations();
        if (error) toasts.error(error);
        else if (data) stations = data.stations;
        loading = false;
    }

    function resetForm(): void {
        formName = '';
        formStreamUrl = '';
        formGenre = '';
        formDescription = '';
        formLogoUrl = '';
        formMetadataSource = null;
        formMetadataValid = true;
        formMetadataDirty = false;
        prefilledFields = [];
        probedStreamUrl = '';
        probeSeq++;
        probingStream = false;
        metadataOpen = false;
        editingId = null;
        showCreateForm = false;
        formKey++;
    }

    function handleMetadataChange(change: RadioMetadataSourceChange): void {
        formMetadataSource = change.source;
        formMetadataValid = change.valid;
        formMetadataDirty = change.dirty;
    }

    /**
     * New stations only: prefill empty name/genre/description from the
     * stream's ICY headers. Never overwrites what the admin already typed, and
     * never touches an existing station.
     */
    async function probeStream(): Promise<void> {
        if (editingId) return;
        const url = formStreamUrl.trim();
        if (!url || url === probedStreamUrl || !URL.canParse(url)) return;
        const seq = ++probeSeq;
        probingStream = true;
        prefilledFields = [];
        const { data } = await getAdminRadioStreamInfo(url);
        // A newer probe, a reset, or a different URL supersedes this one.
        if (seq !== probeSeq) return;
        probingStream = false;
        if (!data?.reachable || formStreamUrl.trim() !== url) return;
        probedStreamUrl = url;
        const filled: string[] = [];
        if (data.name && !formName.trim()) {
            formName = data.name;
            filled.push(m.playlist_name());
        }
        if (data.genre && !formGenre.trim()) {
            formGenre = data.genre;
            filled.push(m.admin_radio_genre());
        }
        if (data.description && !formDescription.trim()) {
            formDescription = data.description;
            filled.push(m.admin_radio_description());
        }
        prefilledFields = filled;
    }

    function startEdit(station: Station): void {
        editingId = station.id;
        showCreateForm = false;
        formName = station.name;
        formStreamUrl = station.streamUrl;
        formGenre = station.genre ?? '';
        formDescription = station.description ?? '';
        formLogoUrl = '';
        formMetadataSource =
            (station.metadataSource as RadioMetadataSourceType | undefined) ?? null;
        formMetadataValid = true;
        formMetadataDirty = false;
        prefilledFields = [];
        probeSeq++;
        probingStream = false;
        metadataOpen = Boolean(formMetadataSource);
        formKey++;
    }

    /** An incomplete source the admin edited blocks the save; an untouched one never does. */
    function metadataBlocksSave(): boolean {
        if (formMetadataValid || !formMetadataDirty) return false;
        metadataOpen = true;
        toasts.error(m.admin_radio_metadata_invalid());
        return true;
    }

    async function handleCreate(): Promise<void> {
        // A second Enter before the button re-renders disabled created the
        // station twice.
        if (saving) return;
        if (!formName.trim() || !formStreamUrl.trim()) {
            toasts.error(m.admin_toast_name_and_stream_url_are_required());
            return;
        }
        if (metadataBlocksSave()) return;
        saving = true;
        const payload: Parameters<typeof createAdminRadioStation>[0] = {
            name: formName.trim(),
            streamUrl: formStreamUrl.trim(),
        };
        if (formGenre.trim()) payload.genre = formGenre.trim();
        if (formDescription.trim()) payload.description = formDescription.trim();
        if (formLogoUrl.trim()) payload.logoUrl = formLogoUrl.trim();
        if (formMetadataSource)
            payload.metadataSource = formMetadataSource as Record<string, unknown>;

        let result: Awaited<ReturnType<typeof createAdminRadioStation>>;
        try {
            result = await createAdminRadioStation(payload);
        } finally {
            saving = false;
        }
        const { data, error } = result;
        if (error || !data) {
            toasts.error(error ?? m.admin_radio_create_failed());
            return;
        }
        toasts.success(m.admin_toast_radio_station_created());
        resetForm();
        await load();
    }

    async function handleUpdate(): Promise<void> {
        if (!editingId || saving) return;
        if (!formName.trim() || !formStreamUrl.trim()) {
            toasts.error(m.admin_toast_name_and_stream_url_are_required());
            return;
        }
        if (metadataBlocksSave()) return;
        saving = true;
        const payload: Parameters<typeof updateAdminRadioStation>[1] = {
            name: formName.trim(),
            streamUrl: formStreamUrl.trim(),
            genre: formGenre.trim() || null,
            description: formDescription.trim() || null,
        };
        // Leave the stored source alone unless the admin changed it.
        if (formMetadataDirty)
            payload.metadataSource = formMetadataSource as Record<string, unknown> | null;

        let result: Awaited<ReturnType<typeof updateAdminRadioStation>>;
        try {
            result = await updateAdminRadioStation(editingId, payload);
        } finally {
            saving = false;
        }
        const { data, error } = result;
        if (error || !data) {
            toasts.error(error ?? m.admin_radio_update_failed());
            return;
        }
        toasts.success(m.admin_toast_radio_station_updated());
        resetForm();
        await load();
    }

    async function handleDelete(station: Station): Promise<void> {
        if (!confirm(m.admin_radio_confirm_delete({ name: station.name }))) return;
        const { data, error } = await deleteAdminRadioStation(station.id);
        if (error || !data) {
            toasts.error(error ?? m.admin_radio_delete_failed());
            return;
        }
        toasts.success(m.admin_toast_radio_station_deleted());
        if (editingId === station.id) resetForm();
        await load();
    }

    async function handleLogoFile(station: Station, file: File): Promise<void> {
        const { data, error } = await uploadMediaImage(station.id, 'poster', file);
        if (error || !data) {
            toasts.error(error ?? m.toast_avatar_upload_failed());
            return;
        }
        toasts.success(m.admin_toast_logo_uploaded());
        await load();
    }

    async function handleLogoUrl(station: Station): Promise<void> {
        const url = prompt(m.admin_radio_prompt_image_url());
        if (!url?.trim()) return;
        const { data, error } = await uploadMediaImageByUrl(station.id, 'poster', url.trim());
        if (error || !data) {
            toasts.error(error ?? m.request_status_download_failed());
            return;
        }
        toasts.success(m.admin_toast_logo_downloaded());
        await load();
    }

    async function handleLogoClear(station: Station): Promise<void> {
        if (!confirm(m.admin_radio_confirm_remove_logo({ name: station.name }))) return;
        const { data, error } = await deleteMediaImage(station.id, 'poster');
        if (error || !data) {
            toasts.error(error ?? m.admin_radio_remove_failed());
            return;
        }
        toasts.success(m.admin_toast_logo_removed());
        await load();
    }

    $effect(() => {
        untrack(() => load());
    });
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={Microphone}
        title={m.admin_radio_page_title()}
        description={m.admin_radio_page_description()} />

    <!-- Add new -->
    <div class="rounded-lg bg-surface-800/50 p-4">
        {#if !showCreateForm && !editingId}
            <button
                class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-400"
                onclick={() => {
                    resetForm();
                    showCreateForm = true;
                }}>
                <Icon src={Plus} class="h-4 w-4" />
                {m.admin_radio_add_station()}
            </button>
        {/if}

        {#if showCreateForm || editingId}
            <form
                class="space-y-3"
                onsubmit={(e) => {
                    e.preventDefault();
                    if (editingId) {
                        void handleUpdate();
                    } else {
                        void handleCreate();
                    }
                }}>
                <div class="flex items-center justify-between">
                    <h2 class="text-lg font-semibold text-white">
                        {editingId ? m.admin_radio_edit_station() : m.admin_radio_new_station()}
                    </h2>
                    <button
                        type="button"
                        class="text-surface-400 hover:text-white"
                        onclick={resetForm}
                        aria-label={m.admin_aria_cancel()}>
                        <Icon src={XMark} class="h-5 w-5" />
                    </button>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label class="block text-sm">
                        <span class="text-surface-300">{m.admin_radio_stream_url_required()}</span>
                        <input
                            bind:value={formStreamUrl}
                            type="url"
                            required
                            placeholder="https://listener.example.com/stream.aac"
                            onchange={() => void probeStream()}
                            class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none" />
                    </label>

                    <label class="block text-sm">
                        <span class="text-surface-300">{m.admin_radio_name_required()}</span>
                        <input
                            bind:value={formName}
                            type="text"
                            required
                            placeholder="TechnoBase FM"
                            class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none" />
                    </label>

                    <label class="block text-sm">
                        <span class="text-surface-300">{m.admin_radio_genre()}</span>
                        <input
                            bind:value={formGenre}
                            type="text"
                            placeholder="Hardstyle / Techno"
                            class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none" />
                    </label>

                    {#if !editingId}
                        <label class="block text-sm">
                            <span class="text-surface-300">
                                {m.admin_radio_logo_url_label()}
                            </span>
                            <input
                                bind:value={formLogoUrl}
                                type="url"
                                placeholder="https://.../logo.png"
                                class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none" />
                        </label>
                    {/if}
                </div>

                {#if probingStream}
                    <p class="text-xs text-surface-400">{m.admin_radio_reading_stream()}</p>
                {:else if prefilledFields.length > 0}
                    <p class="text-xs text-surface-400">
                        {m.admin_radio_prefilled_from_stream({
                            fields: prefilledFields.join(', '),
                        })}
                    </p>
                {/if}

                <label class="block text-sm">
                    <span class="text-surface-300">{m.admin_radio_description()}</span>
                    <textarea
                        bind:value={formDescription}
                        rows="2"
                        placeholder={m.admin_placeholder_optional_description()}
                        class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none"
                    ></textarea>
                </label>

                <details class="rounded-lg border border-surface-700 p-3" bind:open={metadataOpen}>
                    <summary class="cursor-pointer text-sm font-medium text-surface-200">
                        {m.admin_radio_now_playing_section()}
                    </summary>
                    <div class="mt-3">
                        {#key formKey}
                            <RadioMetadataSource
                                streamUrl={formStreamUrl}
                                value={untrack(() => formMetadataSource) ?? undefined}
                                onChange={handleMetadataChange} />
                        {/key}
                    </div>
                </details>

                <div class="flex gap-2">
                    <button
                        type="submit"
                        disabled={saving}
                        class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-400 disabled:opacity-50">
                        {saving
                            ? m.playlist_saving()
                            : editingId
                              ? m.upcoming_update()
                              : m.playlist_create()}
                    </button>
                    <button
                        type="button"
                        class="rounded-lg bg-surface-700 px-4 py-2 text-sm text-white hover:bg-surface-600"
                        onclick={resetForm}>{m.common_cancel()}</button>
                </div>
            </form>
        {/if}
    </div>

    <!-- List -->
    {#if loading}
        <div class="space-y-2">
            {#each Array(3) as _, i (i)}
                <div class="h-16 animate-pulse rounded-lg bg-surface-800/50"></div>
            {/each}
        </div>
    {:else if stations.length === 0}
        <div class="rounded-lg bg-surface-800/30 px-6 py-12 text-center text-surface-400">
            {m.admin_radio_empty()}
        </div>
    {:else}
        <div class="space-y-2">
            {#each stations as station (station.id)}
                <div class="flex items-center gap-4 rounded-lg bg-surface-800/50 p-3">
                    <!-- Logo -->
                    <div class="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-surface-900">
                        {#if station.logoUrl}
                            <img
                                src={station.logoUrl}
                                alt={station.name}
                                class="h-full w-full object-cover" />
                        {:else}
                            <div class="flex h-full w-full items-center justify-center text-2xl">
                                📻
                            </div>
                        {/if}
                    </div>

                    <!-- Info -->
                    <div class="min-w-0 flex-1">
                        <p class="truncate font-semibold text-white">
                            {station.name}
                        </p>
                        <p class="truncate font-mono text-xs text-surface-400">
                            {station.streamUrl}
                        </p>
                        {#if station.genre}
                            <p class="text-xs text-surface-300">
                                {station.genre}
                            </p>
                        {/if}
                    </div>

                    <!-- Actions -->
                    <div class="flex flex-shrink-0 items-center gap-1">
                        <!-- Logo controls -->
                        <label
                            class="cursor-pointer rounded px-2 py-1 text-xs text-surface-300 hover:bg-surface-700"
                            title={m.admin_title_upload_logo_file()}>
                            {m.media_label_file()}
                            <input
                                type="file"
                                accept="image/*"
                                class="hidden"
                                onchange={(e) => {
                                    const input = e.currentTarget as HTMLInputElement;
                                    const file = input.files?.[0];
                                    if (file) {
                                        void handleLogoFile(station, file);
                                    }
                                    input.value = '';
                                }} />
                        </label>
                        <button
                            class="rounded px-2 py-1 text-xs text-surface-300 hover:bg-surface-700"
                            onclick={() => handleLogoUrl(station)}
                            title={m.admin_title_set_logo_from_url()}>
                            URL
                        </button>
                        {#if station.logoUrl}
                            <button
                                class="rounded px-2 py-1 text-xs text-surface-400 hover:bg-surface-700 hover:text-error-400"
                                onclick={() => handleLogoClear(station)}
                                title={m.admin_title_remove_logo()}>
                                ✕
                            </button>
                        {/if}

                        <!-- Now-playing chip -->
                        <button
                            class="text-xs"
                            onclick={() => {
                                startEdit(station);
                                metadataOpen = true;
                                setTimeout(() => {
                                    document
                                        .querySelector('[data-radio-metadata-source]')
                                        ?.scrollIntoView({
                                            behavior: 'smooth',
                                            block: 'center',
                                        });
                                }, 0);
                            }}>
                            {#if station.metadataSource && station.lastError}
                                <span
                                    class="badge variant-soft-error"
                                    title={m.admin_radio_badge_config_error_tooltip({
                                        at: station.lastError.at,
                                        message: station.lastError.message,
                                    })}>
                                    • {m.admin_radio_badge_config_error()}
                                </span>
                            {:else if station.metadataSource}
                                <span
                                    class="badge variant-soft-success"
                                    title={m.admin_title_now_playing_configured()}>
                                    • {m.admin_radio_badge_now_playing()}
                                </span>
                            {:else}
                                <span
                                    class="badge variant-soft-surface"
                                    title={m.admin_title_falls_back_to_icy()}>
                                    • {m.admin_radio_badge_icy_only()}
                                </span>
                            {/if}
                        </button>

                        <!-- Edit/Delete -->
                        <button
                            class="rounded p-2 text-surface-300 hover:bg-surface-700 hover:text-white"
                            onclick={() => startEdit(station)}
                            aria-label={m.admin_aria_edit()}>
                            <Icon src={Pencil} class="h-4 w-4" />
                        </button>
                        <button
                            class="rounded p-2 text-surface-400 hover:bg-error-900/30 hover:text-error-400"
                            onclick={() => handleDelete(station)}
                            aria-label={m.admin_aria_delete()}>
                            <Icon src={Trash} class="h-4 w-4" />
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>
