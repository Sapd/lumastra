<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { startVisibleRefresh } from './visible-refresh.js';
    import type { AnalyzerReadiness } from '$lib/schemas/admin-media-analysis.js';
    import type { ExternalIdsGetResponse } from '$lib/schemas/api-media-responses.js';
    import type { EpisodeTmdbExchangePreview } from '$lib/schemas/episode-tmdb-exchange.js';
    import { tmdbIdentityUrl, type TmdbContext } from './tmdb-identity.js';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        ArrowPath,
        PencilSquare,
        Trash,
        Check,
        XMark,
        Plus,
        Film,
    } from 'svelte-hero-icons';
    import {
        syncMediaMetadata,
        syncMediaMetadataEnqueue,
        getMediaExternalIds,
        upsertMediaExternalId,
        deleteMediaExternalId,
        getAdminEpisodes,
        previewEpisodeTmdbExchange,
        confirmEpisodeTmdbExchange,
        getMediaSegments,
        undoMediaSegments,
        clearMediaSegments,
        generateMediaSegments,
        setMediaSegment,
        generateTrickplay as generateTrickplayApi,
        regenerateEpisodeThumbnails,
        syncChapters as syncChaptersApi,
    } from '$lib/api/admin';
    import { untrack } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { apiGet } from '$lib/api/client.js';
    import { RunSchema } from '$lib/schemas/run.schema.js';
    import { resolve } from '$lib/paths';
    import { browser } from '$app/environment';
    import { invalidate } from '$app/navigation';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { createSubjectRunsTracker, type SubjectRunsTracker } from '$lib/stores/subject-runs.js';
    import TaskActionButton from './TaskActionButton.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import type { Run } from '@sapd/lumastra-plugin-sdk';
    import type { ExternalIds } from '$lib/types/api-common';
    import {
        isMusicType,
        isEpisode as checkIsEpisode,
        isMovie as checkIsMovie,
        isSeries as checkIsSeries,
        isSeason as checkIsSeason,
        isAudiobook as checkIsAudiobook,
    } from '$lib/shared/media-types';

    type ExternalIdRow = ExternalIdsGetResponse['externalIds'][number];

    /**
     * What a task-starting handler hands back to `<TaskActionButton>`.
     * `deduped: true` means the orchestrator folded the click into a run that
     * was already going, so the button reports "already running" instead of
     * claiming it queued new work.
     */
    type TaskStartResult = { deduped?: boolean; runId?: string } | void;

    interface Props {
        mediaId: string;
        externalIds: Partial<ExternalIds>;
        mediaType?: string;
        isSeries?: boolean;
        /**
         * SSR seed: in-flight runs whose `scope.subjectId` is this media item.
         * Server state, so a run started before this page loaded — or in another
         * tab, or by another admin — is already reflected on first paint.
         */
        activeRuns?: Run[];
        onsaved?: () => void;
        taskSection?: 'all' | 'metadata' | 'processing';
        tmdbUrl?: string | null;
        tmdbContext?: TmdbContext;
        parentSeriesId?: string | null;
    }

    let {
        mediaId,
        externalIds,
        mediaType = 'movie',
        isSeries = false,
        activeRuns = [],
        onsaved,
        taskSection = 'all',
        tmdbContext = {},
        parentSeriesId = null,
    }: Props = $props();

    // Task ids of every background job this tab can start. They are the join key
    // between a button and the server-side runs the tracker sees.
    const SERIES_SYNC_TASK_ID = 'series-sync';
    const TRICKPLAY_TASK_ID = 'trickplay-generation';
    const EPISODE_THUMBS_TASK_ID = 'episode-thumbnail-extract';
    const CHAPTER_SYNC_TASK_ID = 'chapter-sync';
    const ANALYZER_TASK_ID = 'lumastra-intro-analyzer';

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
     * One tracker per subject. SvelteKit reuses this component across `[id]`
     * navigations, so the tracker is torn down and rebuilt whenever `mediaId`
     * changes — otherwise it would keep reporting the previous item's runs.
     *
     * The seed is read untracked on purpose: `onSettled` invalidates
     * `media:runs`, which replaces `activeRuns`, and tracking it here would
     * make every settled run recycle the SSE connection.
     */
    let tracker = $state.raw<SubjectRunsTracker>(INERT_TRACKER);

    $effect(() => {
        const subjectId = mediaId;
        if (!browser) return;
        // Seeding synchronously notifies bus subscribers. Their rune reads
        // must not become dependencies of this tracker-creation effect.
        const created = untrack(() =>
            createSubjectRunsTracker(subjectId, activeRuns, [
                TRICKPLAY_TASK_ID,
                EPISODE_THUMBS_TASK_ID,
                CHAPTER_SYNC_TASK_ID,
                SERIES_SYNC_TASK_ID,
            ]),
        );
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

    function isTaskActive(taskId: string): boolean {
        void runsVersion;
        return tracker.isActive(taskId);
    }

    function taskProgress(taskId: string): { processed: number; total: number } | null {
        void runsVersion;
        return tracker.progressFor(taskId) ?? null;
    }

    let seriesSyncRunning = $derived.by(() => isTaskActive(SERIES_SYNC_TASK_ID));
    let trickplayRunning = $derived.by(() => isTaskActive(TRICKPLAY_TASK_ID));
    let episodeThumbsRunning = $derived.by(() => isTaskActive(EPISODE_THUMBS_TASK_ID));
    let analyzerRunning = $derived.by(() => isTaskActive(ANALYZER_TASK_ID));
    let trickplayProgress = $derived.by(() => taskProgress(TRICKPLAY_TASK_ID));
    let analysisProgress = $derived.by(() => taskProgress(ANALYZER_TASK_ID));

    /**
     * Whether this item has local media files for the tools below to act on.
     *
     * False for AudiobookShelf books: their bytes live on the ABS server, so the
     * item has no `media_files` rows and every file-driven control here —
     * trickplay, episode thumbnails, ffmpeg chapter extraction, intro/credits
     * segments — has nothing to read. They rendered as live buttons that queued
     * a task which could only ever no-op.
     */
    let hasLocalFiles = $derived(!checkIsAudiobook(mediaType) && !isMusicType(mediaType));

    /**
     * Whether an external METADATA provider identifies this item. A book is
     * identified by its AudiobookShelf item id and has no TMDB row to refresh
     * from, so the provider-sync control has no provider to sync with.
     */
    let hasMetadataProvider = $derived(!checkIsAudiobook(mediaType) && !isMusicType(mediaType));

    let isEpisode = $derived(checkIsEpisode(mediaType));
    let isSeriesOrSeason = $derived(checkIsSeries(mediaType) || checkIsSeason(mediaType));
    let canSetManualSegment = $derived(isEpisode || checkIsMovie(mediaType));

    let syncing = $state(false);
    let includeChildren = $state(true);
    let progressMessage = $state<string | null>(null);

    // Media segments state
    let segmentsLoading = $state(false);
    let segmentsError = $state<string | null>(null);
    let generatingSegments = $state(false);
    let runningDeepAnalysis = $state(false);
    let deepAnalysisResult = $state<{
        success: boolean;
        message: string;
    } | null>(null);
    let clearingSegments = $state(false);
    let segmentUndoId = $state<string | undefined>();
    let savingManualSegment = $state(false);
    let manualSegmentType = $state<'Intro' | 'Outro'>('Outro');
    // `<input type="number">` binds a number (or null when empty), never a string.
    let manualStartTime = $state<number | null>(null);
    let manualEndTime = $state<number | null>(null);
    let manualSegmentMessage = $state<{ success: boolean; message: string } | null>(null);
    let segmentsResult = $state<{
        success: boolean;
        pending?: boolean;
        checkAgain?: boolean;
        segmentsFound?: number;
        runId?: string;
        message: string;
    } | null>(null);
    let analysisInputs = $state<AnalyzerReadiness[] | null>(null);
    let knownInputKey: string | null = null;
    let readinessDetailsOpen = $state(false);
    const readinessCounts = $derived({
        ready: analysisInputs?.filter((input) => input.state === 'ready').length ?? 0,
        awaiting: analysisInputs?.filter((input) => input.state === 'awaiting-input').length ?? 0,
        alternate: analysisInputs?.filter((input) => input.alternate).length ?? 0,
    });
    const alternateGroups = $derived.by(() => {
        const grouped = new SvelteMap<string, number>();
        for (const input of analysisInputs ?? [])
            if (input.alternate && input.filePath)
                grouped.set(input.filePath, (grouped.get(input.filePath) ?? 0) + 1);
        return [...grouped.entries()];
    });
    const analysisReady = $derived(
        analysisInputs?.some((input) => input.state === 'ready') ?? false,
    );
    let segmentsData = $state<{
        totalSegments: number;
        providers: Record<
            string,
            Array<{
                type: string;
                startMs: number;
                endMs: number;
                fetchedAt: string;
                seasonNumber?: number;
                episodeNumber?: number;
            }>
        >;
    } | null>(null);

    // Episode thumbnail regeneration state
    let episodeThumbsResult = $state<{
        success: boolean;
        runId?: string;
        message: string;
    } | null>(null);

    // Chapter sync state. Chapters are extracted from embedded file markers
    // (ffprobe), Jellyfin as fallback — they back the episode-title
    // reconciliation under Episodes → Issues. Enqueued as a tracked task.
    let chapterSyncResult = $state<{
        success: boolean;
        runId?: string;
        message: string;
    } | null>(null);

    // Trickplay generation state. Progress and in-flight status come from the
    // tracker (i.e. from server state); only the request-local result banner
    // lives here.
    let trickplayResult = $state<{
        success: boolean;
        runId?: string;
        message: string;
    } | null>(null);
    let syncResult = $state<{
        updated: boolean;
        fieldsChanged: string[];
        seasonsSynced?: number;
        episodesSynced?: number;
    } | null>(null);

    // External ID management state
    let liveIds = $state<ExternalIdRow[]>([]);
    let idsLoaded = $state(false);
    let idsLoading = $state(false);
    let editingProvider = $state<string | null>(null);
    let editValue = $state('');
    let deletingProvider = $state<string | null>(null);
    let showAddForm = $state(false);
    let addProvider = $state('');
    let addValue = $state('');
    let savingId = $state(false);
    let exchangeOpen = $state(false);
    let exchangeOtherId = $state('');
    let exchangePreview = $state<EpisodeTmdbExchangePreview | null>(null);
    let exchangeSaved = $state<EpisodeTmdbExchangePreview | null>(null);
    let exchangeCandidates = $state<
        {
            id: string;
            title: string | null;
            season_number: number | null;
            episode_number: number | null;
        }[]
    >([]);
    let exchangeLoading = $state(false);
    let exchangeBusy = $state(false);
    let exchangeError = $state<string | null>(null);

    $effect(() => {
        const id = mediaId;
        const series = parentSeriesId;
        if (!exchangeOpen) return;
        let cancelled = false;
        untrack(() => {
            exchangeOtherId = '';
            exchangeCandidates = [];
            exchangePreview = null;
            exchangeSaved = null;
            exchangeError = null;
            exchangeLoading = true;
        });
        if (series) {
            void getAdminEpisodes(series)
                .then((result) => {
                    if (cancelled) return;
                    exchangeLoading = false;
                    if (result.data)
                        exchangeCandidates = result.data.episodes.filter(
                            (episode) => episode.id !== id,
                        );
                    else exchangeError = m.media_sync_exchange_preview_failed();
                })
                .catch(() => {
                    if (!cancelled) {
                        exchangeLoading = false;
                        exchangeError = m.media_sync_exchange_preview_failed();
                    }
                });
        } else
            untrack(() => {
                exchangeLoading = false;
                exchangeError = m.media_sync_exchange_preview_failed();
            });
        return () => {
            cancelled = true;
        };
    });

    async function undoExchange(): Promise<void> {
        const saved = exchangeSaved ?? exchangePreview;
        if (!saved?.undoId || exchangeBusy) return;
        exchangeBusy = true;
        try {
            const result = await confirmEpisodeTmdbExchange(
                saved.first.id,
                saved.second.id,
                saved.snapshot,
                saved.undoId,
            );
            if (saved.first.id !== mediaId) return;
            if (!result.data) {
                exchangeError = result.error ?? m.media_p5_undo_conflict();
                return;
            }
            exchangeSaved = null;
            exchangePreview = null;
            await loadExternalIds();
            onsaved?.();
        } catch {
            exchangeError = m.media_p5_undo_conflict();
        } finally {
            exchangeBusy = false;
        }
    }

    async function reviewExchange(): Promise<void> {
        if (exchangeBusy || !exchangeOtherId.trim()) return;
        const otherId = exchangeOtherId.trim();
        const firstId = mediaId;
        exchangeBusy = true;
        exchangeError = null;
        exchangePreview = null;
        exchangeSaved = null;
        try {
            const { data, error } = await previewEpisodeTmdbExchange(firstId, otherId);
            if (firstId !== mediaId || otherId !== exchangeOtherId.trim()) return;
            if (data) exchangePreview = data;
            else exchangeError = error ?? m.media_sync_exchange_preview_failed();
        } catch {
            exchangeError = m.media_sync_exchange_preview_failed();
        } finally {
            exchangeBusy = false;
        }
    }

    async function saveExchange(): Promise<void> {
        const reviewed = exchangePreview;
        if (
            exchangeBusy ||
            !reviewed ||
            reviewed.first.id !== mediaId ||
            reviewed.second.id !== exchangeOtherId.trim()
        )
            return;
        exchangeBusy = true;
        exchangeError = null;
        try {
            const { data, error } = await confirmEpisodeTmdbExchange(
                reviewed.first.id,
                reviewed.second.id,
                reviewed.snapshot,
            );
            if (reviewed.first.id !== mediaId || reviewed.second.id !== exchangeOtherId.trim())
                return;
            if (data) {
                exchangeSaved = data;
                exchangePreview = null;
                await loadExternalIds();
                onsaved?.();
                toasts.success(m.media_sync_exchange_saved());
            } else {
                exchangeError = error ?? m.media_sync_exchange_conflict();
                exchangePreview = null;
            }
        } catch {
            exchangeError = m.media_sync_exchange_conflict();
            exchangePreview = null;
        } finally {
            exchangeBusy = false;
        }
    }

    // `audiobookshelf` is a first-class provider here, not an oddity: for an
    // AudiobookShelf book it is the ONLY external id, and it is the handle every
    // upstream action needs. Omitting it filed the one id that matters under
    // "unknown".
    const KNOWN_PROVIDERS = [
        'jellyfin',
        'tmdb',
        'imdb',
        'tvdb',
        'trakt',
        'sonarr',
        'radarr',
        'audiobookshelf',
    ];

    $effect(() => {
        // Track mediaId so effect re-runs when it changes
        const item = mediaId;
        if (item && hasLocalFiles) untrack(() => void loadSegments());
        return () => {
            segmentsLoadSeq++;
        };
    });

    // SSE intentionally omits native results. Every observation is verified by
    // canonical run ID; finite follow-up reads also cover a terminal event missed
    // by both SSE and the active listing. Epoch, subject, chronology and owned
    // request tokens fence responses independently of how the run was started.
    let analysisAttempt = 0;
    let acceptedAnalysisRunId: string | undefined;
    let enqueuePending = false;
    // Unknown enqueue IDs remain fenced even after input changes release controls.
    const pendingAnalysisEnqueues = new SvelteMap<number, string>();
    let observedInputKey: string | null = null;
    let observedInputChanged = false;
    let latestAnalysisRun: { id: string; startedAt: number } | undefined;
    let externalNotBefore = 0;
    let verificationToken = 0;
    let verifyingAnalysis: { id: string; token: number } | undefined;
    let checkingAnalysis = $state(false);
    let verificationController: AbortController | undefined;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    let automaticReads = 0;
    const settledAnalysisRuns = new SvelteMap<string, Run>();
    const ignoredAnalysisRuns = new SvelteSet<string>();

    function cancelAnalysisCheck(): void {
        clearTimeout(analysisTimer);
        analysisTimer = undefined;
        verificationToken += 1;
        verificationController?.abort();
        verificationController = undefined;
        verifyingAnalysis = undefined;
        checkingAnalysis = false;
    }

    function cancelAnalysisAttempt(): number {
        if (acceptedAnalysisRunId) ignoredAnalysisRuns.add(acceptedAnalysisRunId);
        if (latestAnalysisRun) ignoredAnalysisRuns.add(latestAnalysisRun.id);
        externalNotBefore = Math.max(externalNotBefore, latestAnalysisRun?.startedAt ?? 0);
        cancelAnalysisCheck();
        enqueuePending = false;
        acceptedAnalysisRunId = undefined;
        latestAnalysisRun = undefined;
        observedInputKey = null;
        observedInputChanged = false;
        settledAnalysisRuns.clear();
        generatingSegments = false;
        runningDeepAnalysis = false;
        return ++analysisAttempt;
    }

    $effect(() => {
        const subjectId = mediaId;
        untrack(() => {
            void subjectId;
            cancelAnalysisAttempt();
            knownInputKey = null;
            analysisInputs = null;
            segmentsData = null;
            ignoredAnalysisRuns.clear();
            externalNotBefore = 0;
            segmentsResult = null;
            deepAnalysisResult = null;
        });
        return () => {
            cancelAnalysisAttempt();
        };
    });

    function beginAnalysisAttempt(): number {
        const attempt = cancelAnalysisAttempt();
        enqueuePending = true;
        pendingAnalysisEnqueues.set(attempt, mediaId);
        observedInputKey = knownInputKey;
        segmentsResult = null;
        deepAnalysisResult = null;
        return attempt;
    }

    function scheduleAnalysisCheck(id: string, subjectId: string, attempt: number): void {
        clearTimeout(analysisTimer);
        analysisTimer = setTimeout(
            () => {
                analysisTimer = undefined;
                if (
                    attempt !== analysisAttempt ||
                    subjectId !== mediaId ||
                    latestAnalysisRun?.id !== id
                )
                    return;
                automaticReads += 1;
                void verifyAnalysis(id, subjectId);
            },
            automaticReads === 0 ? 1000 : automaticReads < 3 ? 5000 : 30_000,
        );
    }

    async function verifyAnalysis(id: string, subjectId: string): Promise<void> {
        if (subjectId !== mediaId || latestAnalysisRun?.id !== id || verifyingAnalysis?.id === id)
            return;
        clearTimeout(analysisTimer);
        const attempt = analysisAttempt;
        const token = ++verificationToken;
        const controller = new AbortController();
        verificationController = controller;
        const timer = setTimeout(() => controller.abort(), 10_000);
        let rejectAborted!: () => void;
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = () => reject(controller.signal.reason);
        });
        controller.signal.addEventListener('abort', rejectAborted, { once: true });
        verifyingAnalysis = { id, token };
        checkingAnalysis = true;
        const owns = (): boolean =>
            attempt === analysisAttempt &&
            subjectId === mediaId &&
            latestAnalysisRun?.id === id &&
            verifyingAnalysis?.token === token &&
            verificationToken === token;
        let message = m.media_sync_analysis_unverified();
        let success = false;
        let informational = false;
        let terminal = false;
        let retryable = true;
        let refreshSuperseded = false;
        try {
            const { data, status } = await Promise.race([
                apiGet(`/api/runs/${encodeURIComponent(id)}`, RunSchema, {
                    strict: true,
                    signal: controller.signal,
                    timeout: 10_000,
                }),
                aborted,
            ]);
            if (!owns()) return;
            if (
                data?.id !== id ||
                data.taskId !== ANALYZER_TASK_ID ||
                data.scope?.subjectType !== 'mediaItem' ||
                data.scope.subjectId !== subjectId
            ) {
                // Malformed/mismatched evidence fails closed; only transport uncertainty retries.
                retryable = !data && (!status || status >= 500);
            } else {
                runSSEBus.upsertRun(data);
                const startedAt = Date.parse(data.startedAt);
                if (Number.isFinite(startedAt)) latestAnalysisRun = { id, startedAt };
                terminal = ['completed', 'failed', 'cancelled'].includes(data.state);
                const native = data.result;
                let current: Awaited<ReturnType<typeof getMediaSegments>> | undefined;
                let currentProof = false;
                let sameObservedInput = false;
                if (terminal) {
                    const read = segmentsLoadSeq;
                    current = await Promise.race([getMediaSegments(subjectId), aborted]);
                    if (!owns()) return;
                    if (read !== segmentsLoadSeq) {
                        // A newer canonical refresh wins. Re-read after it rather
                        // than dropping the observed run or adopting older proof.
                        refreshSuperseded = true;
                        return;
                    }
                    const inputs = current.data?.analysisInputs;
                    currentProof =
                        !!inputs?.length &&
                        inputs.every(
                            (input) =>
                                input.state === 'ready' &&
                                input.proof?.runId === id &&
                                input.proof.inputIdentity === input.inputIdentity,
                        );
                    sameObservedInput =
                        !observedInputChanged &&
                        observedInputKey !== null &&
                        analysisInputKey(inputs ?? null) === observedInputKey;
                }
                if (terminal && !currentProof && !sameObservedInput) {
                    // An opaque identity change may be this run's reset or new
                    // bytes/config/window. Its failure cannot identify which.
                    informational = true;
                    message = m.media_sync_analysis_unverified();
                } else if (!terminal) {
                    informational = true;
                    message = m.media_sync_analysis_running();
                } else if (data.state === 'cancelled') message = m.media_sync_analysis_cancelled();
                else if (data.state === 'failed') message = m.media_sync_analysis_failed();
                else if (
                    typeof native === 'object' &&
                    native !== null &&
                    'result' in native &&
                    typeof native.result === 'object' &&
                    native.result !== null &&
                    'analysisOutcome' in native.result &&
                    native.result.analysisOutcome === 'skipped'
                ) {
                    informational = true;
                    message = m.media_sync_analysis_not_run();
                } else if (
                    typeof native === 'object' &&
                    native !== null &&
                    'result' in native &&
                    typeof native.result === 'object' &&
                    native.result !== null &&
                    'analysisOutcome' in native.result &&
                    (native.result.analysisOutcome === 'partial' ||
                        native.result.analysisOutcome === 'deferred')
                ) {
                    message =
                        native.result.analysisOutcome === 'deferred'
                            ? m.media_sync_analysis_deferred()
                            : m.media_sync_analysis_failed();
                } else if (
                    typeof native === 'object' &&
                    native !== null &&
                    'success' in native &&
                    native.success === false
                ) {
                    message = m.media_sync_analysis_failed();
                } else if (
                    typeof native === 'object' &&
                    native !== null &&
                    'success' in native &&
                    native.success === true &&
                    'itemsProcessed' in native &&
                    typeof native.itemsProcessed === 'number' &&
                    Number.isSafeInteger(native.itemsProcessed) &&
                    native.itemsProcessed >= 0 &&
                    !('stopReason' in native && native.stopReason) &&
                    'result' in native &&
                    typeof native.result === 'object' &&
                    native.result !== null &&
                    'segmentsProduced' in native.result &&
                    typeof native.result.segmentsProduced === 'number' &&
                    Number.isSafeInteger(native.result.segmentsProduced) &&
                    native.result.segmentsProduced >= 0 &&
                    'seasonsProcessed' in native.result &&
                    typeof native.result.seasonsProcessed === 'number' &&
                    Number.isSafeInteger(native.result.seasonsProcessed) &&
                    native.result.seasonsProcessed >= 0 &&
                    (!('analysisOutcome' in native.result) ||
                        native.result.analysisOutcome === 'completed' ||
                        native.result.analysisOutcome === 'no-detection')
                ) {
                    const inputs = current?.data?.analysisInputs;
                    success = currentProof;
                    if (success && current?.data) {
                        // The canonical proof can include this run's deep reset.
                        // Adopt its source and data together, fencing older reads.
                        segmentsLoadSeq += 1;
                        knownInputKey = analysisInputKey(inputs!);
                        observedInputKey = knownInputKey;
                        observedInputChanged = false;
                        analysisInputs = inputs!;
                        segmentsData = current.data;
                        segmentsError = null;
                        segmentsLoading = false;
                        message = inputs!.every((input) => input.proof?.segmentsCount === 0)
                            ? m.media_sync_analysis_no_detection()
                            : m.media_sync_analysis_completed();
                    } else {
                        informational = true;
                        message = m.media_sync_analysis_unverified();
                    }
                }
                if (terminal) retryable = false;
            }
            if (!owns()) return;
            deepAnalysisResult = null;
            segmentsResult = {
                success,
                pending: informational,
                message,
                runId: id,
                checkAgain:
                    message === m.media_sync_analysis_unverified() || (!terminal && retryable),
            };
            if (terminal) {
                if (acceptedAnalysisRunId === id) acceptedAnalysisRunId = undefined;
                ignoredAnalysisRuns.add(id);
                if (success) toasts.success(message);
                else if (informational) toasts.info(message);
                else toasts.error(message);
                void loadSegments();
            }
        } catch {
            if (!owns()) return;
            deepAnalysisResult = null;
            segmentsResult = { success: false, message, runId: id, checkAgain: true };
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', rejectAborted);
            if (verificationController === controller) verificationController = undefined;
            // An old response may not release a newer run's in-flight ownership.
            if (verifyingAnalysis?.token === token) {
                verifyingAnalysis = undefined;
                checkingAnalysis = false;
                if ((!retryable || automaticReads >= 3) && acceptedAnalysisRunId === id)
                    acceptedAnalysisRunId = undefined;
                if (
                    refreshSuperseded &&
                    automaticReads < 3 &&
                    attempt === analysisAttempt &&
                    subjectId === mediaId &&
                    latestAnalysisRun?.id === id
                ) {
                    automaticReads += 1;
                    void verifyAnalysis(id, subjectId);
                } else if (
                    retryable &&
                    attempt === analysisAttempt &&
                    subjectId === mediaId &&
                    latestAnalysisRun?.id === id
                )
                    scheduleAnalysisCheck(id, subjectId, attempt);
            }
        }
    }

    function settleAnalysis(run: Run, subjectId: string): void {
        if (
            run.taskId !== ANALYZER_TASK_ID ||
            run.scope?.subjectType !== 'mediaItem' ||
            run.scope.subjectId !== subjectId ||
            subjectId !== mediaId ||
            ignoredAnalysisRuns.has(run.id)
        )
            return;
        settledAnalysisRuns.set(run.id, run);
        if (
            enqueuePending ||
            (acceptedAnalysisRunId !== run.id &&
                [...pendingAnalysisEnqueues.values()].includes(subjectId))
        )
            return;
        if (acceptedAnalysisRunId && acceptedAnalysisRunId !== run.id) return;
        const startedAt = Date.parse(run.startedAt);
        if (
            !Number.isFinite(startedAt) ||
            (!acceptedAnalysisRunId && startedAt < externalNotBefore) ||
            (latestAnalysisRun &&
                latestAnalysisRun.id !== run.id &&
                startedAt <= latestAnalysisRun.startedAt)
        )
            return;
        if (latestAnalysisRun?.id !== run.id) {
            cancelAnalysisCheck();
            automaticReads = 0;
            observedInputKey = knownInputKey;
            observedInputChanged = false;
        }
        latestAnalysisRun = { id: run.id, startedAt };
        segmentsResult = null;
        deepAnalysisResult = null;
        void verifyAnalysis(run.id, subjectId);
    }

    function finishAnalysisEnqueue(attempt: number, subjectId: string): void {
        pendingAnalysisEnqueues.delete(attempt);
        if (subjectId !== mediaId) return;
        if (attempt === analysisAttempt) enqueuePending = false;
        if (attempt !== analysisAttempt || !acceptedAnalysisRunId) {
            // Replay only after every unknown ID for this subject is resolved.
            // Source-change chronology and ignored IDs still reject old work.
            if (![...pendingAnalysisEnqueues.values()].includes(subjectId)) {
                for (const run of settledAnalysisRuns.values()) settleAnalysis(run, subjectId);
            }
            return;
        }
        const id = acceptedAnalysisRunId;
        const earlyTerminal = settledAnalysisRuns.get(id);
        if (earlyTerminal) settleAnalysis(earlyTerminal, subjectId);
        else {
            latestAnalysisRun = { id, startedAt: 0 };
            automaticReads = 0;
            scheduleAnalysisCheck(id, subjectId, attempt);
        }
    }

    function checkAnalysisAgain(): void {
        if (!latestAnalysisRun) return;
        automaticReads = 0;
        void verifyAnalysis(latestAnalysisRun.id, mediaId);
    }

    $effect(() => {
        const subjectId = mediaId;
        return tracker.onSettled((run) => {
            if (run.taskId === ANALYZER_TASK_ID) {
                void settleAnalysis(run, subjectId);
            } else {
                const succeeded =
                    run.state === 'completed' &&
                    run.result &&
                    typeof run.result === 'object' &&
                    'success' in run.result &&
                    run.result.success === true;
                if (run.taskId === TRICKPLAY_TASK_ID && trickplayResult?.runId === run.id)
                    trickplayResult = {
                        success: !!succeeded,
                        runId: run.id,
                        message: succeeded
                            ? m.media_p5_seek_finished()
                            : m.media_p5_artwork_uncertain(),
                    };
                if (run.taskId === EPISODE_THUMBS_TASK_ID && episodeThumbsResult?.runId === run.id)
                    episodeThumbsResult = {
                        success: !!succeeded,
                        runId: run.id,
                        message: succeeded
                            ? m.media_season_thumbnails_complete()
                            : m.media_p5_artwork_uncertain(),
                    };
                if (run.taskId === CHAPTER_SYNC_TASK_ID && chapterSyncResult?.runId === run.id) {
                    chapterSyncResult = {
                        success: !!succeeded,
                        message: succeeded
                            ? m.media_p5_chapters_finished()
                            : m.media_p5_artwork_uncertain(),
                    };
                    onsaved?.();
                }
                if (
                    ['media-probe', 'chapter-sync', 'series-sync', 'file-system-scan'].includes(
                        run.taskId,
                    )
                )
                    void loadSegments({ quiet: true });
                const label = run.label || run.taskId;
                if (run.state === 'completed' && succeeded)
                    toasts.success(m.media_sync_task_finished({ label }));
                else if (run.state === 'completed') toasts.info(m.media_p5_artwork_uncertain());
                else if (run.state === 'failed') toasts.error(m.media_sync_task_failed({ label }));
                else toasts.info(m.media_sync_task_cancelled({ label }));
            }
            if (run.taskId === EPISODE_THUMBS_TASK_ID) onsaved?.();
            void invalidate('media:runs');
        });
    });

    // Incremental segment refresh while an analysis is running.
    //
    // NOT run-state polling — the tracker owns that over SSE. This refreshes
    // DOMAIN data: the analyzer writes segments per episode as it goes, and the
    // poller this replaced called loadSegments() roughly every 10s so partial
    // results appeared while the run was still in flight. Reloading only on
    // the terminal transition lost that, leaving a long series analysis looking
    // frozen for minutes at a time.
    //
    // Reads `analyzerRunning` (re-derived on every bus change), not
    // tracker.isActive() directly: that is a plain method, so the effect never
    // re-ran when an analysis started or ended after mount.
    $effect(() => {
        if (!analyzerRunning || !hasLocalFiles) return;
        const timer = setInterval(() => void loadSegments({ quiet: true }), 10_000);
        return () => clearInterval(timer);
    });

    $effect(() => {
        const item = mediaId;
        if (!browser || !hasLocalFiles || analyzerRunning) return;
        return startVisibleRefresh(async () => {
            if (item === mediaId) await loadSegments({ quiet: true });
        });
    });

    let hasProvider = $derived(!!externalIds?.tmdb);
    let providerLabel = $derived(externalIds?.tmdb ? `TMDB #${externalIds.tmdb}` : null);
    // Truthy whenever an analyzer request is in flight OR a run for this media
    // item is live on the server. Buttons (Generate / Fingerprint / Refresh /
    // Clear) stay disabled while this is true — including for a run someone
    // else started.
    let analyzerBusy = $derived(generatingSegments || runningDeepAnalysis || analyzerRunning);
    let segmentMutationBusy = $derived(clearingSegments || savingManualSegment);

    async function loadExternalIds(): Promise<void> {
        if (idsLoading) return;
        idsLoading = true;
        try {
            const { data, error } = await getMediaExternalIds(mediaId);
            if (data) {
                liveIds = data.externalIds;
                idsLoaded = true;
            } else if (error) {
                toasts.error(m.media_sync_load_external_ids_failed());
            }
        } catch {
            toasts.error(m.media_sync_load_external_ids_failed());
        } finally {
            idsLoading = false;
        }
    }

    function startEdit(row: ExternalIdRow): void {
        editingProvider = row.provider;
        editValue = row.external_id;
        deletingProvider = null;
    }

    function cancelEdit(): void {
        editingProvider = null;
        editValue = '';
    }

    async function saveEdit(provider: string): Promise<void> {
        // savingId also guards the Enter key path, which bypasses the
        // disabled Save button.
        if (savingId || !editValue.trim()) return;
        const sent = editValue.trim();
        savingId = true;
        let saved = false;
        try {
            const { data, error } = await upsertMediaExternalId(mediaId, {
                provider,
                externalId: sent,
            });
            if (data) {
                saved = true;
                liveIds = liveIds.map((r) =>
                    r.provider === provider ? { ...r, external_id: sent } : r,
                );
                // Close only the edit this save belongs to, and only if
                // nothing was typed while it ran.
                if (editingProvider === provider && editValue.trim() === sent) {
                    editingProvider = null;
                    editValue = '';
                }
                toasts.success(m.media_sync_external_id_updated());
            } else if (error) {
                toasts.error(m.media_sync_update_external_id_failed());
            }
        } catch {
            toasts.error(m.media_sync_update_external_id_failed());
        } finally {
            savingId = false;
        }
        // The page's externalIds (Sync from provider, the summary) come from
        // the route load.
        if (saved) onsaved?.();
    }

    function confirmDelete(provider: string): void {
        deletingProvider = provider;
        editingProvider = null;
    }

    function cancelDelete(): void {
        deletingProvider = null;
    }

    async function deleteId(provider: string): Promise<void> {
        if (savingId) return;
        savingId = true;
        let saved = false;
        try {
            const { data, error } = await deleteMediaExternalId(mediaId, provider);
            if (data) {
                saved = true;
                liveIds = liveIds.filter((r) => r.provider !== provider);
                deletingProvider = null;
                toasts.success(m.media_sync_external_id_removed());
            } else if (error) {
                toasts.error(m.media_sync_remove_external_id_failed());
            }
        } catch {
            toasts.error(m.media_sync_remove_external_id_failed());
        } finally {
            savingId = false;
        }
        if (saved) onsaved?.();
    }

    function openAddForm(): void {
        showAddForm = true;
        addProvider = '';
        addValue = '';
    }

    function cancelAdd(): void {
        showAddForm = false;
        addProvider = '';
        addValue = '';
    }

    async function saveAdd(): Promise<void> {
        if (savingId || !addProvider || !addValue.trim()) return;
        const provider = addProvider;
        const sent = addValue.trim();
        savingId = true;
        let saved = false;
        try {
            const { data, error } = await upsertMediaExternalId(mediaId, {
                provider,
                externalId: sent,
            });
            if (data) {
                saved = true;
                await loadExternalIds();
                if (addProvider === provider && addValue.trim() === sent) {
                    showAddForm = false;
                    addProvider = '';
                    addValue = '';
                }
                toasts.success(m.media_sync_external_id_added());
            } else if (error) {
                toasts.error(m.media_sync_add_external_id_failed());
            }
        } catch {
            toasts.error(m.media_sync_add_external_id_failed());
        } finally {
            savingId = false;
        }
        if (saved) onsaved?.();
    }

    function formatTime(seconds: number): string {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatEpisodeCode(segment: { seasonNumber?: number; episodeNumber?: number }): string {
        if (segment.seasonNumber === undefined || segment.episodeNumber === undefined) return '—';
        return `S${String(segment.seasonNumber).padStart(2, '0')}E${String(
            segment.episodeNumber,
        ).padStart(2, '0')}`;
    }

    let segmentsLoadSeq = 0;
    function analysisInputKey(inputs: AnalyzerReadiness[] | null): string | null {
        return inputs
            ? JSON.stringify(inputs.map((input) => [input.mediaId, input.inputIdentity]))
            : null;
    }

    /**
     * `quiet` is the background refresh while an analysis runs: it keeps the
     * current list on screen instead of swapping it for the loading state.
     */
    async function loadSegments(opts: { quiet?: boolean } = {}): Promise<void> {
        const seq = ++segmentsLoadSeq;
        const subjectId = mediaId;
        if (!opts.quiet) segmentsLoading = true;
        segmentsError = null;
        try {
            const { data, error, status } = await getMediaSegments(subjectId);
            // Overlapping loads (a poll and a Refresh) must not land out of order.
            if (seq !== segmentsLoadSeq || subjectId !== mediaId) return;
            if (data) {
                segmentUndoId = data.undoId;
                const inputs = data.analysisInputs ?? null;
                const key = analysisInputKey(inputs);
                if (knownInputKey !== null && key !== knownInputKey) {
                    const observing =
                        acceptedAnalysisRunId ||
                        (latestAnalysisRun && !ignoredAnalysisRuns.has(latestAnalysisRun.id));
                    if (observing) {
                        // Keep observation across an owned deep reset. Only a
                        // matching canonical proof can make its outcome current.
                        observedInputChanged = true;
                    } else {
                        externalNotBefore = Math.max(externalNotBefore, Date.now());
                        cancelAnalysisAttempt();
                    }
                    if (segmentsResult)
                        segmentsResult = {
                            ...segmentsResult,
                            success: false,
                            pending: true,
                            checkAgain: !!observing,
                            message: observing
                                ? m.media_sync_analysis_unverified()
                                : m.media_source_earlier_result(),
                        };
                }
                knownInputKey = key;
                analysisInputs = inputs;
                segmentsData = data;
            } else {
                segmentsError = error
                    ? m.media_sync_load_segments_failed_status({ status })
                    : m.media_sync_load_segments_failed();
            }
        } catch {
            if (seq === segmentsLoadSeq) segmentsError = m.media_sync_load_segments_failed();
        } finally {
            if (seq === segmentsLoadSeq) segmentsLoading = false;
        }
    }

    async function runDeepAnalysis(): Promise<TaskStartResult> {
        return startAnalysis('deep');
    }

    async function startAnalysis(
        scope: 'deep' | 'single' | 'children',
        outroOnly = false,
    ): Promise<TaskStartResult> {
        const subjectId = mediaId;
        const attempt = beginAnalysisAttempt();
        if (scope === 'deep') runningDeepAnalysis = true;
        else generatingSegments = true;
        try {
            const response = outroOnly
                ? await generateMediaSegments(subjectId, scope, { outroOnly: true })
                : await generateMediaSegments(subjectId, scope);
            if (attempt !== analysisAttempt || subjectId !== mediaId) {
                const obsoleteId = response.data?.runId;
                if (
                    subjectId === mediaId &&
                    obsoleteId &&
                    obsoleteId !== acceptedAnalysisRunId &&
                    obsoleteId !== latestAnalysisRun?.id
                )
                    ignoredAnalysisRuns.add(obsoleteId);
                if (obsoleteId && ignoredAnalysisRuns.has(obsoleteId))
                    settledAnalysisRuns.delete(obsoleteId);
                return;
            }
            const { data, error, status } = response;
            if (error || !data || !data.runId.trim()) {
                segmentsResult = {
                    success: false,
                    message: status ? `HTTP ${status}` : (error ?? m.media_sync_request_failed()),
                };
                toasts.error(segmentsResult.message);
                return;
            }
            acceptedAnalysisRunId = data.runId;
            // A deduped run may predate this invocation's input snapshot.
            observedInputChanged = observedInputChanged || !!data.deduped;
            ignoredAnalysisRuns.delete(data.runId);
            segmentsResult = {
                success: false,
                pending: true,
                runId: data.runId,
                message: m.media_sync_analysis_queued(),
                checkAgain: true,
            };
            if (!data.deduped) toasts.info(m.media_sync_analysis_queued());
            return { deduped: data.deduped };
        } catch {
            if (attempt !== analysisAttempt || subjectId !== mediaId) return;
            segmentsResult = { success: false, message: m.media_sync_request_failed() };
            toasts.error(segmentsResult.message);
        } finally {
            finishAnalysisEnqueue(attempt, subjectId);
            if (attempt === analysisAttempt && subjectId === mediaId) {
                runningDeepAnalysis = false;
                generatingSegments = false;
            }
        }
    }

    async function undoMarkers(): Promise<void> {
        if (!segmentUndoId || clearingSegments || savingManualSegment) return;
        const id = mediaId;
        clearingSegments = true;
        try {
            const result = await undoMediaSegments(id, segmentUndoId);
            if (id !== mediaId) return;
            if (!result.data) {
                toasts.error(result.error ?? m.media_p5_undo_conflict());
                return;
            }
            await loadSegments();
            onsaved?.();
        } catch {
            if (id === mediaId) toasts.error(m.media_p5_undo_conflict());
        } finally {
            if (id === mediaId) clearingSegments = false;
        }
    }

    async function clearSegments(): Promise<void> {
        clearingSegments = true;
        try {
            const { data, error } = await clearMediaSegments(mediaId);
            if (data) {
                segmentUndoId = data.undoId;
                toasts.success(m.media_p5_markers_removed());
                segmentsResult = null;
                deepAnalysisResult = null;
                // Reload rather than null the data: a null list rendered
                // neither the rows nor the empty message.
                await loadSegments();
            } else if (error) {
                toasts.error(m.media_sync_clear_segments_failed());
            }
        } catch {
            toasts.error(m.media_sync_clear_segments_failed());
        } finally {
            clearingSegments = false;
        }
    }

    async function clearOutros(): Promise<void> {
        clearingSegments = true;
        try {
            const { data, error } = await clearMediaSegments(mediaId, 'Outro');
            if (data) {
                segmentUndoId = data.undoId;
                toasts.success(m.media_p5_markers_removed());
                await loadSegments();
            } else if (error) {
                toasts.error(m.media_sync_clear_segments_failed());
            }
        } catch {
            toasts.error(m.media_sync_clear_segments_failed());
        } finally {
            clearingSegments = false;
        }
    }

    async function generateSegments(): Promise<TaskStartResult> {
        return startAnalysis(isSeriesOrSeason ? 'children' : 'single');
    }

    async function generateOutros(): Promise<TaskStartResult> {
        return startAnalysis(isSeriesOrSeason ? 'children' : 'single', true);
    }

    async function saveManualSegment(): Promise<void> {
        if (manualStartTime === null || manualEndTime === null) {
            manualSegmentMessage = {
                success: false,
                message: m.media_sync_manual_segment_times_required(),
            };
            return;
        }
        const startTime = manualStartTime;
        const endTime = manualEndTime;
        if (
            !Number.isFinite(startTime) ||
            !Number.isFinite(endTime) ||
            startTime < 0 ||
            endTime <= startTime
        ) {
            manualSegmentMessage = {
                success: false,
                message: m.media_sync_manual_segment_invalid_range(),
            };
            return;
        }
        savingManualSegment = true;
        manualSegmentMessage = null;
        try {
            const { data, error } = await setMediaSegment(mediaId, {
                type: manualSegmentType,
                startMs: Math.round(startTime * 1000),
                endMs: Math.round(endTime * 1000),
            });
            if (data) {
                manualSegmentMessage = { success: true, message: data.message };
                toasts.success(data.message);
                await loadSegments();
            } else {
                manualSegmentMessage = {
                    success: false,
                    message: error ?? m.media_sync_manual_segment_save_failed(),
                };
                toasts.error(manualSegmentMessage.message);
            }
        } catch {
            manualSegmentMessage = {
                success: false,
                message: m.media_sync_manual_segment_save_failed(),
            };
            toasts.error(manualSegmentMessage.message);
        } finally {
            savingManualSegment = false;
        }
    }

    async function generateEpisodeThumbs(): Promise<TaskStartResult> {
        const subjectId = mediaId;
        const owner = tracker;
        episodeThumbsResult = null;
        try {
            const scope = checkIsSeason(mediaType)
                ? 'season'
                : checkIsSeries(mediaType)
                  ? 'series'
                  : 'episode';
            const { data, error } = await regenerateEpisodeThumbnails(subjectId, {
                scope,
            });
            if (subjectId !== mediaId || owner !== tracker) return;
            if (data) {
                episodeThumbsResult = {
                    success: true,
                    runId: data.runId,
                    message: m.media_season_thumbnails_queued(),
                };
                if (!data.deduped) toasts.success(m.media_sync_episode_thumbs_queued());
                return { deduped: data.deduped, runId: data.runId };
            }
            episodeThumbsResult = {
                success: false,
                message: error ?? m.media_sync_request_failed(),
            };
            toasts.error(m.media_sync_episode_thumbs_queue_failed());
        } catch {
            if (subjectId !== mediaId || owner !== tracker) return;
            episodeThumbsResult = { success: false, message: m.media_sync_request_failed() };
            toasts.error(m.media_sync_episode_thumbs_queue_failed());
        }
    }

    async function syncChapters(): Promise<TaskStartResult> {
        const subjectId = mediaId;
        const owner = tracker;
        chapterSyncResult = null;
        try {
            const { data, error } = await syncChaptersApi(subjectId);
            if (subjectId !== mediaId || owner !== tracker) return;
            if (data?.started) {
                chapterSyncResult = {
                    success: true,
                    runId: data.runId,
                    message: m.media_sync_chapter_sync_queued_message(),
                };
                if (!data.deduped) toasts.success(m.media_sync_chapter_sync_enqueued());
                return { deduped: data.deduped, runId: data.runId };
            }
            chapterSyncResult = {
                success: false,
                message: error ?? m.media_sync_chapter_sync_queue_failed(),
            };
            toasts.error(m.media_sync_chapter_sync_failed());
        } catch {
            if (subjectId !== mediaId || owner !== tracker) return;
            chapterSyncResult = { success: false, message: m.media_sync_request_failed() };
            toasts.error(m.media_sync_chapter_sync_failed());
        }
    }

    async function handleSync(): Promise<TaskStartResult> {
        syncing = true;
        syncResult = null;
        progressMessage = null;

        try {
            // Only the "+ children" path enqueues a `series-sync` run; a
            // single-item sync still runs inline and returns nothing to track.
            if (isSeries && includeChildren) {
                return await handleStreamingSync();
            }
            await handleSimpleSync();
        } finally {
            syncing = false;
            progressMessage = null;
        }
    }

    function onlineFieldLabel(field: string): string {
        const labels: Record<string, string> = {
            title: m.media_p5_field_title(),
            year: m.media_p5_field_year(),
            overview: m.media_p5_field_description(),
        };
        return labels[field] ?? m.media_p5_field_other();
    }

    async function handleSimpleSync(): Promise<void> {
        const subjectId = mediaId;
        const owner = tracker;
        const { data, error } = await syncMediaMetadata(subjectId, false);
        if (subjectId !== mediaId || owner !== tracker) return;
        if (error || !data) {
            toasts.error(m.media_sync_sync_failed());
            return;
        }
        syncResult = {
            updated: data.updated,
            fieldsChanged: data.fieldsChanged ?? [],
        };
        if (data.updated) {
            toasts.success(m.media_sync_metadata_synced());
            onsaved?.();
        }
    }

    async function generateTrickplay(): Promise<TaskStartResult> {
        const subjectId = mediaId;
        const owner = tracker;
        trickplayResult = null;
        try {
            const { data, error } = await generateTrickplayApi(subjectId, {
                force: true,
            });
            if (subjectId !== mediaId || owner !== tracker) return;
            if (data) {
                trickplayResult = {
                    success: true,
                    runId: data.runId,
                    message: m.media_sync_trickplay_queued(),
                };
                if (!data.deduped) toasts.success(m.media_sync_trickplay_queued());
                return { deduped: data.deduped, runId: data.runId };
            }
            trickplayResult = {
                success: false,
                message: error ?? m.media_sync_request_failed(),
            };
            toasts.error(m.media_sync_trickplay_queue_failed());
        } catch {
            if (subjectId !== mediaId || owner !== tracker) return;
            trickplayResult = {
                success: false,
                message: m.media_sync_request_failed(),
            };
            toasts.error(m.media_sync_trickplay_queue_failed());
        }
    }

    async function handleStreamingSync(): Promise<TaskStartResult> {
        const subjectId = mediaId;
        const owner = tracker;
        const { data, error } = await syncMediaMetadataEnqueue(subjectId);
        if (subjectId !== mediaId || owner !== tracker) return;
        if (error || !data) {
            toasts.error(m.media_sync_series_sync_enqueue_failed());
            return;
        }
        if (!data.deduped) toasts.success(m.media_sync_series_sync_enqueued());
        return { deduped: data.deduped, runId: data.runId };
    }
</script>

<div class="space-y-6">
    {#if taskSection !== 'processing'}
        <div>
            <h3 class="text-lg font-semibold text-white">{m.media_sync_metadata_sync_heading()}</h3>
            <p class="text-sm text-surface-400 mt-1">
                {m.media_sync_metadata_sync_description()}
            </p>
        </div>

        <!-- External IDs management -->
        <div class="rounded-lg bg-surface-800/60 border border-surface-700/50 p-4">
            <div class="flex items-center justify-between mb-3">
                <h4 class="text-xs text-surface-400 font-medium uppercase tracking-wide">
                    {m.media_sync_external_ids_heading()}
                </h4>
                {#if !idsLoaded}
                    <button
                        onclick={loadExternalIds}
                        disabled={idsLoading}
                        class="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50">
                        {idsLoading ? m.media_sync_loading() : m.media_sync_manage()}
                    </button>
                {/if}
            </div>

            {#if !idsLoaded}
                <!-- Read-only summary (initial state) -->
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                    {#if externalIds?.internal}
                        <div>
                            <span class="text-surface-500">{m.media_sync_internal_label()}</span>
                            <span class="text-surface-300 ml-1 font-mono text-xs"
                                >{externalIds.internal}</span>
                        </div>
                    {/if}
                    {#if externalIds?.tmdb}
                        {@const link = tmdbIdentityUrl(mediaType, externalIds.tmdb, tmdbContext)}
                        <div>
                            <span class="text-surface-500">{m.admin_tmdb()}</span>
                            {#if link}<a
                                    href={link}
                                    target="_blank"
                                    rel="noopener"
                                    class="text-primary-400 hover:text-primary-300 ml-1"
                                    >{externalIds.tmdb}</a>
                            {:else}<span class="ml-1 select-all break-all font-mono text-xs"
                                    >TMDB · {mediaType} · {externalIds.tmdb}</span
                                >{/if}
                        </div>
                    {/if}
                    {#if externalIds?.imdb}
                        <div>
                            <span class="text-surface-500">IMDB:</span>
                            <a
                                href="https://www.imdb.com/title/{externalIds.imdb}"
                                target="_blank"
                                rel="noopener"
                                class="text-primary-400 hover:text-primary-300 ml-1">
                                {externalIds.imdb}
                            </a>
                        </div>
                    {/if}
                    {#if externalIds?.jellyfin}
                        <div>
                            <span class="text-surface-500">Jellyfin:</span>
                            <span class="text-surface-300 ml-1 font-mono text-xs"
                                >{externalIds.jellyfin}</span>
                        </div>
                    {/if}
                    {#if externalIds?.tvdb}
                        <div>
                            <span class="text-surface-500">TVDB:</span>
                            <span class="text-surface-300 ml-1">{externalIds.tvdb}</span>
                        </div>
                    {/if}
                </div>
            {:else}
                <!-- Editable list -->
                <div class="space-y-1">
                    {#if liveIds.length === 0}
                        <p class="text-xs text-surface-500 italic">
                            {m.media_sync_no_external_ids()}
                        </p>
                    {/if}
                    {#each liveIds as row (row.provider)}
                        <div class="flex items-center gap-2 py-1">
                            <span
                                class="text-xs text-surface-400 w-20 shrink-0 font-mono uppercase">
                                {row.provider}
                            </span>

                            {#if editingProvider === row.provider}
                                <!-- Edit mode -->
                                <input
                                    type="text"
                                    bind:value={editValue}
                                    class="flex-1 bg-surface-700 border border-surface-600 rounded px-2 py-0.5 text-xs text-surface-200 focus:outline-none focus:border-primary-500"
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter') saveEdit(row.provider);
                                        if (e.key === 'Escape') cancelEdit();
                                    }} />
                                <button
                                    onclick={() => saveEdit(row.provider)}
                                    disabled={savingId}
                                    class="p-1 text-green-400 hover:text-green-300 disabled:opacity-50"
                                    title={m.media_sync_save_title()}>
                                    <Icon src={Check} class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onclick={cancelEdit}
                                    class="p-1 text-surface-400 hover:text-surface-200"
                                    title={m.media_sync_cancel_title()}>
                                    <Icon src={XMark} class="w-3.5 h-3.5" />
                                </button>
                            {:else if deletingProvider === row.provider}
                                <!-- Delete confirmation -->
                                <span class="flex-1 text-xs text-amber-400">
                                    {m.media_sync_remove_id_confirm({ provider: row.provider })}
                                </span>
                                <button
                                    onclick={() => deleteId(row.provider)}
                                    disabled={savingId}
                                    class="px-2 py-0.5 text-xs bg-red-600/20 border border-red-600/40 text-red-400 hover:bg-red-600/30 rounded disabled:opacity-50">
                                    {m.btn_remove()}
                                </button>
                                <button
                                    onclick={cancelDelete}
                                    class="p-1 text-surface-400 hover:text-surface-200"
                                    title={m.media_sync_cancel_title()}>
                                    <Icon src={XMark} class="w-3.5 h-3.5" />
                                </button>
                            {:else}
                                <!-- Read mode -->
                                {@const link =
                                    row.provider === 'tmdb'
                                        ? tmdbIdentityUrl(mediaType, row.external_id, tmdbContext)
                                        : null}
                                {#if link}<a
                                        class="min-w-0 flex-1 break-all text-xs text-primary-300"
                                        href={link}
                                        target="_blank"
                                        rel="noopener">TMDB · {mediaType} · {row.external_id}</a>
                                {:else}<span
                                        class="min-w-0 flex-1 select-all break-all text-xs text-surface-300 font-mono"
                                        >{row.provider === 'tmdb'
                                            ? `TMDB · ${mediaType} · `
                                            : ''}{row.external_id}</span
                                    >{/if}
                                <button
                                    onclick={() => startEdit(row)}
                                    class="p-1 text-surface-500 hover:text-surface-200"
                                    title={m.media_sync_edit_title()}>
                                    <Icon src={PencilSquare} class="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onclick={() => confirmDelete(row.provider)}
                                    class="p-1 text-surface-500 hover:text-red-400"
                                    title={m.media_sync_delete_title()}>
                                    <Icon src={Trash} class="w-3.5 h-3.5" />
                                </button>
                            {/if}
                        </div>
                    {/each}

                    <!-- Add form -->
                    {#if showAddForm}
                        <div
                            class="flex items-center gap-2 pt-2 border-t border-surface-700/50 mt-2">
                            <select
                                bind:value={addProvider}
                                class="bg-surface-700 border border-surface-600 rounded px-2 py-0.5 text-xs text-surface-200 focus:outline-none focus:border-primary-500 w-24">
                                <option value="">{m.media_sync_provider_placeholder()}</option>
                                {#each KNOWN_PROVIDERS as p (p)}
                                    <option value={p}>{p}</option>
                                {/each}
                            </select>
                            <input
                                type="text"
                                bind:value={addValue}
                                placeholder={m.media_sync_id_value_placeholder()}
                                class="flex-1 bg-surface-700 border border-surface-600 rounded px-2 py-0.5 text-xs text-surface-200 focus:outline-none focus:border-primary-500"
                                onkeydown={(e) => {
                                    if (e.key === 'Enter') saveAdd();
                                    if (e.key === 'Escape') cancelAdd();
                                }} />
                            <button
                                onclick={saveAdd}
                                disabled={savingId || !addProvider || !addValue.trim()}
                                class="p-1 text-green-400 hover:text-green-300 disabled:opacity-50"
                                title={m.media_sync_add_title()}>
                                <Icon src={Check} class="w-3.5 h-3.5" />
                            </button>
                            <button
                                onclick={cancelAdd}
                                class="p-1 text-surface-400 hover:text-surface-200"
                                title={m.media_sync_cancel_title()}>
                                <Icon src={XMark} class="w-3.5 h-3.5" />
                            </button>
                        </div>
                    {:else}
                        <button
                            onclick={openAddForm}
                            class="mt-2 flex items-center gap-1 text-xs text-surface-500 hover:text-primary-400">
                            <Icon src={Plus} class="w-3.5 h-3.5" />
                            {m.media_sync_add_external_id()}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>

        {#if isEpisode}
            <div class="rounded-lg bg-surface-800/60 border border-surface-700/50 p-4 space-y-3">
                <button
                    class="text-sm text-primary-300 hover:text-primary-200"
                    onclick={() => (exchangeOpen = !exchangeOpen)}>
                    {m.media_sync_exchange_action()}
                </button>
                {#if exchangeOpen}
                    <p class="text-xs text-surface-300">{m.media_sync_exchange_scope()}</p>
                    <label class="block text-xs text-surface-300" for="exchange-other-episode">
                        {m.media_sync_exchange_other_id()}
                    </label>
                    <div class="flex flex-col gap-2 sm:flex-row">
                        <select
                            id="exchange-other-episode"
                            value={exchangeOtherId}
                            disabled={exchangeBusy || exchangeLoading}
                            onchange={(event) => {
                                exchangeOtherId = event.currentTarget.value;
                                exchangePreview = null;
                                exchangeSaved = null;
                                void reviewExchange();
                            }}
                            class="min-w-0 flex-1 bg-surface-700 border border-surface-600 rounded px-2 py-1 text-sm text-surface-100">
                            <option value="">{m.media_p5_choose_episode()}</option>
                            {#each exchangeCandidates as episode (episode.id)}
                                <option value={episode.id}
                                    >S{episode.season_number ?? '?'} E{episode.episode_number ??
                                        '?'} · {episode.title ?? ''}</option>
                            {/each}
                        </select>
                    </div>
                    {#if exchangePreview}
                        <div class="rounded border border-amber-500/50 p-3 space-y-2 text-sm">
                            <p class="font-medium text-amber-200">
                                {m.media_sync_exchange_series({
                                    title: exchangePreview.series.title,
                                })}
                            </p>
                            <p class="text-surface-300">{m.media_sync_exchange_review_warning()}</p>
                            {#each [exchangePreview.first, exchangePreview.second] as subject (subject.id)}
                                <div class="border-t border-surface-700 pt-2">
                                    <a
                                        class="text-primary-300 hover:underline"
                                        href={resolve(`/admin/library/media/${subject.id}`)}>
                                        {subject.title} · S{subject.seasonNumber ??
                                            '?'}E{subject.episodeNumber ?? '?'}
                                    </a>
                                    <p class="text-surface-300">
                                        {m.media_sync_exchange_assignment({
                                            current: subject.tmdbId,
                                            proposed:
                                                subject.id === exchangePreview.first.id
                                                    ? exchangePreview.second.tmdbId
                                                    : exchangePreview.first.tmdbId,
                                        })}
                                    </p>
                                </div>
                            {/each}
                            <button
                                class="btn variant-filled-primary text-sm"
                                disabled={exchangeBusy}
                                onclick={saveExchange}>
                                {m.media_sync_exchange_confirm()}
                            </button>
                        </div>
                    {/if}
                    {#if exchangeSaved}
                        <p class="text-sm text-green-300">
                            {m.media_sync_exchange_result({
                                first: exchangeSaved.first.tmdbId,
                                second: exchangeSaved.second.tmdbId,
                            })}
                        </p>
                    {/if}
                    {#if exchangeSaved?.undoId || exchangePreview?.undoId}<button
                            type="button"
                            class="btn variant-ghost-primary text-sm"
                            disabled={exchangeBusy}
                            onclick={undoExchange}>{m.media_p5_undo_exchange()}</button
                        >{/if}
                    {#if exchangeError}<p role="alert" class="text-sm text-red-300">
                            {exchangeError}
                        </p>{/if}
                {/if}
            </div>
        {/if}

        <!-- Sync controls. Hidden for AudiobookShelf books: there is no metadata
         provider to refresh from, so the control could only ever report
         "no provider linked". -->
        {#if hasMetadataProvider && (isEpisode || checkIsSeason(mediaType))}
            <div
                class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 space-y-2">
                <p>{m.media_sync_child_scope()}</p>
                {#if parentSeriesId}
                    <a
                        class="text-primary-300 underline"
                        href={resolve(
                            `/admin/library/media/${parentSeriesId}?tab=maintenance&section=metadata`,
                        )}>
                        {m.media_sync_inspect_parent()}
                    </a>
                {/if}
            </div>
        {:else if hasMetadataProvider}
            <div class="space-y-4">
                <!-- Provider info -->
                <div class="flex items-center gap-2 text-sm">
                    <span class="text-surface-400">{m.media_sync_provider_label()}</span>
                    {#if providerLabel}
                        <span class="text-surface-200">{providerLabel}</span>
                    {:else}
                        <span class="text-surface-500 italic"
                            >{m.media_sync_no_provider_linked()}</span>
                    {/if}
                </div>

                <!-- Include children toggle (series only) -->
                {#if isSeries && hasProvider}
                    <label class="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={includeChildren}
                            disabled={syncing || seriesSyncRunning}
                            class="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500/30" />
                        <span class="text-surface-300">{m.media_sync_include_children()}</span>
                    </label>
                {/if}

                <TaskActionButton
                    taskId={SERIES_SYNC_TASK_ID}
                    label={m.media_sync_sync_from_provider()}
                    {tracker}
                    onstart={handleSync}
                    disabled={syncing || !hasProvider}
                    class="text-sm px-5 py-2" />
            </div>

            <!-- Progress indicator -->
            {#if progressMessage}
                <div
                    class="text-sm p-4 rounded-lg bg-surface-800/60 border border-surface-700/50 flex items-center gap-3">
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin text-primary-400 shrink-0" />
                    <span class="text-surface-300">{progressMessage}</span>
                </div>
            {/if}

            <!-- Sync result -->
            {#if syncResult}
                <div
                    class="text-sm p-4 rounded-lg bg-surface-800/60 border border-surface-700/50 space-y-1">
                    {#if syncResult.updated}
                        {#if syncResult.fieldsChanged.length > 0}
                            <p class="text-green-400">
                                {m.media_sync_updated_fields({
                                    fields: syncResult.fieldsChanged
                                        .map(onlineFieldLabel)
                                        .join(', '),
                                })}
                            </p>
                        {/if}
                        {#if syncResult.seasonsSynced != null || syncResult.episodesSynced != null}
                            <p class="text-green-400">
                                {m.media_sync_synced_counts({
                                    seasons: syncResult.seasonsSynced ?? 0,
                                    episodes: syncResult.episodesSynced ?? 0,
                                })}
                            </p>
                        {/if}
                    {:else}
                        <p class="text-surface-400">{m.media_sync_already_up_to_date()}</p>
                    {/if}
                </div>
            {/if}

            <!-- Warning -->
            {#if hasProvider}
                <p class="text-xs text-surface-500 italic">
                    {m.media_sync_unlock_warning()}
                </p>
            {/if}
        {/if}
    {/if}
    {#if taskSection !== 'metadata'}
        <!-- Trickplay generation -->
        {#if hasLocalFiles}
            <div class="border-t border-surface-700/50 pt-6 space-y-4">
                <div>
                    <h3 class="text-lg font-semibold text-white flex items-center gap-2">
                        <Icon src={Film} class="w-5 h-5 text-surface-400" />
                        {m.media_sync_trickplay_heading()}
                    </h3>
                    <p class="text-sm text-surface-400 mt-1">
                        {m.media_sync_trickplay_description()}
                    </p>
                </div>

                <TaskActionButton
                    taskId={TRICKPLAY_TASK_ID}
                    label={m.media_p5_rebuild_seek()}
                    {tracker}
                    onstart={generateTrickplay}
                    class="text-sm px-5 py-2" />

                {#if trickplayProgress && trickplayProgress.total > 0}
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs text-surface-400">
                            <span>{m.media_sync_generating_thumbnails()}</span>
                            <span>{trickplayProgress.processed} / {trickplayProgress.total}</span>
                        </div>
                        <div class="w-full bg-surface-700 rounded-full h-2 overflow-hidden">
                            <div
                                class="bg-primary-500 h-full rounded-full transition-all duration-300"
                                style="width: {(trickplayProgress.processed /
                                    trickplayProgress.total) *
                                    100}%">
                            </div>
                        </div>
                    </div>
                {/if}

                {#if trickplayResult}
                    <div
                        class="text-sm p-3 rounded-lg border {trickplayResult.success
                            ? 'bg-green-900/20 border-green-700/40 text-green-300'
                            : 'bg-red-900/20 border-red-700/40 text-red-300'}">
                        {trickplayResult.message}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- Episode Thumbnails Section (series/season only) -->
        {#if isSeriesOrSeason}
            <div class="border-t border-surface-700/50 pt-6 space-y-4">
                <div>
                    <h3 class="text-lg font-semibold text-white flex items-center gap-2">
                        <Icon src={Film} class="w-5 h-5 text-surface-400" />
                        {m.media_sync_episode_thumbs_heading()}
                    </h3>
                    <p class="text-sm text-surface-400 mt-1">
                        {m.media_sync_episode_thumbs_description()}
                    </p>
                </div>

                <TaskActionButton
                    taskId={EPISODE_THUMBS_TASK_ID}
                    label={m.media_sync_regenerate_episode_thumbs()}
                    {tracker}
                    onstart={generateEpisodeThumbs}
                    class="text-sm px-5 py-2" />

                {#if episodeThumbsResult}
                    <div
                        class="text-sm p-3 rounded-lg border {episodeThumbsResult.success
                            ? 'bg-green-900/20 border-green-700/40 text-green-300'
                            : 'bg-red-900/20 border-red-700/40 text-red-300'}">
                        {episodeThumbsResult.message}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- Chapters Section. A book's chapters come from AudiobookShelf, not from
         probing a local file — they are shown read-only on the Book tab. -->
        {#if hasLocalFiles}
            <div class="mt-8 space-y-4">
                <div class="flex items-center justify-between">
                    <div>
                        <h3 class="text-lg font-semibold">{m.media_sync_chapters_heading()}</h3>
                        <p class="text-sm text-surface-400 mt-1">
                            {m.media_sync_chapters_description()}
                        </p>
                    </div>
                    <TaskActionButton
                        taskId={CHAPTER_SYNC_TASK_ID}
                        label={checkIsSeries(mediaType)
                            ? m.media_sync_sync_all_chapters()
                            : checkIsSeason(mediaType)
                              ? m.media_sync_sync_season_chapters()
                              : m.media_sync_sync_chapters()}
                        {tracker}
                        onstart={syncChapters} />
                </div>

                {#if chapterSyncResult}
                    <div
                        class="text-sm p-3 rounded-lg border {chapterSyncResult.success
                            ? 'bg-green-900/20 border-green-700/40 text-green-300'
                            : 'bg-red-900/20 border-red-700/40 text-red-300'}">
                        {chapterSyncResult.message}
                    </div>
                {/if}
            </div>
        {/if}

        {#if segmentUndoId}<button
                type="button"
                class="btn variant-ghost-primary text-sm"
                disabled={clearingSegments || savingManualSegment}
                onclick={undoMarkers}>{m.media_p5_undo_markers()}</button
            >{/if}
        <!-- Media Segments Section -->
        {#if hasLocalFiles}
            <div class="mt-8 space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-lg font-semibold">{m.media_sync_media_segments_heading()}</h3>
                    <div class="flex gap-2">
                        <TaskActionButton
                            taskId={ANALYZER_TASK_ID}
                            label={checkIsSeries(mediaType)
                                ? m.media_sync_generate_all_episodes()
                                : checkIsSeason(mediaType)
                                  ? m.media_sync_generate_season()
                                  : m.media_sync_generate()}
                            {tracker}
                            onstart={generateSegments}
                            disabled={analyzerBusy ||
                                segmentMutationBusy ||
                                segmentsLoading ||
                                !analysisReady} />
                        <TaskActionButton
                            taskId={ANALYZER_TASK_ID}
                            label={m.media_sync_regenerate_outros()}
                            {tracker}
                            onstart={generateOutros}
                            disabled={analyzerBusy ||
                                segmentMutationBusy ||
                                segmentsLoading ||
                                !analysisReady} />
                        {#if isSeriesOrSeason}<details class="text-xs text-surface-400">
                                <summary>{m.media_p5_details()}</summary>
                                <TaskActionButton
                                    taskId={ANALYZER_TASK_ID}
                                    label={m.media_sync_fingerprint()}
                                    {tracker}
                                    onstart={runDeepAnalysis}
                                    disabled={analyzerBusy ||
                                        segmentMutationBusy ||
                                        !analysisReady} />
                            </details>{/if}
                        <button
                            class="btn btn-sm variant-ghost-surface"
                            onclick={() => loadSegments()}
                            disabled={segmentsLoading || analyzerBusy}>
                            {m.btn_refresh()}
                        </button>
                        <button
                            class="btn btn-sm variant-ghost-error"
                            onclick={clearOutros}
                            disabled={segmentMutationBusy || analyzerBusy}
                            title={m.media_sync_delete_outros_title()}>
                            {clearingSegments
                                ? m.media_sync_clearing()
                                : m.media_sync_delete_outros()}
                        </button>
                        <button
                            class="btn btn-sm variant-ghost-error"
                            onclick={clearSegments}
                            disabled={segmentMutationBusy || analyzerBusy}
                            title={m.media_sync_clear_segments_title()}>
                            {clearingSegments ? m.media_sync_clearing() : m.media_sync_clear()}
                        </button>
                    </div>
                </div>

                {#if !analysisReady}
                    <p class="text-sm text-amber-300" role="status">
                        {m.media_source_awaiting_input()}
                    </p>
                {/if}
                {#if isSeriesOrSeason && analysisInputs}
                    <p class="text-sm text-surface-300">
                        {m.media_source_parent_readiness(readinessCounts)}
                    </p>
                    {#if alternateGroups.length > 0}
                        <details bind:open={readinessDetailsOpen} class="text-xs text-surface-400">
                            <summary class="cursor-pointer"
                                >{m.media_source_version_details()}</summary>
                            {#if readinessDetailsOpen}
                                {#each alternateGroups.slice(0, 20) as [file, count] (file)}
                                    <p class="break-all mt-1">
                                        {m.media_source_alternate_group({ file, count })}
                                    </p>
                                {/each}
                                {#if alternateGroups.length > 20}<p>
                                        {m.media_source_first_details({
                                            shown: 20,
                                            total: alternateGroups.length,
                                        })}
                                    </p>{/if}
                            {/if}
                        </details>
                    {/if}
                {:else if analysisInputs?.[0]?.alternate}
                    <p class="text-sm text-surface-300">
                        {m.media_source_alternate({ file: analysisInputs[0].filePath ?? '' })}
                    </p>
                {/if}
                {#if segmentsResult}
                    <div
                        class="text-sm p-3 rounded-lg border {segmentsResult.pending
                            ? 'bg-blue-900/20 border-blue-700/40 text-blue-300'
                            : segmentsResult.success
                              ? 'bg-green-900/20 border-green-700/40 text-green-300'
                              : 'bg-red-900/20 border-red-700/40 text-red-300'}">
                        {segmentsResult.message}
                        {#if segmentsResult.runId}
                            <a
                                class="underline ml-2"
                                href={resolve(
                                    `/admin/tasks/runs?run=${encodeURIComponent(segmentsResult.runId)}`,
                                )}>{m.media_sync_analysis_view_run()}</a>
                        {/if}
                        {#if segmentsResult.checkAgain}
                            <button
                                class="underline ml-2"
                                disabled={checkingAnalysis}
                                onclick={checkAnalysisAgain}
                                >{m.media_sync_analysis_check_again()}</button>
                        {/if}
                    </div>
                {/if}

                {#if deepAnalysisResult}
                    <div
                        class="text-sm p-3 rounded-lg border {deepAnalysisResult.success
                            ? 'bg-blue-900/20 border-blue-700/40 text-blue-300'
                            : 'bg-red-900/20 border-red-700/40 text-red-300'}">
                        {deepAnalysisResult.message}
                    </div>
                {/if}

                {#if analysisProgress && analysisProgress.total > 0}
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs text-surface-400">
                            <span>{m.media_sync_analyzing_episodes()}</span>
                            <span>{analysisProgress.processed} / {analysisProgress.total}</span>
                        </div>
                        <div class="w-full bg-surface-700 rounded-full h-2 overflow-hidden">
                            <div
                                class="bg-primary-500 h-full rounded-full transition-all duration-300"
                                style="width: {(analysisProgress.processed /
                                    analysisProgress.total) *
                                    100}%">
                            </div>
                        </div>
                    </div>
                {/if}

                {#if canSetManualSegment}
                    <div class="card p-4 space-y-3">
                        <div>
                            <h4 class="font-medium">{m.media_sync_manual_segment_heading()}</h4>
                            <p class="text-sm text-surface-400 mt-1">
                                {m.media_sync_manual_segment_description()}
                            </p>
                        </div>
                        <div class="flex flex-wrap items-end gap-3">
                            <label class="form-control w-28">
                                <span class="label-text text-xs"
                                    >{m.media_sync_segment_type()}</span>
                                <select class="select select-sm" bind:value={manualSegmentType}>
                                    <option value="Outro">{m.media_plain_credits()}</option>
                                    <option value="Intro">{m.media_plain_intros()}</option>
                                </select>
                            </label>
                            <label class="form-control w-32">
                                <span class="label-text text-xs"
                                    >{m.media_sync_manual_segment_start()}</span>
                                <input
                                    class="input input-sm"
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    bind:value={manualStartTime} />
                            </label>
                            <label class="form-control w-32">
                                <span class="label-text text-xs"
                                    >{m.media_sync_manual_segment_end()}</span>
                                <input
                                    class="input input-sm"
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    bind:value={manualEndTime} />
                            </label>
                            <button
                                class="btn btn-sm variant-filled-primary"
                                onclick={saveManualSegment}
                                disabled={segmentMutationBusy || analyzerBusy}>
                                {savingManualSegment
                                    ? m.media_sync_manual_segment_saving()
                                    : m.media_sync_manual_segment_save()}
                            </button>
                        </div>
                        {#if manualSegmentMessage}
                            <p
                                class="text-sm {manualSegmentMessage.success
                                    ? 'text-green-300'
                                    : 'text-red-300'}">
                                {manualSegmentMessage.message}
                            </p>
                        {/if}
                    </div>
                {/if}

                {#if segmentsLoading}
                    <p class="text-surface-400 text-sm">{m.media_sync_loading_segments()}</p>
                {:else if segmentsError}
                    <p class="text-error-500 text-sm">{segmentsError}</p>
                {:else if segmentsData && segmentsData.totalSegments > 0}
                    {#each Object.entries(segmentsData.providers) as [source, segments] (source)}
                        <div class="card p-4 space-y-2">
                            <div class="flex items-center gap-2">
                                <span class="badge variant-soft-primary text-xs">{source}</span>
                                <span class="text-surface-400 text-xs">
                                    {m.media_sync_segment_count({ count: segments.length })}
                                </span>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="table table-compact w-full">
                                    <thead>
                                        <tr>
                                            {#if isSeriesOrSeason}
                                                <th class="text-center"
                                                    >{m.media_sync_segment_episode()}</th>
                                            {/if}
                                            <th class="text-center"
                                                >{m.media_sync_segment_type()}</th>
                                            <th class="text-center">{m.admin_task_start()}</th>
                                            <th class="text-center"
                                                >{m.media_sync_segment_end()}</th>
                                            <th class="text-center"
                                                >{m.card_file_info_duration()}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {#each segments as seg, i (seg.type + '__' + seg.startMs + '__' + seg.endMs + '__' + i)}
                                            <tr>
                                                {#if isSeriesOrSeason}
                                                    <td class="text-center font-mono text-sm">
                                                        {formatEpisodeCode(seg)}
                                                    </td>
                                                {/if}
                                                <td class="text-center">
                                                    <span class="badge variant-soft text-xs"
                                                        >{seg.type}</span>
                                                </td>
                                                <td class="text-center font-mono text-sm">
                                                    {formatTime(seg.startMs / 1000)}
                                                </td>
                                                <td class="text-center font-mono text-sm">
                                                    {formatTime(seg.endMs / 1000)}
                                                </td>
                                                <td
                                                    class="text-center font-mono text-sm text-surface-400">
                                                    {formatTime((seg.endMs - seg.startMs) / 1000)}
                                                </td>
                                            </tr>
                                        {/each}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    {/each}
                {:else if segmentsData}
                    <p class="text-surface-400 text-sm">
                        {#if isSeriesOrSeason}
                            {m.media_sync_parent_segments_explanation()}
                        {:else}
                            {m.media_sync_no_segments()}
                        {/if}
                    </p>
                {/if}
            </div>
        {/if}
    {/if}
</div>
