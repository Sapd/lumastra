<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One library: header, folders, settings, scan history, danger zone.

  The folder-picker integration in "Add folder" is a
  later step — see the placeholder comment below for where it lands.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { SvelteMap } from 'svelte/reactivity';
    import {
        Icon,
        ArrowLeft,
        ArrowPath,
        ArrowTopRightOnSquare,
        ExclamationTriangle,
        Pencil,
        Plus,
        Trash,
        XMark,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        getLibraryGroups,
        getLibraryPaths,
        updateLibrary,
        deleteLibraryGroup,
        patchLibraryPath,
        deleteLibraryPath,
        getRemoteLibraries,
        getLibraryGroupPermissions,
        getAvailableGroups,
        getLatestScannerRunPerLibrary,
    } from '$lib/api/admin';
    import {
        groupScanIssues,
        relativeToLibraryFolder,
        SCAN_ISSUE_SAMPLE_LIMIT,
        type ScanIssueCause,
        type ScanIssuesSummary,
    } from '$lib/components/admin/library/scan-issues';
    import type { LibraryUpdateBody } from '$lib/schemas/admin.js';
    import type { LibraryGroupData, LibraryPath } from '$lib/schemas/api-admin-library-responses';
    import { isNonEntertainment } from '$lib/shared/media-types';
    import LibraryPathModal from '$lib/components/admin/LibraryPathModal.svelte';
    import LibraryAccessEditor from '$lib/components/admin/library/LibraryAccessEditor.svelte';
    import ScannerRunHistory from '$lib/components/admin/library/ScannerRunHistory.svelte';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import {
        mediaTypeLabel,
        providerLabel,
        isRemoteProvider,
    } from '$lib/components/admin/library/library-labels';
    import { LibraryScanController } from '$lib/components/admin/library/library-scan-state.svelte';
    import {
        getRemoteLibrarySourceDescriptor,
        isLocalAudiobookLibrary,
    } from '$lib/shared/remote-library-sources';
    import type { PageData } from './$types';

    import * as m from '$lib/paraglide/messages.js';

    let { data }: { data: PageData } = $props();
    // The route id never changes for a mounted instance of this page — a
    // navigation between two libraries remounts the component.
    // svelte-ignore state_referenced_locally
    const libraryId = data.id;

    // -------------------------------------------------------------------------
    // Data loading
    // -------------------------------------------------------------------------

    let libraryGroups = $state<LibraryGroupData[]>([]);
    let paths = $state<LibraryPath[]>([]);
    let groupsLoaded = $state(false);
    let pathsLoaded = $state(false);
    /** A failed load is not "this library does not exist" — show a retry, not not-found. */
    let loadFailed = $state(false);
    let loading = $derived(!groupsLoaded || !pathsLoaded);

    const library = $derived(libraryGroups.find((g) => g.id === libraryId));
    /** True only once loading finished and no group matched — not while still loading. */
    const notFound = $derived(!loading && !loadFailed && !library);
    const folders = $derived(paths.filter((p) => p.libraryGroupId === libraryId));
    const isRemoteLibrary = $derived(folders.some((p) => isRemoteProvider(p.provider)));
    const currentMediaType = $derived(folders[0]?.mediaType);
    const currentProvider = $derived(folders[0]?.provider);
    const currentFallbackProviders = $derived(folders[0]?.fallbackProviders ?? []);
    /**
     * A folder library typed Audiobook, created before the API refused that
     * combination. It imports nothing (audio is imported only in music
     * libraries; audiobooks come from AudiobookShelf). Kept editable, with a
     * notice, rather than broken.
     */
    const isLocalAudiobook = $derived(
        folders.some((p) => isLocalAudiobookLibrary(p.mediaType, p.provider)),
    );

    /** Header subtitle: type · item count (when known) · folder count. */
    const headerDescription = $derived.by((): string => {
        const parts: string[] = [];
        if (currentMediaType) parts.push(mediaTypeLabel(currentMediaType));
        if (library?.itemCount != null) {
            parts.push(m.admin_library_item_count({ count: library.itemCount }));
        }
        parts.push(m.admin_library_detail_folder_count({ count: folders.length }));
        return parts.join(' · ');
    });

    async function loadGroups(): Promise<void> {
        try {
            const { data, error } = await getLibraryGroups();
            if (error) {
                toasts.error(error);
                if (libraryGroups.length === 0) loadFailed = true;
            } else if (data) libraryGroups = data.items;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_err_load_groups()));
            if (libraryGroups.length === 0) loadFailed = true;
        } finally {
            groupsLoaded = true;
        }
    }

    async function loadPaths(): Promise<void> {
        try {
            const { data, error } = await getLibraryPaths();
            if (error) {
                toasts.error(m.admin_toast_failed_to_load_library_paths());
                // Without the folder list, "no folders" (which unlocks Delete)
                // cannot be told apart from "folders not loaded".
                if (paths.length === 0) loadFailed = true;
            } else if (data) paths = data.items;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_toast_failed_to_load_library_paths()));
            if (paths.length === 0) loadFailed = true;
        } finally {
            pathsLoaded = true;
        }
    }

    /** `abs://<uuid>` → the upstream server's own name for that library (see the overview page). */
    const remoteLibraryNames = new SvelteMap<string, string>();
    const remoteNamesRequested: Record<string, boolean> = {};

    async function loadRemoteLibraryNames(provider: string): Promise<void> {
        try {
            const { data } = await getRemoteLibraries(provider);
            if (data?.status !== 'ok') return;
            for (const lib of data.libraries ?? []) remoteLibraryNames.set(lib.path, lib.name);
        } catch {
            /* expected: non-critical — rows fall back to the raw path */
        }
    }

    $effect(() => {
        for (const p of folders) {
            if (!isRemoteProvider(p.provider) || remoteNamesRequested[p.provider]) continue;
            remoteNamesRequested[p.provider] = true;
            void loadRemoteLibraryNames(p.provider);
        }
    });

    // -------------------------------------------------------------------------
    // Access (allowed Authentik groups)
    // -------------------------------------------------------------------------

    // `accessDraft` is part of the Settings form; `initialAccess` is what the
    // server holds. null = not loaded yet — access then never enters the save
    // body, so a failed or pending load can't overwrite it with [].
    let accessDraft = $state<string[]>([]);
    let initialAccess = $state<string[] | null>(null);
    let availableGroups = $state<string[]>([]);
    let permissionsLoadError = $state<string | null>(null);

    async function loadPermissions(): Promise<void> {
        permissionsLoadError = null;
        try {
            const [permResult, groupsResult] = await Promise.all([
                getLibraryGroupPermissions(),
                getAvailableGroups(),
            ]);
            if (permResult.validationError ?? permResult.error) {
                permissionsLoadError = permResult.error ?? m.admin_library_err_load_permissions();
            } else if (permResult.data) {
                const match = permResult.data.permissions.find(
                    (p) => p.libraryGroupId === libraryId,
                );
                initialAccess = [...(match?.allowedGroups ?? [])];
                accessDraft = [...initialAccess];
            }
            if (!groupsResult.error && groupsResult.data) {
                availableGroups = groupsResult.data.groups;
            }
        } catch (err) {
            permissionsLoadError =
                err instanceof Error ? err.message : m.admin_library_err_load_permissions();
        }
    }

    // -------------------------------------------------------------------------
    // Issues — the latest completed runs' error samples, grouped by cause.
    // -------------------------------------------------------------------------

    let scanIssues = $state<ScanIssuesSummary | null>(null);
    let expandedCauses = $state<Partial<Record<ScanIssueCause, boolean>>>({});

    async function loadScanIssues(): Promise<void> {
        try {
            const { data, error } = await getLatestScannerRunPerLibrary(libraryId);
            // Silent on failure, same as the overview page's health chip — a
            // library whose Issues section briefly can't be read is far less
            // disruptive than a page-level error banner would be.
            if (error || !data) return;
            // Only a completed run's error count is meaningful — an abandoned
            // run carries the -1 sentinel and a running one hasn't finished
            // counting yet (same guard the overview page uses for its "N
            // files need attention" chip).
            const completed = data.items.filter((r) => r.status === 'completed');
            scanIssues = groupScanIssues(completed);
        } catch {
            /* expected: non-critical — see the comment above */
        }
    }

    function toggleCauseExpanded(cause: ScanIssueCause): void {
        expandedCauses[cause] = !expandedCauses[cause];
    }

    const folderPaths = $derived(folders.map((p) => p.path));

    /** Path relative to whichever folder holds it, full path as the title. */
    function issueFileLabel(filePath: string): string {
        return relativeToLibraryFolder(filePath, folderPaths);
    }

    function causeLabel(cause: ScanIssueCause): string {
        switch (cause) {
            case 'non_utf8_filename':
                return m.admin_library_issues_cause_non_utf8();
            case 'control_character_filename':
                return m.admin_library_issues_cause_control_character();
            case 'permission_denied':
                return m.admin_library_issues_cause_permission_denied();
            case 'ffprobe_failure':
                return m.admin_library_issues_cause_ffprobe();
            case 'playlist_container':
                return m.admin_library_issues_cause_playlist_container();
            case 'filesystem_fault':
                return m.admin_library_issues_cause_filesystem_fault();
            case 'legacy_unspecified':
                return m.admin_library_issues_cause_legacy();
            case 'other':
                return m.admin_library_issues_cause_other();
        }
    }

    /** The operator fix sentence — 'other' has none; its raw reason is shown per file instead. */
    function causeFix(cause: ScanIssueCause): string {
        switch (cause) {
            case 'non_utf8_filename':
                return m.admin_library_issues_fix_non_utf8();
            case 'control_character_filename':
                return m.admin_library_issues_fix_control_character();
            case 'permission_denied':
                return m.admin_library_issues_fix_permission_denied();
            case 'ffprobe_failure':
                return m.admin_library_issues_fix_ffprobe();
            case 'playlist_container':
                return m.admin_library_issues_fix_playlist_container();
            case 'filesystem_fault':
                return m.admin_library_issues_fix_filesystem_fault();
            case 'legacy_unspecified':
                return m.admin_library_issues_fix_legacy();
            case 'other':
                return '';
        }
    }

    let scrolledToIssues = $state(false);

    // Scroll to the Issues section once it has rendered, when the overview
    // page's "N files need attention" link brought us here via #issues.
    $effect(() => {
        if (scrolledToIssues || loading || !scanIssues || scanIssues.totalErrors <= 0) return;
        if (page.url.hash !== '#issues') return;
        scrolledToIssues = true;
        document.getElementById('issues')?.scrollIntoView({ block: 'start' });
    });

    onMount(() => {
        void loadGroups();
        void loadPaths();
        void loadPermissions();
        void loadScanIssues();
        void pollScanStatus();
        scan.watch(() => void pollScanStatus());
    });

    /** Set when the page is left; a scan trigger that resolves later must not re-arm polling. */
    let destroyed = false;
    $effect(() => {
        return () => {
            destroyed = true;
            scan.stopPolling();
        };
    });

    // -------------------------------------------------------------------------
    // Scan / Stop (this library only)
    // -------------------------------------------------------------------------

    const scan = new LibraryScanController();

    function scanTarget(): { id: string; name: string; paths: Array<{ id: string }> } {
        return {
            id: libraryId,
            name: library?.name ?? '',
            paths: folders.map((p) => ({ id: p.id })),
        };
    }

    const scanState = $derived(scan.groupScanStates([scanTarget()]).get(libraryId));

    /** Bumped when a scan finishes so the run history re-loads. */
    let historyKey = $state(0);

    async function pollScanStatus(): Promise<void> {
        const justFinished = await scan.poll(() => [scanTarget()]);
        if (justFinished) {
            // Everything a scan changes: folders, item count, issues, history.
            void loadPaths();
            void loadGroups();
            void loadScanIssues();
            historyKey++;
        }
    }

    async function triggerScan(): Promise<void> {
        if (scan.pendingGroupIds.has(libraryId) || scanState) return;
        const { started } = await scan.triggerForGroup(scanTarget());
        if (started && !destroyed) {
            // The poll stops itself when a scan finishes, so a second scan on
            // the same visit must re-arm it or its progress never shows.
            scan.watch(() => void pollScanStatus());
            await pollScanStatus();
        }
    }

    function retryLoad(): void {
        loadFailed = false;
        groupsLoaded = false;
        pathsLoaded = false;
        void loadGroups();
        void loadPaths();
    }

    async function abortScan(): Promise<void> {
        await scan.abortForGroup(scanTarget());
        await pollScanStatus();
    }

    // -------------------------------------------------------------------------
    // Folders
    // -------------------------------------------------------------------------

    /** What a new folder in this library should inherit — mirrors the overview page's `pathModalGroups()`. */
    function folderGroupOption(): {
        id: string;
        name: string;
        icon?: string;
        sortOrder: number;
        mediaType?: LibraryPath['mediaType'];
        provider?: LibraryPath['provider'];
        language?: string;
        fallbackProviders?: LibraryPath['fallbackProviders'];
    } {
        const first = folders[0];
        return {
            id: libraryId,
            name: library?.name ?? '',
            icon: library?.icon,
            sortOrder: library?.sortOrder ?? 0,
            mediaType: first?.mediaType,
            provider: first?.provider,
            language: first?.language,
            fallbackProviders: first?.fallbackProviders,
        };
    }

    function handleFolderSaved(
        action: 'created' | 'updated',
        result?: { path: LibraryPath },
    ): void {
        if (action === 'created' && result?.path) {
            paths = [...paths, result.path];
        } else {
            void loadPaths();
        }
    }

    // Folder picker integration lands here — "Add folder"
    // opens the same modal it does today until then.
    function openAddFolder(): void {
        const opt = folderGroupOption();
        modals.open(LibraryPathModal, {
            groups: [opt],
            defaultGroupId: libraryId,
            defaultMediaType: opt.mediaType,
            defaultProvider: opt.provider,
            defaultLanguage: opt.language,
            onSaved: handleFolderSaved,
        });
    }

    function openEditFolder(lp: LibraryPath): void {
        modals.open(LibraryPathModal, {
            path: lp,
            groups: [folderGroupOption()],
            remoteLibraryName: remoteLibraryNames.get(lp.path),
            onSaved: handleFolderSaved,
        });
    }

    let togglingFolderId = $state<string | null>(null);
    let deletingFolderId = $state<string | null>(null);

    async function toggleFolderEnabled(lp: LibraryPath): Promise<void> {
        togglingFolderId = lp.id;
        try {
            const { error } = await patchLibraryPath(lp.id, { enabled: !lp.enabled });
            if (error) {
                toasts.error(m.admin_toast_failed_to_update_library_path());
            } else {
                paths = paths.map((p) => (p.id === lp.id ? { ...p, enabled: !lp.enabled } : p));
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_toast_failed_to_update_library_path()));
        } finally {
            togglingFolderId = null;
        }
    }

    async function removeFolder(lp: LibraryPath, force: boolean): Promise<void> {
        deletingFolderId = lp.id;
        try {
            const { data, error, code } = await deleteLibraryPath(lp.id, { force });
            if (code === 'conflict' && !force) {
                // A scan of the folder or an upload into it is running: say so
                // and offer to stop it, instead of a bare failure.
                modals.open(ConfirmModal, {
                    title: m.admin_library_folder_busy_title(),
                    body: error ?? '',
                    confirmText: m.admin_library_folder_busy_force(),
                    confirmVariant: 'danger' as const,
                    onConfirm: () => removeFolder(lp, true),
                });
                return;
            }
            if (error || !data) {
                toasts.error(error ?? m.admin_toast_failed_to_delete_library_path());
                return;
            }
            paths = paths.filter((p) => p.id !== lp.id);
            toasts.success(
                data.filesToDetach > 0
                    ? m.admin_library_folder_deleted_detaching({ count: data.filesToDetach })
                    : m.admin_toast_library_path_deleted(),
            );
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_toast_failed_to_delete_library_path()));
        } finally {
            deletingFolderId = null;
        }
    }

    function confirmRemoveFolder(lp: LibraryPath): void {
        modals.open(ConfirmModal, {
            title: m.route_admin_library_delete_path_title(),
            body: m.admin_library_folder_delete_body({ path: lp.path }),
            confirmText: m.delete(),
            confirmVariant: 'danger' as const,
            onConfirm: () => removeFolder(lp, false),
        });
    }

    // -------------------------------------------------------------------------
    // Settings form — one form, one Save, only changed fields sent.
    // -------------------------------------------------------------------------

    type MediaType = NonNullable<LibraryPath['mediaType']>;
    type Provider = NonNullable<LibraryPath['provider']>;
    type FallbackProvider = 'tmdb' | 'anidb' | 'jellyfin';

    interface SettingsSnapshot {
        name: string;
        icon: string;
        description: string;
        mediaType: MediaType;
        provider: Provider;
        fallbackProviders: FallbackProvider[];
        maxAgeRating: number | null;
    }

    let settingsInitialized = $state(false);
    let name = $state('');
    let icon = $state('');
    let description = $state('');
    let mediaType = $state<MediaType>('movie');
    let provider = $state<Provider>('tmdb');
    let fallbackProviders = $state<FallbackProvider[]>([]);
    let maxAgeRating = $state<number | null>(null);
    let initial = $state<SettingsSnapshot | null>(null);
    let savingSettings = $state(false);

    function arraysEqualUnordered(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        const sa = [...a].sort();
        const sb = [...b].sort();
        return sa.every((v, i) => v === sb[i]);
    }

    // Seeds the draft from the loaded library exactly once both fetches have
    // resolved — seeding from `library` alone could fire before `folders`
    // (media type / provider / fallbacks live on the folder rows) arrived.
    function serverSnapshot(lib: LibraryGroupData): SettingsSnapshot {
        return {
            name: lib.name,
            icon: lib.icon ?? '',
            description: lib.description ?? '',
            mediaType: currentMediaType ?? 'movie',
            provider: currentProvider ?? 'tmdb',
            fallbackProviders: [...currentFallbackProviders],
            maxAgeRating: lib.maxAgeRating ?? null,
        };
    }

    function draftSnapshot(): SettingsSnapshot {
        return {
            name,
            icon,
            description,
            mediaType,
            provider,
            fallbackProviders: [...fallbackProviders],
            maxAgeRating,
        };
    }

    $effect(() => {
        if (settingsInitialized || loading || !library) return;
        const snap = serverSnapshot(library);
        name = snap.name;
        icon = snap.icon;
        description = snap.description;
        mediaType = snap.mediaType;
        provider = snap.provider;
        fallbackProviders = [...snap.fallbackProviders];
        maxAgeRating = snap.maxAgeRating;
        initial = snap;
        settingsInitialized = true;
    });

    /**
     * After a save, move `initial` to what the server stored and re-seed only
     * the fields the user has not touched since pressing Save. Re-seeding every
     * field threw away anything typed while the request was running and then
     * showed the form as clean.
     */
    function reseedAfterSave(sent: SettingsSnapshot): void {
        if (!library) return;
        const fresh = serverSnapshot(library);
        if (name === sent.name) name = fresh.name;
        if (icon === sent.icon) icon = fresh.icon;
        if (description === sent.description) description = fresh.description;
        if (mediaType === sent.mediaType) mediaType = fresh.mediaType;
        if (provider === sent.provider) provider = fresh.provider;
        if (arraysEqualUnordered(fallbackProviders, sent.fallbackProviders)) {
            fallbackProviders = [...fresh.fallbackProviders];
        }
        if (maxAgeRating === sent.maxAgeRating) maxAgeRating = fresh.maxAgeRating;
        initial = fresh;
    }

    function buildUpdateBody(): LibraryUpdateBody {
        if (!initial) return {};
        const body: LibraryUpdateBody = {};
        const trimmedName = name.trim();
        if (trimmedName && trimmedName !== initial.name) body.name = trimmedName;
        const iconVal = icon.trim() || null;
        if (iconVal !== (initial.icon || null)) body.icon = iconVal;
        const descVal = description.trim() || null;
        if (descVal !== (initial.description || null)) body.description = descVal;
        // Type/provider/fallbacks are fixed for a remote-source library — the
        // connection IS the provider, so the fields are read-only in the form
        // and never enter the diff.
        if (!isRemoteLibrary) {
            if (mediaType !== initial.mediaType) body.media_type = mediaType;
            if (!isNonEntertainment(mediaType)) {
                if (provider !== initial.provider) body.provider = provider;
                const cleaned = fallbackProviders.filter((fp) => fp !== provider);
                if (!arraysEqualUnordered(cleaned, initial.fallbackProviders)) {
                    body.fallback_providers = cleaned;
                }
            }
        }
        if (maxAgeRating !== initial.maxAgeRating) body.max_age_rating = maxAgeRating;
        if (
            initialAccess !== null &&
            !permissionsLoadError &&
            !arraysEqualUnordered(accessDraft, initialAccess)
        ) {
            body.allowed_groups = [...accessDraft];
        }
        return body;
    }

    const pendingBody = $derived(settingsInitialized ? buildUpdateBody() : {});
    const formDirty = $derived(Object.keys(pendingBody).length > 0);

    async function doSaveSettings(): Promise<void> {
        const body = buildUpdateBody();
        if (Object.keys(body).length === 0) return;
        const sent = draftSnapshot();
        const sentAccess = [...accessDraft];
        savingSettings = true;
        try {
            const { data: result, error } = await updateLibrary(libraryId, body);
            if (error) {
                toasts.error(error || m.admin_library_detail_err_save_settings());
                return;
            }
            toasts.success(m.admin_library_detail_settings_saved());
            if (body.allowed_groups) {
                initialAccess = [...body.allowed_groups];
                // Access edits made during the save stay a pending change.
                if (arraysEqualUnordered(accessDraft, sentAccess)) {
                    accessDraft = [...body.allowed_groups];
                }
            }
            if (result) {
                libraryGroups = libraryGroups.map((g) => (g.id === libraryId ? result.group : g));
                paths = [...paths.filter((p) => p.libraryGroupId !== libraryId), ...result.paths];
            }
            reseedAfterSave(sent);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_detail_err_save_settings()));
        } finally {
            savingSettings = false;
        }
    }

    async function handleSaveSettings(): Promise<void> {
        if (savingSettings || !formDirty || !initial) return;
        if ('media_type' in pendingBody && folders.length > 0) {
            modals.open(ConfirmModal, {
                title: m.admin_library_detail_type_change_confirm_title(),
                body: m.admin_library_detail_type_change_confirm_body({
                    oldType: mediaTypeLabel(initial.mediaType),
                    newType: mediaTypeLabel(mediaType),
                }),
                confirmText: m.save(),
                onConfirm: () => doSaveSettings(),
            });
            return;
        }
        await doSaveSettings();
    }

    // -------------------------------------------------------------------------
    // Danger zone
    // -------------------------------------------------------------------------

    let deletingLibrary = $state(false);

    function confirmDeleteLibrary(): void {
        if (folders.length > 0) {
            toasts.error(m.admin_library_detail_delete_disabled_reason());
            return;
        }
        modals.open(ConfirmModal, {
            title: m.admin_library_detail_delete_confirm_title(),
            body: m.admin_library_detail_delete_confirm_body({ name: library?.name ?? '' }),
            confirmText: m.delete(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                deletingLibrary = true;
                try {
                    const { error } = await deleteLibraryGroup(libraryId);
                    if (error) {
                        toasts.error(error);
                    } else {
                        toasts.success(m.admin_library_detail_deleted());
                        await goto(resolve('/admin/library/sources'));
                    }
                } catch (e) {
                    toasts.error(getErrorMessage(e, m.admin_library_err_delete_group()));
                } finally {
                    deletingLibrary = false;
                }
            },
        });
    }
</script>

<div class="space-y-6">
    <a
        href={resolve('/admin/library/sources')}
        class="inline-flex items-center gap-1 text-sm text-surface-400 hover:text-white transition-colors">
        <Icon src={ArrowLeft} class="w-4 h-4" />
        {m.admin_library_detail_back()}
    </a>

    {#if loading}
        <p class="text-muted">{m.loading()}</p>
    {:else if loadFailed}
        <div
            class="bg-surface-800 border border-surface-700 rounded-lg p-10 text-center space-y-3"
            role="alert">
            <p class="text-white font-medium">{m.admin_library_detail_load_failed()}</p>
            <button class="btn btn-ghost" onclick={retryLoad}>{m.retry()}</button>
        </div>
    {:else if notFound}
        <div class="bg-surface-800 border border-surface-700 rounded-lg p-10 text-center">
            <p class="text-white font-medium">{m.admin_library_detail_not_found()}</p>
        </div>
    {:else if library}
        <AdminPageHeader
            icon={adminPageIcons['/admin/library/sources']}
            title={library.icon ? `${library.icon} ${library.name}` : library.name}
            description={headerDescription}>
            {#if scanState}
                <button
                    class="btn btn-ghost text-red-400 hover:text-red-300"
                    disabled={scan.pendingGroupIds.has(libraryId) ||
                        scanState.state === 'cancelling'}
                    onclick={() => void abortScan()}>
                    <Icon src={XMark} class="w-4 h-4" />
                    {m.admin_library_scan_stop()}
                </button>
            {:else}
                <button
                    class="btn btn-blue"
                    disabled={folders.length === 0 || scan.pendingGroupIds.has(libraryId)}
                    onclick={() => void triggerScan()}>
                    <Icon src={ArrowPath} class="w-4 h-4" />
                    {m.admin_library_scan_button()}
                </button>
            {/if}
        </AdminPageHeader>

        <!-- Issues: only when the latest completed runs actually have errors. -->
        {#if scanIssues && scanIssues.totalErrors > 0}
            <section
                id="issues"
                class="bg-surface-800 border border-surface-700 rounded-lg overflow-hidden">
                <div
                    class="px-4 py-3 flex items-center justify-between gap-3 border-b border-surface-700">
                    <h3 class="font-medium text-red-400 flex items-center gap-1.5">
                        <Icon src={ExclamationTriangle} class="w-4 h-4" />
                        {m.admin_library_issues_heading()}
                    </h3>
                    <div class="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                        <a
                            href={resolve(`/admin/library/media?library=${libraryId}`)}
                            class="inline-flex items-center gap-1 text-xs text-surface-400 hover:text-white transition-colors">
                            {m.admin_library_issues_open_in_media()}
                            <Icon src={ArrowTopRightOnSquare} class="w-3.5 h-3.5" />
                        </a>
                        <a
                            href={resolve(`/admin/library/fix-matches?library=${libraryId}`)}
                            class="inline-flex items-center gap-1 text-xs text-surface-400 hover:text-white transition-colors">
                            {m.admin_library_issues_open_in_fix_matches()}
                            <Icon src={ArrowTopRightOnSquare} class="w-3.5 h-3.5" />
                        </a>
                    </div>
                </div>
                <div class="divide-y divide-surface-700/50">
                    {#each scanIssues.groups as group (group.cause)}
                        {@const expanded = Boolean(expandedCauses[group.cause])}
                        {@const visibleFiles = expanded ? group.files : group.files.slice(0, 5)}
                        <div class="px-4 py-3 space-y-2">
                            <h4 class="text-sm font-medium text-white">
                                {causeLabel(group.cause)}
                                <span class="text-surface-400 font-normal">
                                    · {m.admin_library_issues_group_count({ count: group.count })}
                                </span>
                            </h4>
                            {#if group.cause !== 'other'}
                                <p class="text-xs text-surface-400">{causeFix(group.cause)}</p>
                            {/if}
                            <ul class="space-y-1 text-xs font-mono text-surface-300">
                                {#each visibleFiles as file (file.path)}
                                    <li class="break-all" title={file.path}>
                                        {issueFileLabel(file.path)}
                                        {#if group.cause === 'other' && file.reason}
                                            <span class="block font-sans text-surface-500"
                                                >{file.reason}</span>
                                        {/if}
                                    </li>
                                {/each}
                            </ul>
                            {#if group.files.length > 5}
                                <button
                                    type="button"
                                    class="text-xs text-blue-400 hover:text-blue-300 underline decoration-dotted underline-offset-2"
                                    onclick={() => toggleCauseExpanded(group.cause)}>
                                    {expanded
                                        ? m.admin_library_issues_show_less()
                                        : m.admin_library_issues_show_all({
                                              count: group.files.length,
                                          })}
                                </button>
                            {/if}
                        </div>
                    {/each}
                </div>
                {#if scanIssues.unsampled > 0}
                    <p class="px-4 py-2 text-xs text-surface-500 border-t border-surface-700">
                        {m.admin_library_issues_unsampled({
                            count: scanIssues.unsampled,
                            max: SCAN_ISSUE_SAMPLE_LIMIT,
                        })}
                    </p>
                {/if}
            </section>
        {/if}

        <!-- Folders -->
        <section class="bg-surface-800 border border-surface-700 rounded-lg overflow-hidden">
            <div class="px-4 py-3 flex items-center justify-between border-b border-surface-700">
                <h3 class="font-medium text-white">{m.admin_library_detail_folders_heading()}</h3>
                <button class="btn btn-sm btn-ghost" onclick={openAddFolder}>
                    <Icon src={Plus} class="w-4 h-4" />
                    {m.admin_library_detail_add_folder()}
                </button>
            </div>
            {#if isRemoteLibrary}
                <!-- A remote source's connection, sync health and per-user
                     credentials are integration state and live in Settings; an
                     operator whose remote library shows nothing needs that page,
                     and nothing else here would point them to it. -->
                {@const descriptor = getRemoteLibrarySourceDescriptor(
                    folders.find((p) => isRemoteProvider(p.provider))?.provider ?? '',
                )}
                {#if descriptor}
                    <p class="px-4 py-2 text-xs text-muted border-b border-surface-700">
                        <a
                            href={resolve(descriptor.settingsHref)}
                            class="underline hover:text-white"
                            >{m.admin_library_detail_remote_settings_link({
                                source: descriptor.label,
                            })}</a>
                    </p>
                {/if}
            {/if}
            {#if isLocalAudiobook}
                <p
                    class="px-4 py-2 text-xs text-amber-400 border-b border-surface-700"
                    data-testid="local-audiobook-notice">
                    {m.admin_library_local_audiobook_notice()}
                    <a
                        href={resolve('/admin/settings/audiobookshelf')}
                        class="underline hover:text-white"
                        >{m.admin_library_audiobooks_abs_link()}</a>
                </p>
            {/if}
            {#if folders.length === 0}
                <p class="px-4 py-6 text-sm text-muted">{m.admin_library_detail_no_folders()}</p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr
                                class="border-b border-surface-700 text-left text-surface-400 text-xs">
                                <th class="py-2 px-4">{m.route_admin_library_col_path()}</th>
                                <th class="py-2 px-4 hidden sm:table-cell"
                                    >{m.route_admin_library_col_lang()}</th>
                                <th class="py-2 px-4">{m.route_admin_library_col_enabled()}</th>
                                <th class="py-2 px-4"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each folders as lp (lp.id)}
                                {@const remoteName = remoteLibraryNames.get(lp.path)}
                                <tr
                                    class="border-b border-surface-800/50 hover:bg-surface-800/30 last:border-b-0">
                                    <td
                                        class="py-2.5 px-4 text-white text-xs max-w-[12rem] sm:max-w-sm truncate"
                                        title={lp.path}>
                                        {#if remoteName}
                                            <span class="font-medium text-sm">{remoteName}</span>
                                        {:else}
                                            <span class="font-mono">{lp.path}</span>
                                        {/if}
                                        <span class="block sm:hidden text-surface-500 font-sans">
                                            {lp.language}
                                        </span>
                                    </td>
                                    <td
                                        class="py-2.5 px-4 text-surface-400 text-xs hidden sm:table-cell">
                                        {lp.language}
                                    </td>
                                    <td class="py-2.5 px-4">
                                        <button
                                            class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                                                {lp.enabled
                                                ? 'bg-green-600'
                                                : 'bg-surface-600'} disabled:opacity-50"
                                            onclick={() => void toggleFolderEnabled(lp)}
                                            disabled={togglingFolderId === lp.id}
                                            aria-label={lp.enabled
                                                ? m.admin_library_disable_path({ path: lp.path })
                                                : m.admin_library_enable_path({ path: lp.path })}>
                                            <span
                                                class="inline-block h-3 w-3 transform rounded-full bg-white transition-transform
                                                    {lp.enabled
                                                    ? 'translate-x-5'
                                                    : 'translate-x-1'}">
                                            </span>
                                        </button>
                                    </td>
                                    <td class="py-2.5 px-4 text-right">
                                        <div class="flex items-center justify-end gap-1">
                                            <button
                                                class="rounded p-1.5 text-surface-400 hover:text-blue-400 hover:bg-surface-700"
                                                onclick={() => openEditFolder(lp)}
                                                aria-label={m.admin_library_edit_path({
                                                    path: lp.path,
                                                })}>
                                                <Icon src={Pencil} class="w-4 h-4" />
                                            </button>
                                            <button
                                                class="rounded p-1.5 text-red-400 hover:text-red-300 hover:bg-surface-700 disabled:opacity-50"
                                                onclick={() => confirmRemoveFolder(lp)}
                                                disabled={deletingFolderId === lp.id}
                                                aria-label={m.admin_library_delete_path({
                                                    path: lp.path,
                                                })}>
                                                <Icon src={Trash} class="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- Settings -->
        <section class="bg-surface-800 border border-surface-700 rounded-lg p-4 space-y-4">
            <h3 class="font-medium text-white">{m.admin_library_detail_settings_heading()}</h3>
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lib-name">
                        {m.playlist_name()} <span class="text-red-400">*</span>
                    </label>
                    <input id="lib-name" type="text" class="input w-full" bind:value={name} />
                </div>
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lib-icon">
                        {m.admin_library_detail_field_icon()}
                        <span class="text-surface-500 text-xs font-normal ml-1"
                            >(optional emoji)</span>
                    </label>
                    <input
                        id="lib-icon"
                        type="text"
                        class="input w-full"
                        placeholder={m.admin_library_detail_icon_placeholder()}
                        bind:value={icon} />
                </div>
                <div class="sm:col-span-2">
                    <label class="block text-sm text-surface-400 mb-1" for="lib-description">
                        {m.modal_description_aria()}
                    </label>
                    <input
                        id="lib-description"
                        type="text"
                        class="input w-full"
                        bind:value={description} />
                </div>
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lib-media-type">
                        {m.admin_library_detail_field_media_type()}
                    </label>
                    {#if isRemoteLibrary}
                        <p class="input w-full flex items-center text-surface-300">
                            {mediaTypeLabel(mediaType)}
                        </p>
                        <p class="text-xs text-surface-500 mt-1">
                            {m.admin_library_detail_remote_note({
                                label:
                                    getRemoteLibrarySourceDescriptor(provider)?.label ??
                                    providerLabel(provider),
                            })}
                        </p>
                    {:else}
                        <select id="lib-media-type" class="input w-full" bind:value={mediaType}>
                            <option value="movie">{m.media_movie()}</option>
                            <option value="tv">{m.admin_library_type_series()}</option>
                            <option value="anime">{m.media_plain_anime()}</option>
                            <option value="music">{m.media_music()}</option>
                            {#if isLocalAudiobook}
                                <option value="audiobook">{m.media_audiobook()}</option>
                            {/if}
                            <option value="home_video">{m.media_plain_home_videos()}</option>
                            <option value="training">{m.media_plain_type_training()}</option>
                            <option value="educational">{m.mood_profile_educational_name()}</option>
                            <option value="personal">{m.media_plain_type_personal()}</option>
                        </select>
                    {/if}
                </div>
                {#if !isRemoteLibrary && !isNonEntertainment(mediaType)}
                    <div>
                        <label class="block text-sm text-surface-400 mb-1" for="lib-provider">
                            {m.admin_library_detail_field_provider()}
                        </label>
                        <select id="lib-provider" class="input w-full" bind:value={provider}>
                            <option value="tmdb">TMDB</option>
                            <option value="jellyfin">Jellyfin</option>
                            <option value="anidb">AniDB</option>
                            <option value="tvdb">TheTVDB</option>
                            <option value="musicbrainz">MusicBrainz</option>
                        </select>
                    </div>
                    <div class="sm:col-span-2">
                        <p class="block text-sm text-surface-400 mb-1">
                            {m.admin_library_detail_field_fallback_providers()}
                            <span class="text-surface-500 text-xs font-normal ml-1"
                                >(optional)</span>
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
                <div>
                    <label class="block text-sm text-surface-400 mb-1" for="lib-age-rating">
                        {m.admin_library_detail_field_age_limit()}
                        <span class="text-surface-500 text-xs font-normal ml-1">(optional)</span>
                    </label>
                    <input
                        id="lib-age-rating"
                        type="number"
                        min="0"
                        max="21"
                        class="input w-full"
                        placeholder={m.media_plain_no_restriction()}
                        value={maxAgeRating ?? ''}
                        oninput={(e) => {
                            const val = e.currentTarget.value;
                            const parsed = Number.parseInt(val, 10);
                            maxAgeRating = val === '' || Number.isNaN(parsed) ? null : parsed;
                        }}
                        aria-describedby="lib-age-rating-hint" />
                    <p id="lib-age-rating-hint" class="text-xs text-surface-500 mt-1">
                        {m.admin_library_detail_age_limit_hint()}
                    </p>
                </div>
            </div>

            <div class="border-t border-surface-700 pt-4">
                <LibraryAccessEditor
                    bind:value={accessDraft}
                    {availableGroups}
                    loadError={permissionsLoadError}
                    onRetry={() => void loadPermissions()} />
            </div>

            <div class="flex justify-end pt-2">
                <button
                    class="btn btn-blue"
                    disabled={!formDirty || savingSettings}
                    onclick={() => void handleSaveSettings()}>
                    {savingSettings ? '...' : m.save()}
                </button>
            </div>
        </section>

        <!-- Scan history -->
        {#key historyKey}
            <ScannerRunHistory libraryGroupId={libraryId} />
        {/key}

        <!-- Danger zone -->
        <section class="bg-surface-800 border border-red-900/40 rounded-lg p-4">
            <h3 class="font-medium text-red-300 mb-2">
                {m.admin_library_detail_danger_zone_heading()}
            </h3>
            <div class="flex flex-wrap items-center justify-between gap-3">
                <p class="text-sm text-surface-400">
                    {#if folders.length > 0}
                        {m.admin_library_detail_delete_disabled_reason()}
                    {/if}
                </p>
                <button
                    class="btn btn-ghost text-red-400 hover:text-red-300 disabled:opacity-50"
                    disabled={deletingLibrary}
                    onclick={confirmDeleteLibrary}>
                    <Icon src={Trash} class="w-4 h-4" />
                    {m.admin_library_detail_delete_library()}
                </button>
            </div>
        </section>
    {/if}
</div>
