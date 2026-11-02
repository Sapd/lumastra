<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { createLibrary, validateLibraryPath, triggerFileScanner } from '$lib/api/admin';
    import { Icon, XMark, Plus, Trash, FolderPlus } from 'svelte-hero-icons';
    import { appName } from '$lib/stores/appConfig';
    import * as m from '$lib/paraglide/messages';
    import LibraryFolderPicker from './library/LibraryFolderPicker.svelte';
    import { resolve } from '$lib/paths';

    type MediaType =
        'movie' | 'tv' | 'anime' | 'music' | 'home_video' | 'training' | 'educational' | 'personal';

    interface Props {
        /** Called after a library is created so the page can reload groups + paths. */
        onSaved: () => void;
        /**
         * Escape hatch to an empty library (group without folders) — the route
         * for remote sources such as AudiobookShelf, which this wizard does not
         * cover, and for adding folders one at a time with per-folder options.
         */
        onCreateEmpty?: () => void;
    }

    let { onSaved, onCreateEmpty }: Props = $props();

    const PROVIDER_LABELS = { tmdb: 'TMDB', musicbrainz: 'MusicBrainz' } as const;

    // No Audiobooks: this wizard only creates folder libraries, and the scanner
    // imports audio files only in music libraries, so a folder of audiobooks
    // would import nothing. Audiobooks come from AudiobookShelf (empty library +
    // AudiobookShelf source); the server refuses the combination as well.
    const MEDIA_TYPES: { value: MediaType; label: string; icon: string }[] = [
        { value: 'movie', label: 'Movies', icon: '🎬' },
        { value: 'tv', label: 'TV Shows', icon: '📺' },
        { value: 'anime', label: 'Anime', icon: '🌸' },
        { value: 'music', label: 'Music', icon: '🎵' },
        { value: 'home_video', label: 'Home Videos', icon: '📹' },
        { value: 'training', label: 'Training', icon: '🏋️' },
        { value: 'educational', label: 'Educational', icon: '🎓' },
        { value: 'personal', label: 'Personal', icon: '📁' },
    ];

    let name = $state('');
    let mediaType = $state<MediaType>('movie');
    let paths = $state<{ value: string }[]>([{ value: '' }]);
    let saving = $state(false);

    // Suggest a name from the chosen media type until the user types their own.
    let nameTouched = $state(false);
    const suggestedName = $derived(MEDIA_TYPES.find((m) => m.value === mediaType)?.label ?? '');
    const effectiveName = $derived(nameTouched ? name : name || suggestedName);

    // Pick a sensible default provider for the media type. Music uses
    // MusicBrainz; everything else uses TMDB. Advanced per-path tuning is
    // available later via the path editor.
    const provider = $derived<'tmdb' | 'musicbrainz'>(
        mediaType === 'music' ? 'musicbrainz' : 'tmdb',
    );

    const trimmedPaths = $derived(paths.map((p) => p.value.trim()).filter((p) => p.length > 0));
    const hasDuplicatePaths = $derived(new Set(trimmedPaths).size !== trimmedPaths.length);
    const canSubmit = $derived(
        effectiveName.trim().length > 0 && trimmedPaths.length > 0 && !hasDuplicatePaths && !saving,
    );

    function addPath(): void {
        paths.push({ value: '' });
    }

    function removePath(index: number): void {
        paths.splice(index, 1);
        if (paths.length === 0) paths.push({ value: '' });
    }

    async function handleCreate(): Promise<void> {
        if (saving) return;
        const finalName = effectiveName.trim();
        if (!finalName) {
            toasts.error('Library name is required');
            return;
        }
        if (trimmedPaths.length === 0) {
            toasts.error('Add at least one folder path');
            return;
        }
        if (hasDuplicatePaths) {
            toasts.error('Remove duplicate folder paths');
            return;
        }

        saving = true;
        try {
            // Validate each folder server-side BEFORE saving — it runs in the
            // container, so it sees exactly the filesystem the scanner will. A
            // wrong/unmounted/unreadable path must block (it would save fine then
            // scan nothing); an empty readable folder only warns.
            const checks = await Promise.all(trimmedPaths.map((p) => validateLibraryPath(p)));
            for (let i = 0; i < checks.length; i++) {
                const v = checks[i].data;
                const folder = trimmedPaths[i];
                if (!v) {
                    // The check itself failed (timeout, server error): don't
                    // block the save on that, but don't pretend it passed.
                    toasts.warning(
                        m.admin_library_folder_check_failed({
                            folder,
                            error: checks[i].error ?? '',
                        }),
                    );
                    continue;
                }
                if (!v.exists) {
                    toasts.error(
                        `Folder "${folder}" was not found. Check the path and that it's mounted into the container.`,
                    );
                    return;
                }
                if (!v.isDirectory) {
                    toasts.error(`"${folder}" is a file, not a folder.`);
                    return;
                }
                if (!v.readable) {
                    toasts.error(
                        `Folder "${folder}" is not readable by ${$appName || 'the server'} — check the container user's permissions.`,
                    );
                    return;
                }
                if (v.isEmpty) {
                    toasts.warning(
                        `Folder "${folder}" is empty — it will scan but find nothing until you add media.`,
                    );
                }
            }

            const result = await createLibrary({
                name: finalName,
                media_type: mediaType,
                paths: trimmedPaths.map((p) => ({ path: p, provider })),
            });

            if (result.error) {
                toasts.error(result.error || 'Failed to create library');
            } else {
                const count = result.data?.paths.length ?? trimmedPaths.length;
                // Kick an immediate scan of the new paths. The file watcher uses
                // ignoreInitial, so files already on disk won't trigger events —
                // without this, ingestion waits for the periodic pass and the
                // operator sees "nothing happened".
                const newPathIds = (result.data?.paths ?? [])
                    .map((p) => p.id)
                    .filter((id): id is string => !!id);
                // Never fall back to `{}`: that is the scan-EVERY-library call.
                let scanError: string | null = newPathIds.length ? null : '';
                if (newPathIds.length) {
                    try {
                        // The API client resolves with `{ error }` rather than
                        // throwing, so the result has to be checked.
                        const scanResult = await triggerFileScanner({ paths: newPathIds });
                        scanError = scanResult.error;
                    } catch (e) {
                        scanError = getErrorMessage(e, '');
                    }
                }
                if (scanError === null) {
                    toasts.success(
                        `Created "${finalName}" with ${count} folder${count === 1 ? '' : 's'} — scanning now…`,
                    );
                } else {
                    // Non-fatal — the periodic scan will still pick it up.
                    toasts.warning(
                        m.admin_library_created_scan_not_started({
                            name: finalName,
                            error: scanError,
                        }),
                    );
                }
                await modals.close();
                onSaved();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to create library'));
        } finally {
            saving = false;
        }
    }

    async function handleClose(): Promise<void> {
        await modals.close();
    }
</script>

<div class="card card-glass p-6 w-full max-w-2xl shadow-xl">
    <header class="flex items-center justify-between mb-2">
        <h2 class="text-xl font-semibold text-white">Create a library</h2>
        <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            onclick={handleClose}
            aria-label="Close">
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </header>
    <p class="text-sm text-muted mb-5">
        A library groups one or more folders of the same media type. {$appName || 'The server'} scans
        these folders and matches their contents to metadata.
    </p>

    <div class="space-y-5 max-h-[65vh] overflow-y-auto pr-1">
        <!-- Media type -->
        <div>
            <span class="block text-sm text-surface-400 mb-2">Media type</span>
            <div class="grid grid-cols-3 gap-2 sm:grid-cols-3">
                {#each MEDIA_TYPES as mt (mt.value)}
                    <button
                        type="button"
                        class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left transition-colors {mediaType ===
                        mt.value
                            ? 'border-blue-500 bg-blue-500/10 text-white'
                            : 'border-surface-700 bg-surface-800 text-surface-300 hover:bg-surface-750'}"
                        onclick={() => (mediaType = mt.value)}
                        aria-pressed={mediaType === mt.value}>
                        <span aria-hidden="true">{mt.icon}</span>
                        <span>{mt.label}</span>
                    </button>
                {/each}
            </div>
            <p class="text-xs text-surface-500 mt-2" data-testid="wizard-audiobooks-hint">
                {m.admin_library_audiobooks_from_abs()}
                <a
                    href={resolve('/admin/settings/audiobookshelf')}
                    class="underline hover:text-white"
                    onclick={() => void modals.close()}>{m.admin_library_audiobooks_abs_link()}</a>
            </p>
        </div>

        <!-- Name -->
        <div>
            <label class="block text-sm text-surface-400 mb-1" for="lib-name">
                Library name <span class="text-red-400">*</span>
            </label>
            <input
                id="lib-name"
                type="text"
                class="input w-full"
                placeholder={suggestedName}
                value={effectiveName}
                oninput={(e) => {
                    nameTouched = true;
                    name = e.currentTarget.value;
                }} />
        </div>

        <!-- Folders -->
        <div>
            <span class="block text-sm text-surface-400 mb-1">
                Folders <span class="text-red-400">*</span>
            </span>
            <div class="space-y-2">
                {#each paths as p, i (i)}
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            type="text"
                            class="input flex-1 min-w-0 font-mono"
                            placeholder="/mnt/media/movies"
                            bind:value={p.value} />
                        <LibraryFolderPicker
                            id="wizard-path-{i}-picker"
                            onSelect={(picked) => (p.value = picked)} />
                        <button
                            type="button"
                            class="btn btn-ghost btn-sm btn-square shrink-0"
                            onclick={() => removePath(i)}
                            aria-label="Remove folder">
                            <Icon src={Trash} class="w-4 h-4" />
                        </button>
                    </div>
                {/each}
            </div>
            <button type="button" class="btn btn-ghost btn-sm mt-2" onclick={addPath}>
                <Icon src={Plus} class="w-4 h-4" />
                Add another folder
            </button>
            {#if hasDuplicatePaths}
                <p class="text-xs text-amber-400 mt-2">
                    Duplicate folder paths — each folder must be unique.
                </p>
            {/if}
        </div>

        <p class="text-xs text-muted">
            Using the <span class="font-medium">{PROVIDER_LABELS[provider]}</span> metadata provider.
            You can change providers and other per-folder options later from the library settings.
        </p>
    </div>

    <footer class="flex flex-wrap items-center justify-end gap-2 mt-6">
        {#if onCreateEmpty}
            <p class="mr-auto text-xs text-muted">
                {m.admin_library_wizard_empty_hint()}
                <button
                    type="button"
                    class="underline hover:text-white"
                    onclick={async () => {
                        await modals.close();
                        onCreateEmpty?.();
                    }}>{m.admin_library_wizard_empty_link()}</button>
            </p>
        {/if}
        <button type="button" class="btn btn-ghost btn-sm" onclick={handleClose}> Cancel </button>
        <button
            type="button"
            class="btn btn-blue btn-sm"
            disabled={!canSubmit}
            onclick={handleCreate}>
            <Icon src={FolderPlus} class="w-4 h-4" />
            {saving ? 'Creating…' : 'Create library'}
        </button>
    </footer>
</div>
