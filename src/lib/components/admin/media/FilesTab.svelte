<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import AudioTailDiagnosis from './AudioTailDiagnosis.svelte';
    import FileHealthReviewModal from './FileHealthReviewModal.svelte';
    import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';
    import { startVisibleRefresh } from './visible-refresh.js';
    import FileLanguageSummary from './FileLanguageSummary.svelte';
    import type { FileLanguageSummary as FileLanguages } from '$lib/schemas/admin-language-summary.js';
    import { untrack } from 'svelte';
    import { detailTabPath } from './detail-navigation.js';
    import { groupPhysicalFiles } from './physical-files.js';
    import SharedFileSummary from './SharedFileSummary.svelte';
    import { localizedLanguageName } from '$lib/shared/language-codes.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import * as m from '$lib/paraglide/messages';
    import { Icon, DocumentText } from 'svelte-hero-icons';
    import {
        getMediaCompatibility,
        probeRawFile,
        getMediaChapters,
        getMediaStreams,
    } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import {
        ensurePathScopedCapabilities,
        serializePathScopedCaps,
    } from '$lib/components/player/browserCapabilities.svelte';
    import CompatibilityMatrix from './CompatibilityMatrix.svelte';
    import SubtitleSearchPanel from './SubtitleSearchPanel.svelte';
    import CompatibilityDetailModal from './CompatibilityDetailModal.svelte';
    import ProbeRawModal from './ProbeRawModal.svelte';
    import FileEpisodesEditor from './FileEpisodesEditor.svelte';
    import type {
        CompatibilityResponse,
        FileCompatibility,
        BrowserCompatibility,
    } from '$lib/schemas/admin-types.js';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import {
        fileHealthIssueGuidance,
        fileHealthIssueLabel,
        fileHealthIssueReason,
    } from '$lib/utils/file-health-issue';
    import { formatDuration, formatRelativeTime } from '$lib/utils/time-formatting';
    import EpisodeTrickplayPreview from './EpisodeTrickplayPreview.svelte';
    import { browser } from '$app/environment';
    import { invalidate } from '$app/navigation';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { createSubjectRunsTracker, type SubjectRunsTracker } from '$lib/stores/subject-runs.js';
    import { page } from '$app/stores';
    import {
        isMusicType,
        isMovie as _isMovie,
        isEpisode as _isEpisode,
    } from '$lib/shared/media-types';
    import { resolve } from '$lib/paths';
    import { apiUrl } from '$lib/shared/api-urls.js';

    interface Props {
        mediaId: string;
        mediaType: string;
        isSeries?: boolean;
        jellyfinId?: string | null;
    }

    let { mediaId, mediaType, isSeries = false }: Props = $props();

    interface FileRow {
        tailAssessment?: AudioTailAssessment;
        linked_media_count?: number;
        id: string;
        file_path: string;
        language_summary?: FileLanguages;
        edition: string | null;
        part_number: number | null;
        library_group_id: string | null;
        created_at: string;
        media_item_id: string;
        file_size_bytes: string | null;
        duration_seconds: number | null;
        container_format: string | null;
        file_mtime: string | null;
        file_hash_head: string | null;
        probed_at: string | null;
        health_classification?: 'none' | 'actionable' | 'informational' | 'reviewed';
        health_issues:
            | {
                  type: string;
                  basis?: string;
                  reviewed?: boolean;
                  detected_at: string;
                  /** Verbatim reason — e.g. the exact ffmpeg error and where. */
                  detail?: string;
                  expected_duration?: number;
                  actual_duration?: number;
              }[]
            | null;
        is_default?: boolean;
        file_sort_order?: number;
        file_label?: string | null;
        // present when isSeries=true
        media_title?: string | null;
        media_type?: string;
        season_number?: number | null;
        episode_number?: number | null;
        start_offset_ms?: number | string | null;
        end_offset_ms?: number | string | null;
    }

    // Selected-file chapter times arrive in milliseconds.
    interface ChapterRow {
        id: number;
        media_item_id: string | null;
        chapter_index: number;
        chapter_name: string | null;
        startMs: number;
        endMs: number | null;
        source: string;
    }

    let files = $state<
        Array<FileRow & { associations: FileRow[]; mixedAssociationFields: string[] }>
    >([]);
    let filesLoading = $state(true);
    let filesError = $state(false);
    let filesRefreshedAt = $state<string | null>(null);
    let versionStreams = $state<Record<string, StreamRow[]>>({});

    interface StreamRow {
        id: string;
        file_id: string;
        stream_type: 'audio' | 'video' | 'subtitle';
        stream_index: number;
        codec: string;
        language: string | null;
        display_title: string | null;
        title: string | null;
        channels: number | null;
        width: number | null;
        height: number | null;
        bit_depth: number | null;
        video_range: string | null;
        bitrate: number | null;
        is_default: boolean;
        is_forced: boolean;
    }

    let chapters = $state<ChapterRow[]>([]);
    let chaptersLoading = $state(true);

    // Global file selection — scopes streams, chapters, trickplay, compatibility
    let selectedFileId = $state<string | null>(null);
    let reviewFileId = $state<string | null>(null);

    let streams = $state<StreamRow[]>([]);
    let streamsLoading = $state(true);
    let streamsError = $state(false);
    let chaptersError = $state(false);

    // Compatibility matrix state
    let compatData = $state<CompatibilityResponse | null>(null);
    let compatLoading = $state(false);
    let compatError = $state<string | null>(null);
    let detailBrowser = $state<BrowserCompatibility | null>(null);
    let detailFile = $state<FileCompatibility | null>(null);

    // Raw ffprobe state
    let probeLoading = $state(false);
    let probeResult = $state<{
        filePath: string;
        probe: Record<string, unknown>;
    } | null>(null);

    // Task id of the trickplay run, i.e. the join key between this tab's
    // buttons and the runs the tracker sees for this media item.
    const TRICKPLAY_TASK_ID = 'trickplay-generation';

    /**
     * Inert stand-in used during SSR. The real tracker opens an EventSource,
     * issues a relative-URL fetch and arms an interval — all browser-only — so
     * building it on the server would leak a timer and fire a doomed request.
     */
    const INERT_TRACKER: SubjectRunsTracker = {
        runsFor: () => [],
        isActive: () => false,
        progressFor: () => undefined,
        onSettled: () => () => {},
        destroy: () => {},
    };

    /**
     * One tracker per subject, rebuilt whenever `mediaId` changes — SvelteKit
     * reuses this component across `[id]` navigations, so a single mount-time
     * tracker would keep reporting the previous item's runs.
     *
     * Unlike SyncTab this tab gets no SSR seed (nothing passes one in), so the
     * tracker's own subject-scoped fetch is what reconstructs in-flight runs on
     * load. That still satisfies the reload / second-tab / other-admin cases;
     * it just lands one round-trip after first paint instead of on it.
     */
    let tracker = $state.raw<SubjectRunsTracker>(INERT_TRACKER);

    $effect(() => {
        const subjectId = mediaId;
        if (!browser) return;
        const created = createSubjectRunsTracker(subjectId, []);
        tracker = created;
        return () => {
            // Releases exactly one ref-count on the shared SSE bus, so repeated
            // mount/unmount of this page cannot leak connections.
            created.destroy();
            tracker = INERT_TRACKER;
        };
    });

    // The bus is callback-driven rather than rune-backed, so every tracker read
    // is re-run when it signals a change. Without this the derived values below
    // would be snapshots taken once at mount.
    let runsVersion = $state(0);
    $effect(() => runSSEBus.onAnyChange(() => (runsVersion += 1)));

    let trickplayProgress = $derived.by(() => {
        void runsVersion;
        return tracker.progressFor(TRICKPLAY_TASK_ID) ?? null;
    });

    let trickplayPreviewKey = $state(0);

    // Terminal outcomes are reported from the run's OWN state. The poller this
    // replaces inferred "finished" from a run falling out of an unfiltered
    // 200-row listing window, which announced success for failed runs too.
    $effect(() =>
        tracker.onSettled((run) => {
            if (
                ['media-probe', 'chapter-sync', 'series-sync', 'file-system-scan'].includes(
                    run.taskId,
                )
            ) {
                void loadFiles(true);
                return;
            }
            if (run.taskId !== TRICKPLAY_TASK_ID) return;
            if (run.state === 'completed') {
                toasts.success(m.media_files_trickplay_finished());
                // Reload the trickplay preview now that tiles exist.
                trickplayPreviewKey++;
            } else if (run.state === 'failed') {
                toasts.error(m.media_sync_task_failed({ label: run.label || run.taskId }));
            } else {
                toasts.info(m.media_sync_task_cancelled({ label: run.label || run.taskId }));
            }
            // Narrower than invalidateAll() (it does not re-run layout loads),
            // but NOT per-query: depends() registers the key for the whole
            // route load, so the media item, external ids, lock status and
            // series health re-run too. Acceptable at terminal-transition
            // frequency; the tracker owns live state via the SSE bus.
            void invalidate('media:runs');
        }),
    );

    async function runRawProbe(fileId: string): Promise<void> {
        probeLoading = true;
        try {
            const { data, error } = await probeRawFile(mediaForFile(fileId), fileId);
            if (error || !data) {
                toasts.error(typeof error === 'string' ? error : m.media_files_ffprobe_failed());
                return;
            }
            probeResult = data;
        } catch {
            toasts.error(m.media_files_ffprobe_request_failed());
        } finally {
            probeLoading = false;
        }
    }

    function handleBrowserClick(browser: BrowserCompatibility, file: FileCompatibility): void {
        detailBrowser = browser;
        detailFile = file;
    }

    function closeDetail(): void {
        detailBrowser = null;
        detailFile = null;
    }

    let compatibilityGeneration = 0;
    let mappingRevision = $state(0);
    async function loadCompatibility(): Promise<void> {
        const generation = ++compatibilityGeneration;
        const requestedMediaId = technicalMediaId;
        const expectedFileId = selectedFileId;
        const current = (): boolean =>
            generation === compatibilityGeneration &&
            requestedMediaId === technicalMediaId &&
            expectedFileId === selectedFileId;
        compatLoading = true;
        compatError = null;
        try {
            const pathScoped = await ensurePathScopedCapabilities();
            if (!current()) return;
            const capsString = pathScoped
                ? (serializePathScopedCaps(pathScoped) ?? undefined)
                : undefined;
            const { data, error } = await getMediaCompatibility(requestedMediaId, capsString);
            if (!current()) return;
            if (error || !data) {
                compatError = error ?? m.media_files_compat_load_failed();
                return;
            }
            compatData = data;
        } catch {
            if (current()) compatError = m.media_files_compat_load_failed();
        } finally {
            if (current()) compatLoading = false;
        }
    }

    const isMusicItem = $derived(isMusicType(mediaType));
    const isContainer = $derived(
        isSeries || mediaType === 'season' || mediaType === 'album' || mediaType === 'artist',
    );

    const showChapters = $derived(!isSeries && (_isMovie(mediaType) || _isEpisode(mediaType)));
    // Episode files can be linked to episodes by hand (FileEpisodesEditor).
    const canEditFileEpisodes = $derived(isSeries || _isEpisode(mediaType));
    let episodesEditorFileId = $state<string | null>(null);

    const showStreams = $derived(true);
    const showTrickplay = $derived(!isMusicItem);
    const showCompatibility = $derived(!isMusicItem);

    const videoStreams = $derived(streams.filter((s) => s.stream_type === 'video'));
    const audioStreams = $derived(streams.filter((s) => s.stream_type === 'audio'));
    const subtitleStreams = $derived(streams.filter((s) => s.stream_type === 'subtitle'));

    const totalFiles = $derived(files.length);
    const hasMultipleFiles = $derived(files.length > 1);

    const selectedFile = $derived(files.find((f) => f.id === selectedFileId) ?? files[0] ?? null);

    const selectedContentKey = $derived(
        JSON.stringify([
            selectedFile?.file_path,
            selectedFile?.file_hash_head,
            selectedFile?.file_mtime,
            selectedFile?.file_size_bytes,
            selectedFile?.duration_seconds,
            selectedFile?.probed_at,
        ]),
    );

    const technicalMediaId = $derived(selectedFile?.media_item_id ?? mediaId);
    function mediaForFile(id?: string | null): string {
        return files.find((file) => file.id === id)?.media_item_id ?? mediaId;
    }

    // Compatibility data scoped to selected file
    const selectedFileCompat = $derived(
        compatData && selectedFileId
            ? {
                  files: compatData.files.filter((f) => f.file_id === selectedFileId),
              }
            : compatData,
    );

    function getFileTabLabel(file: FileRow): string {
        const name = file.file_path.split('/').pop() ?? file.file_path;
        return file.file_label || file.edition || name;
    }

    function msToTime(milliseconds: number): string {
        const seconds = Math.floor(milliseconds / 1000);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) {
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function containerLabel(file: FileRow): string {
        const formats = (file.container_format ?? '').toLowerCase().split(',');
        const extension = file.file_path.split('.').pop()?.toLowerCase();
        if (formats.includes('matroska') || formats.includes('mkv') || formats.includes('webm')) {
            return extension === 'webm' || file.container_format === 'webm'
                ? 'WebM'
                : 'Matroska (MKV)';
        }
        if (formats.includes('mov') || formats.includes('mp4')) {
            return extension === 'mov' ? 'QuickTime (MOV)' : 'MP4';
        }
        if (formats.includes('mpegts')) return 'MPEG transport stream (TS)';
        return file.container_format?.toUpperCase() || m.media_redesign_unknown();
    }

    function fileSizeDisplay(bytes: string | null): string {
        if (!bytes) return '—';
        return formatFileSize(Number(bytes));
    }

    function durationDisplay(seconds: number | null): string {
        if (seconds == null) return '—';
        return formatDuration(seconds);
    }

    function relativeDate(dateStr: string | null): string {
        if (!dateStr) return '';
        return formatRelativeTime(dateStr);
    }

    function formatBitrate(bps: number | null): string {
        if (bps == null) return '';
        if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
        if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`;
        return `${bps} bps`;
    }

    function formatEpisodeLabel(file: FileRow): string {
        if (file.season_number == null && file.episode_number == null) {
            return file.media_title ?? '';
        }
        const s = String(file.season_number ?? 0).padStart(2, '0');
        const e = String(file.episode_number ?? 0).padStart(2, '0');
        const label = `S${s}E${e}`;
        return file.media_title ? `${label} — ${file.media_title}` : label;
    }

    /** The part of a combined file one episode plays, e.g. "0:00–45:22"; null when unwindowed. */
    function offsetWindow(link: FileRow): string | null {
        if (link.start_offset_ms == null && link.end_offset_ms == null) return null;
        // An open end from the start of the file is the whole file: nothing to show.
        if (link.end_offset_ms == null && Number(link.start_offset_ms ?? 0) <= 0) return null;
        const start = msToTime(Number(link.start_offset_ms ?? 0));
        const end = link.end_offset_ms == null ? '' : msToTime(Number(link.end_offset_ms));
        return `${start}–${end}`;
    }

    /**
     * Segments of one episode line on a container card. Empty label is dropped;
     * the order is only shown when the file holds several episodes, where it
     * means the playback order (on a single-episode file it is just the version order).
     */
    function associationParts(link: FileRow, multiEpisode: boolean): string[] {
        const parts: string[] = [];
        if (link.file_label) parts.push(link.file_label);
        const range = offsetWindow(link);
        if (range) parts.push(range);
        parts.push(
            link.is_default ? m.media_files_used_for_playback() : m.media_files_other_copy(),
        );
        if (multiEpisode) {
            parts.push(
                m.media_redesign_association_order({
                    order: link.file_sort_order == null ? '—' : String(link.file_sort_order + 1),
                }),
            );
        }
        return parts;
    }

    async function loadFiles(quiet = false): Promise<void> {
        const generation = ++fileGeneration;
        const item = mediaId;
        const kind = mediaType;
        if (!quiet) filesLoading = true;
        try {
            const res = await fetch(
                apiUrl('internal', `/admin/media/${mediaId}/files?children=${isContainer}`),
            );
            if (generation !== fileGeneration || item !== mediaId) return;
            if (!res.ok) {
                filesError = true;
                toasts.error(m.media_files_load_failed());
                return;
            }
            const data = (await res.json()) as { files: FileRow[] };
            if (generation !== fileGeneration || item !== mediaId) return;
            files = groupPhysicalFiles(data.files ?? [], item);
            filesError = false;
            filesRefreshedAt = new Date().toLocaleTimeString();
            // A cross-series edit may have removed the selected file.
            if (!files.some((file) => file.id === selectedFileId)) {
                selectedFileId = files.find((file) => file.is_default)?.id ?? files[0]?.id ?? null;
            }
            if (_isMovie(kind)) {
                const summaries = await Promise.all(
                    files.map(async (file) => {
                        const response = await getMediaStreams(item, file.id);
                        return [file.id, response.data?.streams ?? []] as const;
                    }),
                );
                if (generation !== fileGeneration || item !== mediaId) return;
                versionStreams = Object.fromEntries(summaries);
            }
        } catch {
            if (generation !== fileGeneration || item !== mediaId) return;
            filesError = true;
            if (!quiet) toasts.error(m.media_files_load_failed());
        } finally {
            if (generation === fileGeneration && item === mediaId) filesLoading = false;
        }
    }

    async function refreshLanguageEvidence(): Promise<void> {
        const item = mediaId;
        const selected = selectedFileId;
        const generation = fileGeneration + 1;
        await loadFiles();
        if (mediaId !== item || fileGeneration !== generation) return;
        if (selectedFileId === selected) await loadStreams(selected);
        if (mediaId === item && fileGeneration === generation) await invalidate('media:runs');
    }

    $effect(() => {
        const subjectId = mediaId;
        if (!browser) return;
        const stop = startVisibleRefresh(async () => {
            if (mediaId !== subjectId) return;
            const generation = fileGeneration + 1;
            await loadFiles(true);
            if (mediaId !== subjectId || fileGeneration !== generation || filesError) return;
            // A probe can change stream/chapter rows while every file content
            // field and the selected UUID remain unchanged. Refresh that evidence
            // explicitly; the per-section tokens still fence superseded reads.
            const fileId = selectedFileId;
            await Promise.all([loadStreams(fileId), loadChapters(fileId)]);
        });
        return stop;
    });

    let chapterGeneration = 0;
    let streamGeneration = 0;
    let fileGeneration = 0;

    async function loadChapters(fileId?: string | null): Promise<void> {
        if (!showChapters || !fileId) {
            chapterGeneration++;
            chapters = [];
            chaptersLoading = false;
            return;
        }
        const generation = ++chapterGeneration;
        chaptersLoading = true;
        try {
            const { data, error } = await getMediaChapters(mediaId, fileId);
            if (generation !== chapterGeneration) return;
            if (error || !data) {
                chaptersError = true;
                toasts.error(m.media_files_chapters_load_failed());
                return;
            }
            if (generation !== chapterGeneration) return;
            chapters = data.chapters;
            chaptersError = false;
        } catch {
            if (generation !== chapterGeneration) return;
            chaptersError = true;
            toasts.error(m.media_files_chapters_load_failed());
        } finally {
            if (generation === chapterGeneration) chaptersLoading = false;
        }
    }

    async function loadStreams(fileId?: string | null): Promise<void> {
        if (!showStreams || !fileId) {
            streamGeneration++;
            streams = [];
            streamsLoading = false;
            return;
        }
        const generation = ++streamGeneration;
        streamsLoading = true;
        try {
            const { data, error } = await getMediaStreams(mediaForFile(fileId), fileId);
            if (generation !== streamGeneration) return;
            if (error || !data) {
                streamsError = true;
                toasts.error(m.media_files_streams_load_failed());
                return;
            }
            if (generation !== streamGeneration) return;
            streams = data.streams;
            streamsError = false;
        } catch {
            if (generation !== streamGeneration) return;
            streamsError = true;
            toasts.error(m.media_files_streams_load_failed());
        } finally {
            if (generation === streamGeneration) streamsLoading = false;
        }
    }

    $effect(() => {
        // Track all props that affect data fetching
        void mediaId;
        void isSeries;
        void mediaType;
        untrack(() => {
            void loadFiles();
        });
        return () => {
            fileGeneration += 1;
            chapterGeneration += 1;
            streamGeneration += 1;
        };
    });

    // Reload file-scoped sections when selected file changes
    $effect(() => {
        const fileId = selectedFileId;
        void mediaId;
        void technicalMediaId;
        void selectedContentKey;
        chapters = [];
        streams = [];
        chaptersError = false;
        streamsError = false;
        compatibilityGeneration += 1;
        compatLoading = false;
        untrack(() => {
            void loadChapters(fileId);
            void loadStreams(fileId);
        });
        // Reset compatibility when file changes (will be re-fetched on demand)
        compatData = null;
        compatError = null;
        return () => {
            compatibilityGeneration += 1;
        };
    });
</script>

<div class="space-y-8">
    {#if filesError}<p class="text-xs text-amber-300" role="status">
            {m.media_source_stale()}
        </p>{/if}
    {#if filesRefreshedAt}<p class="text-xs text-surface-400">
            {m.media_source_refreshed({ time: filesRefreshedAt })}
        </p>{/if}
    <!-- Files section -->
    <div class="space-y-4">
        <div class="flex items-center justify-between">
            <div>
                <h3 class="text-lg font-semibold text-white">
                    {m.card_file_info_files_label()}
                </h3>
                <p class="text-sm text-surface-400 mt-1">
                    {m.media_plain_files_action()}
                </p>
                <HelpPopover variant="inline"
                    ><p>{m.media_files_section_description()}</p>
                    <p>{m.media_files_episode_mapping_scope()}</p></HelpPopover>
            </div>
            {#if !filesLoading}
                <span class="text-xs text-surface-400">
                    {m.media_redesign_physical_files({ count: totalFiles })}
                </span>
            {/if}
        </div>

        {#if filesLoading}
            <div class="flex items-center gap-2 text-surface-400 py-8">
                <div
                    class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
                </div>
                {m.media_files_loading()}
            </div>
        {:else if files.length === 0}
            <div class="flex items-center gap-3 text-surface-500 py-8">
                <Icon src={DocumentText} class="w-5 h-5" />
                <p class="text-sm">{m.media_files_none_linked()}</p>
            </div>
        {:else}
            <div class="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="physical-file-cards">
                {#each files as file (file.id)}
                    {@const versionVideo = versionStreams[file.id]?.find(
                        (stream) => stream.stream_type === 'video',
                    )}
                    {@const versionAudio =
                        versionStreams[file.id]?.filter(
                            (stream) => stream.stream_type === 'audio',
                        ) ?? []}
                    <article
                        class="min-w-0 rounded-xl border bg-surface-800/40 p-4 space-y-3 {selectedFileId ===
                        file.id
                            ? 'border-yellow-500/70'
                            : 'border-surface-700'}"
                        data-file-id={file.id}>
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <button
                                type="button"
                                class="min-w-0 break-all font-semibold text-surface-100 text-left"
                                aria-pressed={selectedFileId === file.id}
                                onclick={() => (selectedFileId = file.id)}>
                                {file.file_label ||
                                    file.edition ||
                                    file.file_path.split('/').pop() ||
                                    file.file_path}
                            </button>
                            {#if file.part_number != null}<span
                                    class="rounded bg-surface-700 px-2 py-1 text-xs"
                                    >{m.media_files_part({ number: file.part_number })}</span
                                >{/if}
                            {#if file.is_default}<span
                                    class="rounded bg-yellow-500/15 px-2 py-1 text-xs text-yellow-200"
                                    >{m.media_files_used_for_playback()}</span
                                >{/if}
                        </div>
                        <dl class="grid grid-cols-2 gap-2 text-xs text-surface-300">
                            <div>
                                <dt class="text-surface-400">
                                    {m.media_files_th_edition_source()}
                                </dt>
                                <dd>{file.edition ?? '—'}</dd>
                            </div>
                            <div>
                                <dt class="text-surface-400">{m.media_redesign_physical_size()}</dt>
                                <dd>{fileSizeDisplay(file.file_size_bytes)}</dd>
                            </div>
                            <div>
                                <dt class="text-surface-400">{m.media_redesign_file_time()}</dt>
                                <dd>{durationDisplay(file.duration_seconds)}</dd>
                            </div>
                            <div>
                                <dt class="text-surface-400">{m.media_files_th_format()}</dt>
                                <dd>{containerLabel(file)}</dd>
                            </div>
                            {#if _isMovie(mediaType)}
                                <div>
                                    <dt class="text-surface-400">
                                        {m.media_redesign_resolution()}
                                    </dt>
                                    <dd>
                                        {versionVideo?.width && versionVideo.height
                                            ? `${versionVideo.width} × ${versionVideo.height}`
                                            : m.media_redesign_unknown()}
                                    </dd>
                                </div>
                                <div>
                                    <dt class="text-surface-400">{m.media_redesign_codec()}</dt>
                                    <dd>{versionVideo?.codec ?? m.media_redesign_unknown()}</dd>
                                </div>
                                <div class="col-span-2">
                                    <dt class="text-surface-400">{m.media_redesign_audio()}</dt>
                                    <dd>
                                        {versionAudio
                                            .map((stream) =>
                                                [
                                                    stream.codec,
                                                    stream.language,
                                                    stream.channels ? `${stream.channels} ch` : '',
                                                ]
                                                    .filter(Boolean)
                                                    .join(' · '),
                                            )
                                            .join(', ') || m.media_redesign_unknown()}
                                    </dd>
                                </div>
                            {/if}
                        </dl>
                        {#if !isMusicType(mediaType)}<FileLanguageSummary
                                summary={file.language_summary} />{/if}
                        <p class="text-xs text-surface-400">
                            {file.linked_media_count === undefined
                                ? m.media_redesign_unknown()
                                : m.media_redesign_file_links_total({
                                      count: file.linked_media_count,
                                  })}
                        </p>
                        {#if file.mixedAssociationFields.length > 0}<p
                                class="text-xs text-surface-400">
                                {m.media_redesign_mixed_associations()}
                            </p>{/if}
                        {#if isContainer}
                            <ul class="space-y-1 text-xs">
                                {#each file.associations as link (link.media_item_id)}<li>
                                        <a
                                            class="text-yellow-300 hover:underline"
                                            href={resolve(
                                                `/admin/library/media/${link.media_item_id}`,
                                            )}
                                            >{isSeries
                                                ? formatEpisodeLabel(link)
                                                : (link.media_title ?? '—')}</a>
                                        <span class="text-surface-400">
                                            · {associationParts(
                                                link,
                                                file.associations.length > 1,
                                            ).join(' · ')}</span>
                                    </li>{/each}
                            </ul>
                        {/if}
                        {#if file.health_classification === 'informational'}
                            <p class="text-xs text-sky-300">
                                {m.admin_health_file_mapping_observation()}
                            </p>
                        {:else}
                            {#each file.health_issues ?? [] as issue, issueIndex (issueIndex)}
                                <p
                                    class="text-xs {issue.reviewed
                                        ? 'text-sky-300'
                                        : 'text-amber-200'}">
                                    {issue.reviewed
                                        ? m.admin_health_review_classification()
                                        : fileHealthIssueLabel(issue.type, issue.basis)}
                                </p>
                                {#if fileHealthIssueReason(issue)}<details
                                        class="text-xs text-surface-400">
                                        <summary>{m.media_plain_technical_details()}</summary
                                        >{fileHealthIssueReason(issue)}
                                    </details>{/if}
                                {#if fileHealthIssueGuidance(issue)}
                                    <p class="text-xs text-surface-400">
                                        {fileHealthIssueGuidance(issue)}
                                    </p>
                                {/if}
                            {/each}
                        {/if}
                        {#if (file.health_issues ?? []).some( (issue) => ['duration_mismatch', 'video_ends_early', 'truncated_video'].includes(issue.type) )}
                            <button
                                type="button"
                                class="btn btn-sm variant-ghost-primary"
                                onclick={() => (reviewFileId = file.id)}>
                                {m.admin_health_review_button()}
                            </button>
                        {/if}
                        <AudioTailDiagnosis assessment={file.tailAssessment} />
                        <details class="text-xs text-surface-400">
                            <summary class="cursor-pointer"
                                >{m.media_redesign_filename_path()}</summary>
                            <p class="mt-2 break-all font-mono">{file.file_path}</p>
                            <p>
                                {m.media_files_probed({
                                    time: file.probed_at
                                        ? relativeDate(file.probed_at)
                                        : m.media_files_not_probed(),
                                })}
                            </p>
                            {#if file.file_hash_head}<p class="break-all">
                                    {m.media_files_hash_prefix()}
                                    {file.file_hash_head}
                                </p>{/if}
                        </details>
                        {#if canEditFileEpisodes}<button
                                type="button"
                                class="text-xs text-yellow-300 underline"
                                onclick={() => (episodesEditorFileId = file.id)}
                                >{m.file_episodes_button()}</button
                            >{/if}
                    </article>
                {/each}
            </div>
        {/if}
    </div>

    <!-- File selection tabs + actions -->
    {#if files.length > 0}
        <div class="space-y-1">
            <div class="flex items-center justify-between">
                {#if hasMultipleFiles}
                    <h3 class="text-sm font-medium text-surface-400">
                        {m.media_files_file_details()}
                    </h3>
                {/if}
                {#if selectedFileId}
                    <button
                        class="btn btn-sm variant-soft-surface text-xs ml-auto"
                        onclick={() => {
                            if (selectedFileId) void runRawProbe(selectedFileId);
                        }}
                        disabled={probeLoading}>
                        {#if probeLoading}
                            <span
                                class="w-3 h-3 border-2 border-surface-400 border-t-transparent rounded-full animate-spin inline-block mr-1"
                            ></span>
                            {m.media_files_probing()}
                        {:else}
                            {m.media_files_run_ffprobe()}
                        {/if}
                    </button>
                {/if}
            </div>
            {#if hasMultipleFiles}
                <div class="flex flex-wrap gap-1 border-b border-surface-700/50">
                    {#each files as file (file.id)}
                        <button
                            class="px-4 py-2 text-sm font-medium transition-colors rounded-t-lg
                                {selectedFileId === file.id
                                ? 'bg-surface-800 text-white border border-surface-700/50 border-b-transparent -mb-px'
                                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/40'}"
                            onclick={() => {
                                selectedFileId = file.id;
                            }}>
                            {getFileTabLabel(file)}
                            {#if file.file_size_bytes}
                                <span class="text-xs text-surface-500 ml-1"
                                    >({fileSizeDisplay(file.file_size_bytes)})</span>
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- Trickplay section (non-series, non-music items) -->
    {#if showTrickplay && selectedFileId}
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <h3 class="text-lg font-semibold text-white">
                        {m.media_files_trickplay_title()}
                    </h3>
                    <p class="text-sm text-surface-400 mt-1">
                        {m.media_files_trickplay_description()}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <a
                        class="text-xs text-yellow-300 underline"
                        href={resolve(
                            detailTabPath(
                                mediaId,
                                $page.url.searchParams,
                                'maintenance',
                                'processing',
                            ),
                        )}>{m.media_redesign_maintenance_shortcut()}</a>
                </div>
            </div>

            {#if trickplayProgress && trickplayProgress.total > 0}
                <div class="space-y-1">
                    <div class="flex justify-between text-xs text-surface-400">
                        <span>{m.media_files_generating_thumbnails()}</span>
                        <span>{trickplayProgress.processed} / {trickplayProgress.total}</span>
                    </div>
                    <div class="w-full bg-surface-700 rounded-full h-2 overflow-hidden">
                        <div
                            class="bg-primary-500 h-full rounded-full transition-all duration-300"
                            style="width: {(trickplayProgress.processed / trickplayProgress.total) *
                                100}%">
                        </div>
                    </div>
                </div>
            {/if}

            {#key trickplayPreviewKey}
                <EpisodeTrickplayPreview mediaId={technicalMediaId} fileId={selectedFileId} />
            {/key}
        </div>
    {/if}

    {#if selectedFileId && canEditFileEpisodes}
        <SharedFileSummary
            {mediaId}
            fileId={selectedFileId}
            refreshKey={mappingRevision}
            onedit={() => (episodesEditorFileId = selectedFileId)} />
    {/if}
    <!-- Streams section (non-series items) -->
    {#if showStreams && selectedFileId}
        <div class="space-y-4">
            <div>
                <h3 class="text-lg font-semibold text-white">
                    {m.card_file_info_streams_label()}
                </h3>
                <p class="text-sm text-surface-400 mt-1">
                    {m.media_files_streams_description()}
                </p>
            </div>

            {#if streamsError}<p role="status" class="text-xs text-amber-300">
                    {m.media_source_stale()}
                </p>{/if}
            {#if streamsLoading}
                <div class="flex items-center gap-2 text-surface-400 py-6">
                    <div
                        class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
                    </div>
                    {m.media_files_streams_loading()}
                </div>
            {:else if streams.length === 0}
                <p class="text-surface-500 text-sm py-4">
                    {m.media_files_no_streams()}
                </p>
            {:else}
                {#if videoStreams.length > 0}
                    <div>
                        <h4 class="text-sm font-medium text-surface-300 mb-2">
                            {m.player_tt_video()}
                        </h4>
                        <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                            <table class="w-full text-sm">
                                <thead>
                                    <tr
                                        class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                        <th class="px-3 py-2 text-left w-12">#</th>
                                        <th class="px-3 py-2 text-left">{m.player_tt_codec()}</th>
                                        <th class="px-3 py-2 text-left"
                                            >{m.media_files_th_resolution()}</th>
                                        <th class="px-3 py-2 text-left hidden sm:table-cell"
                                            >{m.media_files_th_range()}</th>
                                        <th class="px-3 py-2 text-left hidden sm:table-cell"
                                            >{m.media_files_th_bit_depth()}</th>
                                        <th class="px-3 py-2 text-left hidden lg:table-cell"
                                            >{m.media_files_th_bitrate()}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each videoStreams as s (s.id)}
                                        <tr
                                            class="border-t border-surface-700/30 hover:bg-surface-800/40 transition-colors">
                                            <td class="px-3 py-2 text-surface-500 font-mono text-xs"
                                                >{s.stream_index}</td>
                                            <td class="px-3 py-2 text-surface-200 text-xs font-mono"
                                                >{s.codec}</td>
                                            <td class="px-3 py-2 text-surface-400 text-xs">
                                                {s.width && s.height
                                                    ? `${s.width}x${s.height}`
                                                    : '—'}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden sm:table-cell">
                                                {s.video_range ?? '—'}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden sm:table-cell">
                                                {s.bit_depth != null ? `${s.bit_depth}-bit` : '—'}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden lg:table-cell">
                                                {formatBitrate(s.bitrate) || '—'}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>
                {/if}

                {#if audioStreams.length > 0}
                    <div>
                        <h4 class="text-sm font-medium text-surface-300 mb-2">
                            {m.player_tt_audio()}
                        </h4>
                        <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                            <table class="w-full text-sm">
                                <thead>
                                    <tr
                                        class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                        <th class="px-3 py-2 text-left w-12">#</th>
                                        <th class="px-3 py-2 text-left">{m.player_tt_codec()}</th>
                                        <th class="px-3 py-2 text-left">{m.modal_language()}</th>
                                        <th class="px-3 py-2 text-left hidden sm:table-cell"
                                            >{m.tab_channels()}</th>
                                        <th class="px-3 py-2 text-left hidden sm:table-cell"
                                            >{m.media_files_th_bitrate()}</th>
                                        <th class="px-3 py-2 text-left hidden lg:table-cell"
                                            >{m.media_files_th_flags()}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each audioStreams as s (s.id)}
                                        <tr
                                            class="border-t border-surface-700/30 hover:bg-surface-800/40 transition-colors">
                                            <td class="px-3 py-2 text-surface-500 font-mono text-xs"
                                                >{s.stream_index}</td>
                                            <td class="px-3 py-2 text-surface-200 text-xs font-mono"
                                                >{s.codec}</td>
                                            <td class="px-3 py-2 text-surface-400 text-xs">
                                                {s.display_title ||
                                                    localizedLanguageName(
                                                        s.language ?? '',
                                                        getLocale(),
                                                    ) ||
                                                    m.media_languages_unknown_language()}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden sm:table-cell">
                                                {s.channels != null ? `${s.channels}ch` : '—'}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden sm:table-cell">
                                                {formatBitrate(s.bitrate) || '—'}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden lg:table-cell">
                                                <span class="flex gap-1">
                                                    {#if s.is_default}<span class="text-primary-400"
                                                            >{m.player_subtitle_style_default()}</span
                                                        >{/if}
                                                    {#if s.is_forced}<span class="text-yellow-400"
                                                            >{m.media_files_forced()}</span
                                                        >{/if}
                                                </span>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>
                {/if}

                {#if subtitleStreams.length > 0}
                    <div>
                        <h4 class="text-sm font-medium text-surface-300 mb-2">
                            {m.player_full_subtitles()}
                        </h4>
                        <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                            <table class="w-full text-sm">
                                <thead>
                                    <tr
                                        class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                        <th class="px-3 py-2 text-left w-12">#</th>
                                        <th class="px-3 py-2 text-left">{m.player_tt_codec()}</th>
                                        <th class="px-3 py-2 text-left">{m.modal_language()}</th>
                                        <th class="px-3 py-2 text-left hidden sm:table-cell"
                                            >{m.media_files_th_flags()}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each subtitleStreams as s (s.id)}
                                        <tr
                                            class="border-t border-surface-700/30 hover:bg-surface-800/40 transition-colors">
                                            <td class="px-3 py-2 text-surface-500 font-mono text-xs"
                                                >{s.stream_index}</td>
                                            <td class="px-3 py-2 text-surface-200 text-xs font-mono"
                                                >{s.codec}</td>
                                            <td class="px-3 py-2 text-surface-400 text-xs">
                                                {s.display_title ||
                                                    localizedLanguageName(
                                                        s.language ?? '',
                                                        getLocale(),
                                                    ) ||
                                                    m.media_languages_unknown_language()}
                                            </td>
                                            <td
                                                class="px-3 py-2 text-surface-400 text-xs hidden sm:table-cell">
                                                <span class="flex gap-1">
                                                    {#if s.is_default}<span class="text-primary-400"
                                                            >{m.player_subtitle_style_default()}</span
                                                        >{/if}
                                                    {#if s.is_forced}<span class="text-yellow-400"
                                                            >{m.media_files_forced()}</span
                                                        >{/if}
                                                </span>
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>
                {/if}

                <!--
                  Sits with the subtitle STREAMS list on purpose: this is where
                  someone stands when they notice a file has none, or none in
                  their language. Rendered whether or not streams exist —
                  "there are no subtitles" is exactly when you want to look for
                  some.
                -->
                {#if !isMusicItem}
                    <SubtitleSearchPanel
                        mediaItemId={technicalMediaId}
                        fileId={selectedFile?.id ?? null}
                        onchanged={() => void refreshLanguageEvidence()} />
                {/if}
            {/if}
        </div>
    {/if}

    <!-- Chapters section (movies and episodes only) -->
    {#if showChapters}
        <details class="space-y-4">
            <summary class="cursor-pointer font-medium">{m.media_files_chapters_title()}</summary>
            <div class="flex items-center justify-between">
                <div>
                    <h3 class="text-lg font-semibold text-white">
                        {m.media_files_chapters_title()}
                    </h3>
                    <p class="text-sm text-surface-400 mt-1">
                        {m.media_files_chapters_description()}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <a
                        class="text-sm text-yellow-300 underline"
                        href={resolve(
                            detailTabPath(
                                mediaId,
                                $page.url.searchParams,
                                'maintenance',
                                'processing',
                            ),
                        )}>{m.media_redesign_maintenance_shortcut()}</a>
                </div>
            </div>

            {#if chaptersError}<p role="status" class="text-xs text-amber-300">
                    {m.media_source_stale()}
                </p>{/if}
            {#if chaptersLoading}
                <div class="flex items-center gap-2 text-surface-400 py-6">
                    <div
                        class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
                    </div>
                    {m.media_files_chapters_loading()}
                </div>
            {:else if chapters.length === 0}
                <p class="text-surface-500 text-sm py-4">{m.media_files_no_chapters()}</p>
            {:else}
                <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                    <table class="w-full text-sm">
                        <thead>
                            <tr
                                class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                <th class="px-3 py-2 text-left w-12">#</th>
                                <th class="px-3 py-2 text-left">{m.playlist_name()}</th>
                                <th class="px-3 py-2 text-left w-24">{m.media_files_th_time()}</th>
                                <th class="px-3 py-2 text-left w-20 hidden sm:table-cell"
                                    >{m.media_files_th_source()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each chapters as ch (ch.id)}
                                <tr
                                    class="border-t border-surface-700/30 hover:bg-surface-800/40 transition-colors">
                                    <td class="px-3 py-2 text-surface-500 font-mono text-xs">
                                        {ch.chapter_index + 1}
                                    </td>
                                    <td class="px-3 py-2 text-xs">
                                        {#if ch.chapter_name}
                                            <span class="text-surface-200">{ch.chapter_name}</span>
                                        {:else}
                                            <span class="text-surface-500 italic"
                                                >{m.media_files_untitled()}</span>
                                        {/if}
                                    </td>
                                    <td class="px-3 py-2 text-surface-400 font-mono text-xs">
                                        {msToTime(ch.startMs)}
                                    </td>
                                    <td
                                        class="px-3 py-2 text-surface-500 text-xs hidden sm:table-cell">
                                        {ch.source}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </details>
    {/if}

    <!-- Compatibility Matrix -->
    {#if showCompatibility && files.length > 0}
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <div>
                    <h3 class="text-lg font-semibold text-white">
                        {m.media_files_compat_title()}
                    </h3>
                    <p class="text-sm text-surface-400 mt-1">
                        {m.media_files_compat_description()}
                    </p>
                </div>
                {#if !compatData && !compatLoading}
                    <button class="btn btn-sm variant-soft-primary" onclick={loadCompatibility}>
                        {m.media_files_check_compatibility()}
                    </button>
                {/if}
            </div>

            {#if compatLoading}
                <div class="flex items-center gap-2 text-surface-400 py-4">
                    <div
                        class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
                    </div>
                    {m.media_files_compat_probing()}
                </div>
            {:else if compatError}
                <div class="text-red-400 text-sm py-4">{compatError}</div>
            {:else if selectedFileCompat && selectedFileCompat.files.length > 0}
                <CompatibilityMatrix
                    data={selectedFileCompat}
                    onBrowserClick={handleBrowserClick} />
            {/if}
        </div>
    {/if}
</div>

{#if detailBrowser && detailFile}
    <CompatibilityDetailModal browser={detailBrowser} file={detailFile} onClose={closeDetail} />
{/if}

{#if episodesEditorFileId}
    <FileEpisodesEditor
        {mediaId}
        fileId={episodesEditorFileId}
        onClose={() => {
            episodesEditorFileId = null;
        }}
        onChanged={() => {
            mappingRevision += 1;
            void refreshLanguageEvidence();
        }} />
{/if}

{#if probeResult}
    <ProbeRawModal
        filePath={probeResult.filePath}
        probeData={probeResult.probe}
        onClose={() => {
            probeResult = null;
        }} />
{/if}

{#if reviewFileId}
    <FileHealthReviewModal
        fileId={reviewFileId}
        onclose={() => (reviewFileId = null)}
        onchanged={async () => {
            await refreshLanguageEvidence();
        }} />
{/if}
