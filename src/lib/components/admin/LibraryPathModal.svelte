<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { modals } from '$lib/stores/modal.store';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { createLibraryPath, patchLibraryPath, validateLibraryPath } from '$lib/api/admin';
    import type { LibraryPathCreateBody, LibraryPathPatchBody } from '$lib/schemas/admin.js';
    import { isNonEntertainment } from '$lib/shared/media-types';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { requireValue } from '$lib/utils/runtime-validation';
    import RemoteLibraryPicker from './RemoteLibraryPicker.svelte';
    import LibraryFolderPicker from './library/LibraryFolderPicker.svelte';
    import {
        REMOTE_LIBRARY_SOURCE_DESCRIPTORS,
        getRemoteLibrarySourceDescriptor,
        isLocalAudiobookLibrary,
    } from '$lib/shared/remote-library-sources';

    type MediaType =
        | 'movie'
        | 'tv'
        | 'anime'
        | 'music'
        | 'audiobook'
        | 'home_video'
        | 'training'
        | 'educational'
        | 'personal';
    type Provider = 'tmdb' | 'jellyfin' | 'anidb' | 'tvdb' | 'musicbrainz' | 'audiobookshelf';
    /**
     * Only these three are accepted as fallbacks by the API
     * (`fallback_providers: z.array(z.enum(['tmdb','anidb','jellyfin']))`), and
     * they are exactly the checkboxes this modal renders. The state was typed as
     * the full `Provider` union, which no longer matched the request type.
     */
    type FallbackProvider = 'tmdb' | 'anidb' | 'jellyfin';

    interface LibraryPath {
        id: string;
        path: string;
        mediaType: MediaType;
        language: string;
        provider: Provider;
        enabled: boolean;
        providerPath?: string | null;
        libraryGroupId: string;
        editionLabel?: string | null;
        scanChapters?: boolean;
        fallbackProviders?: FallbackProvider[];
    }

    interface LibraryGroupOption {
        id: string;
        name: string;
        icon?: string;
        sortOrder: number;
        /** What the group's existing paths use; absent for an empty group. */
        mediaType?: MediaType;
        provider?: Provider;
        language?: string;
        fallbackProviders?: FallbackProvider[];
    }

    interface Props {
        /** Pass existing path to edit, or omit for create mode */
        path?: LibraryPath;
        /** Available groups for the dropdown */
        groups: LibraryGroupOption[];
        /** Pre-selected group ID (for "add path to this group") */
        defaultGroupId?: string;
        /** Pre-fill from existing path in the group */
        defaultMediaType?: MediaType;
        defaultProvider?: Provider;
        defaultLanguage?: string;
        /** Edit mode, remote source: the upstream library's name, if known. */
        remoteLibraryName?: string;
        /** Called after successful save with the result */
        onSaved: (action: 'created' | 'updated', data?: { path: LibraryPath }) => void;
    }

    let {
        path,
        groups,
        defaultGroupId = '',
        defaultMediaType = 'movie',
        defaultProvider = 'tmdb',
        defaultLanguage = '',
        remoteLibraryName: existingRemoteName,
        onSaved,
    }: Props = $props();

    // Modal props are immutable after open — snapshot initial values intentionally
    // svelte-ignore state_referenced_locally
    const isEdit = !!path;
    // svelte-ignore state_referenced_locally
    let pathValue = $state(path?.path ?? '');
    // svelte-ignore state_referenced_locally
    let mediaType = $state<MediaType>(path?.mediaType ?? defaultMediaType);
    // svelte-ignore state_referenced_locally
    let language = $state(
        path?.language ??
            (getRemoteLibrarySourceDescriptor(defaultProvider) ? '' : defaultLanguage),
    );
    // svelte-ignore state_referenced_locally
    let provider = $state<Provider>(path?.provider ?? defaultProvider);
    // svelte-ignore state_referenced_locally
    let providerPath = $state(path?.providerPath ?? '');
    // svelte-ignore state_referenced_locally
    let editionLabel = $state(path?.editionLabel ?? '');
    // svelte-ignore state_referenced_locally
    let scanChapters = $state(path?.scanChapters ?? true);
    // A new folder in an existing library starts with that library's fallback
    // chain: the server requires every folder of a library to share it.
    // svelte-ignore state_referenced_locally
    let fallbackProviders = $state<FallbackProvider[]>(
        path?.fallbackProviders ??
            groups.find((g) => g.id === defaultGroupId)?.fallbackProviders ??
            [],
    );
    // Exclude the current primary provider from the fallback list sent to the API
    const cleanedFallbackProviders = $derived(fallbackProviders.filter((fp) => fp !== provider));
    // svelte-ignore state_referenced_locally
    let groupId = $state(path?.libraryGroupId ?? defaultGroupId);
    let saving = $state(false);

    // -------------------------------------------------------------------------
    // Source selection
    // -------------------------------------------------------------------------

    /**
     * Which kind of source this library comes from: a folder on disk, or a remote
     * media server that hosts its own libraries.
     *
     * Derived from the provider rather than stored twice, so an existing
     * AudiobookShelf row opens in remote mode without a second source of truth
     * that could disagree with `provider`.
     */
    const remoteDescriptor = $derived(getRemoteLibrarySourceDescriptor(provider));
    const isRemote = $derived(remoteDescriptor !== undefined);

    /**
     * A folder library typed Audiobook imports nothing (the scanner imports audio
     * only in music libraries; audiobooks come from AudiobookShelf), and the API
     * refuses to create one. The option stays only for a folder that already IS
     * one — created before that check — so its select is not blank, and the
     * notice below tells the operator why it is empty.
     */
    // svelte-ignore state_referenced_locally
    const isExistingLocalAudiobook =
        isEdit && !!path && isLocalAudiobookLibrary(path.mediaType, path.provider);

    /** Upstream library id picked in the remote picker. Never shown to the operator. */
    // svelte-ignore state_referenced_locally
    let remoteLibraryId = $state(isEdit ? (path?.providerPath ?? '') : '');
    /** Name of the picked library, for the confirmation line. */
    let remoteLibraryName = $state('');

    /**
     * Switch source. Setting `provider` is what flips `isRemote`; the media type is
     * forced to what the source ingests because a remote source has exactly one
     * (an AudiobookShelf book library is not a movie library), and leaving the
     * previous selection would fail `validateGroupConsistency` server-side with a
     * message about groups rather than about the source.
     */
    function selectSource(next: string): void {
        const descriptor = getRemoteLibrarySourceDescriptor(next);
        remoteLibraryId = '';
        remoteLibraryName = '';
        if (descriptor) {
            provider = descriptor.provider;
            mediaType = descriptor.mediaType;
            language = '';
        } else {
            // Back to filesystem. Reset BOTH, symmetrically with the branch above:
            // resetting only the provider leaves the reappearing Media Type select
            // pinned to the remote source's type ("Audiobook") for a filesystem
            // library, which is a silently wrong default rather than a visible one.
            provider = 'tmdb';
            mediaType = defaultMediaType;
            language = defaultLanguage;
        }
    }

    function handleRemoteSelect(
        selection:
            { id: string; library: { name: string; path: string } } | { id: ''; library: null },
    ): void {
        remoteLibraryId = selection.id;
        remoteLibraryName = selection.library?.name ?? '';
    }

    const selectedGroup = $derived(groups.find((g) => g.id === groupId));
    /** True while the form's type still matches the chosen group's paths. */
    const followsGroup = $derived(
        selectedGroup?.mediaType !== undefined && selectedGroup.mediaType === mediaType,
    );

    /**
     * Picking a group brings its paths' media type, provider and language
     * along. Every path in a group must share one media type (the server's
     * `validateGroupConsistency`), so leaving "Movie · TMDB" preselected after
     * choosing a Music group only set up a save-time rejection — or, worse, a
     * library whose new folder was matched against the wrong provider.
     * An empty group carries nothing, and the form is left as it is.
     */
    function selectGroup(nextId: string): void {
        groupId = nextId;
        const g = groups.find((x) => x.id === nextId);
        if (!g?.mediaType || !g.provider) return;
        const groupIsRemote = getRemoteLibrarySourceDescriptor(g.provider) !== undefined;
        if (!isEdit && groupIsRemote !== isRemote) {
            selectSource(groupIsRemote ? g.provider : 'filesystem');
        }
        // A remote source's type and provider are fixed by selectSource above;
        // an existing row cannot change source, so never repoint it here.
        if (!groupIsRemote && !isRemote) {
            mediaType = g.mediaType;
            provider = g.provider;
            fallbackProviders = [...(g.fallbackProviders ?? [])];
        }
        if (!isEdit && !groupIsRemote && g.language) language = g.language;
    }

    async function handleSave(): Promise<void> {
        if (saving) return;
        // A remote library has no path to require — its `library_paths.path` is a
        // sentinel the SERVER derives from the picked library id.
        if (!isRemote && !pathValue.trim()) {
            toasts.error(m.admin_library_path_required());
            return;
        }
        // Create-only. In edit mode there IS no picker on screen (the upstream
        // library is shown read-only), so requiring a selection made a legacy row
        // with a NULL `provider_path` impossible to edit at all: the operator got
        // "Select a … library" with nothing to select, and could not even change
        // its language.
        if (!isEdit && isRemote && !remoteLibraryId) {
            toasts.error(m.admin_library_path_remote_required());
            return;
        }
        if (!groupId) {
            toasts.error(m.admin_library_path_group_required());
            return;
        }
        saving = true;
        try {
            if (isRemote) {
                // Skips validateLibraryPath entirely: `stat()` on `abs://<uuid>`
                // can only ever fail. The equivalent check — "does the remote
                // server actually have this library?" — runs server-side against
                // the live library list, and the picker only offers ids that came
                // from that same list.
                const remoteBody: LibraryPathCreateBody = {
                    media_type: mediaType,
                    language: language.trim(),
                    provider,
                    // Create only. The PATCH schema has no `remote_library_id` and
                    // would silently strip it — sending a field the server discards
                    // is exactly the "caller believed it mattered" hazard the
                    // create-side refinement rejects, so don't do it here either.
                    ...(isEdit ? {} : { remote_library_id: remoteLibraryId }),
                    library_group_id: groupId,
                    // Not applicable to a remote source, but required by the body
                    // type. Explicit rather than omitted so a schema change that
                    // makes one meaningful surfaces here as a type error.
                    fallback_providers: [],
                    scan_chapters: false,
                };

                const remoteResult = isEdit
                    ? await patchLibraryPath(
                          requireValue(path, 'path must exist in edit mode').id,
                          remoteBody,
                      )
                    : await createLibraryPath(remoteBody);

                if (remoteResult.error) {
                    toasts.error(
                        remoteResult.error ||
                            (isEdit
                                ? m.admin_library_path_remote_update_failed()
                                : m.admin_library_path_remote_add_failed()),
                    );
                } else {
                    toasts.success(
                        isEdit
                            ? m.admin_library_detail_settings_saved()
                            : m.admin_library_path_remote_added({
                                  name: remoteLibraryName || m.admin_library_path_library(),
                              }),
                    );
                    await modals.close();
                    onSaved(
                        isEdit ? 'updated' : 'created',
                        remoteResult.data
                            ? { path: remoteResult.data.path as unknown as LibraryPath }
                            : undefined,
                    );
                }
                return;
            }

            // Validate the folder server-side BEFORE saving — the scanner runs in
            // the container so it sees exactly the filesystem that will be scanned.
            // A wrong/unmounted/unreadable path must block; an empty folder only warns.
            const trimmedPath = pathValue.trim();
            // An edit that keeps the folder (language, edition label, …) is
            // not re-validated: a temporarily unmounted share must not block
            // unrelated settings.
            const pathChanged = !isEdit || trimmedPath !== path?.path;
            const validation = pathChanged
                ? await validateLibraryPath(trimmedPath)
                : { data: null, error: null };
            const v = validation.data;
            if (pathChanged && !v) {
                // The check itself failed: don't block, but say so.
                toasts.warning(
                    m.admin_library_folder_check_failed({
                        folder: trimmedPath,
                        error: validation.error ?? '',
                    }),
                );
            }
            if (v) {
                if (!v.exists) {
                    toasts.error(m.admin_library_path_not_found({ folder: trimmedPath }));
                    return;
                }
                if (!v.isDirectory) {
                    toasts.error(m.admin_library_path_is_file({ folder: trimmedPath }));
                    return;
                }
                if (!v.readable) {
                    toasts.error(m.admin_library_path_unreadable({ folder: trimmedPath }));
                    return;
                }
                if (v.isEmpty) {
                    toasts.warning(m.admin_library_path_empty({ folder: trimmedPath }));
                }
            }

            const body: LibraryPathCreateBody = {
                path: pathValue.trim(),
                media_type: mediaType,
                // Omission lets the server use the effective TMDB language.
                language: isEdit ? language || 'en' : language.trim() || undefined,
                provider,
                provider_path: providerPath.trim() || null,
                edition_label: editionLabel.trim() || null,
                scan_chapters: scanChapters,
                fallback_providers: cleanedFallbackProviders,
                library_group_id: groupId,
            };

            const result = isEdit
                ? await patchLibraryPath(
                      requireValue(path, 'path must exist in edit mode').id,
                      body,
                  )
                : await createLibraryPath(body);

            if (result.error) {
                toasts.error(
                    result.error ||
                        (isEdit
                            ? m.admin_library_path_update_failed()
                            : m.admin_library_path_add_failed()),
                );
            } else {
                toasts.success(
                    isEdit ? m.admin_library_path_updated() : m.admin_library_path_added(),
                );
                await modals.close();
                onSaved(
                    isEdit ? 'updated' : 'created',
                    result.data ? { path: result.data.path as unknown as LibraryPath } : undefined,
                );
            }
        } catch (e) {
            toasts.error(
                getErrorMessage(
                    e,
                    isEdit
                        ? m.admin_library_path_update_failed()
                        : m.admin_library_path_add_failed(),
                ),
            );
        } finally {
            saving = false;
        }
    }

    async function handleClose(): Promise<void> {
        await modals.close();
    }
</script>

<div class="card card-glass p-6 w-full max-w-2xl shadow-xl">
    <header class="flex items-center justify-between mb-5">
        <h2 class="text-xl font-semibold text-white">
            {isEdit ? m.admin_library_path_edit() : m.admin_library_path_add()}
        </h2>
        <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            onclick={handleClose}
            aria-label={m.close()}>
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </header>

    <div class="space-y-4 max-h-[calc(100dvh-14rem)] overflow-y-auto pr-1">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <!-- Source (full width) — filesystem folder vs a remote media server.
                 Only offered on create: changing an existing library's source would
                 mean rewriting its `path` identity, which is what the row is keyed
                 on end to end. -->
            {#if !isEdit}
                <div class="sm:col-span-2">
                    <label class="block text-sm text-surface-400 mb-1" for="lp-source">
                        {m.admin_library_path_source()}
                    </label>
                    <select
                        id="lp-source"
                        class="input w-full"
                        value={remoteDescriptor?.provider ?? 'filesystem'}
                        onchange={(e) =>
                            selectSource((e.currentTarget as HTMLSelectElement).value)}>
                        <option value="filesystem">{m.admin_library_path_filesystem()}</option>
                        {#each REMOTE_LIBRARY_SOURCE_DESCRIPTORS as d (d.provider)}
                            <option value={d.provider}>{d.label}</option>
                        {/each}
                    </select>
                </div>
            {/if}

            {#if isRemote}
                <!-- Remote library picker. The operator picks a real library name;
                     the upstream id and the `abs://<id>` sentinel never surface. -->
                <div class="sm:col-span-2">
                    <label class="block text-sm text-surface-400 mb-1" for="lp-remote-library">
                        {m.admin_library_path_remote_library({
                            source: remoteDescriptor?.label ?? '',
                        })} <span class="text-red-400">*</span>
                    </label>
                    {#if isEdit}
                        {#if existingRemoteName}
                            <p class="text-sm text-surface-200">{existingRemoteName}</p>
                        {:else}
                            <p class="text-sm text-surface-300 font-mono">
                                {path?.providerPath ?? '—'}
                            </p>
                        {/if}
                        <p class="text-xs text-surface-500 mt-1">
                            {m.admin_library_path_remote_fixed()}
                        </p>
                    {:else if remoteDescriptor}
                        <RemoteLibraryPicker
                            provider={remoteDescriptor.provider}
                            selectedId={remoteLibraryId}
                            onSelect={handleRemoteSelect} />
                    {/if}
                </div>
            {:else}
                <!-- Path (full width) -->
                <div class="sm:col-span-2">
                    <label class="block text-sm text-surface-400 mb-1" for="lp-path">
                        {m.admin_library_path_folder()} <span class="text-red-400">*</span>
                    </label>
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            id="lp-path"
                            type="text"
                            class="input flex-1 min-w-0 font-mono"
                            placeholder="/mnt/media/movies"
                            bind:value={pathValue} />
                        <LibraryFolderPicker
                            id="lp-path-picker"
                            onSelect={(picked) => (pathValue = picked)} />
                    </div>
                </div>
            {/if}

            <!-- Library -->
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="lp-group">
                    {m.admin_library_path_library()} <span class="text-red-400">*</span>
                </label>
                <select
                    id="lp-group"
                    class="input w-full"
                    value={groupId}
                    onchange={(e) => selectGroup(e.currentTarget.value)}
                    required>
                    <option value="" disabled>{m.admin_library_path_select_library()}</option>
                    {#each groups as g (g.id)}
                        <option value={g.id}>
                            {g.icon ? `${g.icon} ` : ''}{g.name}
                        </option>
                    {/each}
                </select>
                {#if groups.length === 0}
                    <p class="text-xs text-amber-400 mt-1">
                        {m.admin_library_path_create_library_first()}
                    </p>
                {/if}
            </div>

            <!-- Media Type. Fixed for a remote source: it ingests exactly one kind,
                 so offering the full list would only let the operator pick a value
                 that fails group-consistency validation later. -->
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="lp-media-type">
                    {m.admin_library_path_media_type()}
                </label>
                {#if isRemote}
                    <p class="input w-full flex items-center text-surface-300">
                        {m.media_audiobook()}
                    </p>
                    <p class="text-xs text-surface-500 mt-1">
                        {m.admin_library_path_source_sets_type({
                            source: remoteDescriptor?.label ?? '',
                        })}
                    </p>
                {:else}
                    <select id="lp-media-type" class="input w-full" bind:value={mediaType}>
                        <option value="movie">{m.media_movie()}</option>
                        <option value="tv">{m.admin_library_type_series()}</option>
                        <option value="anime">{m.media_plain_anime()}</option>
                        <option value="music">{m.media_music()}</option>
                        {#if isExistingLocalAudiobook}
                            <option value="audiobook">{m.media_audiobook()}</option>
                        {/if}
                        <option value="home_video">{m.media_plain_home_videos()}</option>
                        <option value="training">{m.media_plain_type_training()}</option>
                        <option value="educational">{m.media_plain_type_educational()}</option>
                        <option value="personal">{m.media_plain_type_personal()}</option>
                    </select>
                    {#if followsGroup && selectedGroup}
                        <p class="text-xs text-surface-500 mt-1">
                            {m.admin_library_type_follows_group({ name: selectedGroup.name })}
                        </p>
                    {/if}
                    {#if isExistingLocalAudiobook && mediaType === 'audiobook'}
                        <p class="text-xs text-amber-400 mt-1" data-testid="local-audiobook-notice">
                            {m.admin_library_local_audiobook_notice()}
                        </p>
                    {:else if !isEdit}
                        <p class="text-xs text-surface-500 mt-1">
                            {m.admin_library_audiobooks_from_abs()}
                        </p>
                    {/if}
                {/if}
            </div>

            <!-- Metadata Provider (hidden for non-entertainment AND for remote
                 sources — a remote source IS the metadata provider; showing the
                 select would let the operator overwrite `provider` and orphan the
                 library from its connector). -->
            {#if !isRemote && !isNonEntertainment(mediaType)}
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lp-provider">
                        {m.admin_library_path_metadata_provider()}
                    </label>
                    <select id="lp-provider" class="input w-full" bind:value={provider}>
                        <option value="tmdb">TMDB</option>
                        <option value="jellyfin">Jellyfin</option>
                        <option value="anidb">AniDB</option>
                        <option value="tvdb">TheTVDB</option>
                        <option value="musicbrainz">MusicBrainz</option>
                        <!-- No `audiobookshelf` option here any more. It used to be
                             offered when already set, purely so the select would not
                             render blank and silently rewrite the provider on save.
                             Remote providers now take the "Source" selector above and
                             this whole block is hidden for them, so the blank-select
                             hazard is gone with it. -->
                    </select>
                </div>

                <!-- Fallback Providers -->
                <div class="sm:col-span-2">
                    <p class="block text-sm text-surface-400 mb-1">
                        {m.admin_library_path_fallback()}
                        <span class="text-surface-500 text-xs font-normal ml-1"
                            >{m.admin_library_path_optional()}</span>
                    </p>
                    <p class="text-xs text-surface-500 mb-2">
                        {m.admin_library_path_fallback_hint()}
                    </p>
                    <div class="flex flex-wrap gap-3">
                        {#each ['tmdb', 'anidb', 'jellyfin'] as const as fp (fp)}
                            {#if fp !== provider}
                                <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                                    <input
                                        type="checkbox"
                                        class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/30"
                                        checked={fallbackProviders.includes(fp)}
                                        onchange={(e) => {
                                            if ((e.target as HTMLInputElement).checked) {
                                                fallbackProviders = [...fallbackProviders, fp];
                                            } else {
                                                fallbackProviders = fallbackProviders.filter(
                                                    (p) => p !== fp,
                                                );
                                            }
                                        }} />
                                    <span class="text-surface-300">{fp.toUpperCase()}</span>
                                </label>
                            {/if}
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Language -->
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="lp-language">
                    {m.modal_language()}
                </label>
                <input
                    id="lp-language"
                    type="text"
                    class="input w-full"
                    placeholder={!isEdit && !isRemote ? m.modal_language_default() : 'en'}
                    bind:value={language} />
                <p class="text-xs text-surface-500 mt-1">
                    {m.route_admin_library_lang_help_prefix()}<a
                        href="{resolve(
                            '/admin/settings/providers',
                        )}?section=metadata&highlight=METADATA_ADDITIONAL_LANGUAGES"
                        class="underline hover:text-white"
                        onclick={() => void modals.close()}
                        >{m.route_admin_library_lang_help_link()}</a
                    >{m.route_admin_library_lang_help_suffix()}
                </p>
                {#if isRemote}
                    <!-- Language is the whole reason a remote source still needs a
                         form. It is NOT inferable from the upstream library name:
                         one server suffixes " - Englisch", another uses EN/DE, or
                         Japanese, or splits nothing at all. -->
                    <p class="text-xs text-amber-400/90 mt-1">
                        {m.library_abs_language_hint()}
                    </p>
                {/if}
            </div>

            <!-- Filesystem-only fields. Every one of these describes a file on disk
                 (an edition tag applied to filenames, ffmpeg chapter extraction, a
                 path translation for a media server) and none has any meaning for a
                 library that Lumastra never reads files from. `provider_path` is
                 especially important to hide: for a remote source it carries the
                 upstream library id and is derived server-side, so a free-text box
                 here would let an operator silently repoint the library. -->
            {#if !isRemote}
                <!-- Edition Label -->
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lp-edition">
                        {m.admin_library_path_edition()}
                        <span class="text-surface-500 text-xs font-normal ml-1"
                            >{m.admin_library_path_optional()}</span>
                    </label>
                    <input
                        id="lp-edition"
                        type="text"
                        class="input w-full"
                        placeholder={m.admin_library_path_edition_placeholder()}
                        bind:value={editionLabel} />
                    <p class="text-xs text-surface-500 mt-1">
                        {m.admin_library_path_edition_hint()}
                    </p>
                </div>

                <!-- Extract chapters toggle (full width) -->
                <div class="sm:col-span-2">
                    <label class="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={scanChapters}
                            class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/30" />
                        <span class="text-surface-300">{m.admin_library_path_chapters()}</span>
                        <span class="text-xs text-surface-500">
                            {m.admin_library_path_chapters_hint()}
                        </span>
                    </label>
                </div>

                <!-- Provider Path (full width) -->
                <div class="sm:col-span-2">
                    <label class="block text-sm text-surface-400 mb-1" for="lp-provider-path">
                        {m.admin_library_path_server_path()}
                        <span class="text-surface-500 text-xs font-normal ml-1"
                            >{m.admin_library_path_optional()}</span>
                    </label>
                    <input
                        id="lp-provider-path"
                        type="text"
                        class="input w-full font-mono"
                        placeholder="/data/movies"
                        bind:value={providerPath} />
                    <p class="text-xs text-surface-500 mt-1">
                        {m.admin_library_path_server_path_hint()}
                    </p>
                </div>
            {/if}
        </div>
    </div>

    <footer class="flex justify-end gap-3 mt-5 pt-4 border-t border-surface-700">
        <button type="button" class="btn btn-ghost" onclick={handleClose} disabled={saving}>
            {m.cancel()}
        </button>
        <button
            type="button"
            class="btn btn-blue"
            onclick={() => void handleSave()}
            disabled={saving}>
            {saving
                ? m.admin_library_path_saving()
                : isEdit
                  ? m.admin_library_path_save()
                  : m.admin_library_path_add()}
        </button>
    </footer>
</div>
