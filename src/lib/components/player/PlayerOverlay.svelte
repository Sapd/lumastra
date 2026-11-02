<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { onDestroy, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { FAST_IDLE_LIMIT, nextProbePollDelayMs } from './probe-poll-policy.js';
    import * as m from '$lib/paraglide/messages';
    import { playerStore } from './playerStore.svelte';
    import { formatStreamBitrate } from './stream-bitrate';
    import {
        buildTranscodeProgressView,
        formatClock,
        isTranscodeFinished,
        SOFTWARE_FALLBACK_NOTICE_MS,
        stableDisplayFps,
        transcodeNotice,
    } from './transcode-progress-view';
    import TranscodeNoticeBadge from './TranscodeNoticeBadge.svelte';
    import { currentAdaptiveVariant } from './livetv-quality';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import NavigationProgressBar from '$lib/components/ui/NavigationProgressBar.svelte';
    import { getBrowserName, type BrowserCapabilities } from './browserCapabilities.svelte';
    import { buildHdrDetails, type DvBaseLayer } from './hdr-details';
    import type { TranscodeReason } from '$lib/schemas/playback-plan';

    interface Props {
        title?: string;
        isInWatchParty?: boolean;
        capabilities?: BrowserCapabilities | null;
        /**
         * Item ID used to poll /api/playback/{itemId}/probe-status while the
         * player is in its initial loading state. When the server is running
         * an on-demand keyframe probe (copy-mode video, first play), the
         * overlay replaces the generic spinner with a progress bar.
         */
        itemId?: string;
        onback?: () => void;
    }

    let {
        title = '',
        isInWatchParty = false,
        capabilities = null,
        itemId,
        onback,
    }: Props = $props();

    // ----------------------------------------------------------------------
    // Keyframe probe progress polling
    // ----------------------------------------------------------------------
    interface ProbeError {
        code: string;
        message: string;
        at: number;
    }

    interface ProbeStatus {
        probing: boolean;
        phase?: 'probing' | 'starting';
        progress?: number;
        currentSeconds?: number;
        totalSeconds?: number;
        startedAt?: number;
        /**
         * Present when the server has observed a terminal FFmpeg failure
         * before any HLS segment was produced. When set, polling stops and
         * the overlay renders the startup-error UI.
         */
        error?: ProbeError;
        /**
         * The server's encoder for this session cannot keep up or switched to
         * software. Sent only for our own play session (`?session=`); this is
         * the channel before the first heartbeat starts the progress poll.
         */
        encoder?: {
            slowReason?: 'gpu_busy' | 'cpu_slow';
            softwareFallbackFrom?: string;
        };
    }

    let probeState = $state<ProbeStatus>({ probing: false });
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollAbort: AbortController | null = null;
    // Incremented on every stop; async continuations captured the previous
    // value and bail out when the epoch no longer matches, preventing stale
    // polls from resurrecting after an item switch or unload.
    let pollEpoch = 0;
    // A 404 means this id has no probe resource. Buffering/session changes
    // must not re-arm requests for it during this player's lifetime.
    const missingProbeItems = new SvelteSet<string>();
    // Once we've observed probing: true, flip this so a subsequent
    // { probing: false } response terminates the loop instead of polling
    // forever during the remaining pre-play window.
    let probeSeen = false;
    // Consecutive `probing: false` answers in this poll window — drives the
    // backoff/give-up schedule in probe-poll-policy.ts.
    let idleResponses = 0;
    // A stale `probing: true` answer must not keep failures on the fast path.
    let failedResponses = 0;

    const reconnectDiagnostic = $derived.by(() => {
        if (playerStore.reconnectDiagnostic) return playerStore.reconnectDiagnostic;
        switch (playerStore.reconnectCause) {
            case 'session-expired':
                return m.player_reconnecting_server_session();
            case 'stall':
                return m.player_reconnecting_client_stall();
            case 'network':
            default:
                return m.player_reconnecting_network();
        }
    });

    function stopProbePolling(): void {
        pollEpoch++;
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
        if (pollAbort) {
            pollAbort.abort();
            pollAbort = null;
        }
        probeSeen = false;
        idleResponses = 0;
        failedResponses = 0;
        lastRunStartedAt = 0;
        lastRunMaxProgress = 0;
        // Preserve a captured probe error across polling lifecycle transitions:
        // once the server has told us FFmpeg failed, the overlay should keep
        // showing that message until the user retries, even after isLoading /
        // isBuffering flip (which they eventually do when hls.js gives up).
        //
        // `untrack` the read so that callers running inside a `$effect` do not
        // subscribe that effect to `probeState` — otherwise the write below
        // would re-trigger the effect → call this again → infinite loop
        // (effect_update_depth_exceeded). The write still notifies consumers
        // that legitimately depend on probeState (the template).
        const preservedError = untrack(() => probeState.error);
        probeState = preservedError
            ? { probing: false, error: preservedError }
            : { probing: false };
    }

    // Two concurrent HLS requests for the same file (audio-track switch,
    // Safari prefetch, etc.) race on the same Valkey progress key — each
    // probe's producer-side monotonic guard is local, so cross-probe writes
    // bounce the value. Clamp on the client: within a single run (same
    // startedAt) the displayed percent is non-decreasing; when startedAt
    // flips we treat it as a fresh run and reset.
    let lastRunStartedAt = 0;
    let lastRunMaxProgress = 0;

    async function pollOnce(id: string, epoch: number): Promise<void> {
        pollAbort?.abort();
        const ctrl = new AbortController();
        pollAbort = ctrl;
        try {
            const session = playerStore.playSessionId;
            const query = session ? `?session=${encodeURIComponent(session)}` : '';
            const res = await fetch(
                `/api/playback/${encodeURIComponent(id)}/probe-status${query}`,
                {
                    signal: ctrl.signal,
                    credentials: 'same-origin',
                },
            );
            if (epoch !== pollEpoch) return;
            if (res.status === 404) {
                missingProbeItems.add(id);
                stopProbePolling();
                playerStore.setStartupEncoderNotice(null);
                return;
            }
            if (!res.ok) {
                failedResponses++;
                return;
            }
            const data = (await res.json()) as ProbeStatus;
            if (epoch !== pollEpoch) return;
            failedResponses = 0;

            const smoothed: ProbeStatus = { ...data };
            if (data.probing && typeof data.startedAt === 'number') {
                if (data.startedAt !== lastRunStartedAt) {
                    lastRunStartedAt = data.startedAt;
                    lastRunMaxProgress = typeof data.progress === 'number' ? data.progress : 0;
                } else if (typeof data.progress === 'number') {
                    if (data.progress >= lastRunMaxProgress) {
                        lastRunMaxProgress = data.progress;
                    } else {
                        // Hold the bar at the prior max instead of regressing.
                        smoothed.progress = lastRunMaxProgress;
                    }
                }
            } else if (!data.probing) {
                lastRunStartedAt = 0;
                lastRunMaxProgress = 0;
            }

            probeState = smoothed;
            playerStore.setStartupEncoderNotice(smoothed.encoder ?? null);
            if (smoothed.probing) {
                probeSeen = true;
                idleResponses = 0;
            } else {
                idleResponses++;
            }
        } catch {
            // Network failures also spend the bounded retry budget. An abort
            // belongs to an old window and must not change the new one's count.
            if (epoch === pollEpoch && !ctrl.signal.aborted) failedResponses++;
        }
    }

    // Poll while the player is in its pre-playback window. `isLoading` flips
    // to false as soon as lumastra-info returns — well before the m3u8 fetch
    // even starts — so we also gate on `isBuffering`, which covers the long
    // m3u8 wait (where the <video> element fires "waiting") and any mid-
    // stream stall. Once the video actually has frames, both flags go false
    // and polling stops.
    function isProbePollWindow(): boolean {
        return playerStore.isLoading || playerStore.isBuffering;
    }

    /**
     * A finished keyframe probe used to end the loop. With a play session the
     * same answers also carry the encoder notice, and the transcode itself
     * only starts after the probe — keep polling on the idle back-off (2 s,
     * then 5 s, giving up after about two minutes) so a first segment that
     * takes a minute is still explained.
     */
    function continueAfterProbe(): boolean {
        if (!playerStore.playSessionId) return false;
        probeSeen = false;
        idleResponses = Math.max(idleResponses, FAST_IDLE_LIMIT);
        return true;
    }

    /** Delay before the next poll, or null when the loop should end. */
    function nextDelay(): number | null {
        if (failedResponses > 0) {
            return nextProbePollDelayMs({
                probing: false,
                probeSeen: false,
                idleResponses: failedResponses,
            });
        }
        return nextProbePollDelayMs({ probing: probeState.probing, probeSeen, idleResponses });
    }

    function schedulePoll(id: string, epoch: number, delayMs: number): void {
        pollTimer = setTimeout(async () => {
            if (epoch !== pollEpoch) return;
            if (!isProbePollWindow()) {
                stopProbePolling();
                return;
            }
            await pollOnce(id, epoch);
            if (epoch !== pollEpoch) return;
            // A terminal FFmpeg error is a final state — further polls would
            // just re-fetch the same (short-TTL) entry until it expires.
            if (probeState.error) return;
            // Stop once we've seen probing flip from true→false. The server
            // cleared its entry, so further polls just waste requests —
            // unless they also carry this session's encoder notice.
            if (probeSeen && !probeState.probing && !continueAfterProbe()) {
                stopProbePolling();
                return;
            }
            // Backs off, then gives up, when no probe ever shows up — see
            // probe-poll-policy.ts. The overlay keeps its last state; a new
            // loading/buffering window re-arms the $effect below.
            const delay = nextDelay();
            if (delay !== null && isProbePollWindow()) schedulePoll(id, epoch, delay);
        }, delayMs);
    }

    $effect(() => {
        if (!browser) return;
        const id = itemId;
        // Depend on both flags so the effect re-runs when either flips.
        const shouldPoll = playerStore.isLoading || playerStore.isBuffering;
        // Live TV has no keyframe probe and its id is a station, not a media item: the
        // route would answer 404 on every poll.
        if (!shouldPoll || !id || playerStore.isLive || missingProbeItems.has(id)) {
            stopProbePolling();
            // The startup answer is only meant for the window it was polled in.
            untrack(() => playerStore.setStartupEncoderNotice(null));
            return;
        }
        // Re-arm once the play session id is known: only polls that carry it
        // get the encoder notice.
        void playerStore.playSessionId;
        const epoch = ++pollEpoch;
        probeSeen = false;
        idleResponses = 0;
        failedResponses = 0;
        // A new window: the last window's encoder notice is stale.
        untrack(() => {
            if (probeState.encoder) probeState = { ...probeState, encoder: undefined };
            playerStore.setStartupEncoderNotice(null);
        });
        // Kick off immediately, then schedule subsequent polls.
        pollOnce(id, epoch).then(() => {
            if (epoch !== pollEpoch) return;
            if (probeState.error) return;
            if (probeSeen && !probeState.probing && !continueAfterProbe()) return;
            const delay = nextDelay();
            if (delay !== null && isProbePollWindow()) schedulePoll(id, epoch, delay);
        });
        return () => stopProbePolling();
    });

    onDestroy(() => stopProbePolling());

    // One-second clock for the transcode readout, so elapsed/ETA count between
    // progress polls instead of jumping every few seconds. Idle once the
    // transcode is finished — nothing on the readout moves any more.
    let progressClock = $state(Date.now());
    const transcodeClockRunning = $derived.by(() => {
        const tp = playerStore.transcodeProgress;
        return tp !== null && !isTranscodeFinished(tp);
    });
    $effect(() => {
        if (!transcodeClockRunning) return;
        progressClock = Date.now();
        const timer = setInterval(() => (progressClock = Date.now()), 1000);
        return () => clearInterval(timer);
    });

    // When a reading first said the server switched this video to software
    // encoding: that notice shows for a few seconds only (transcodeNotice).
    let fallbackSeenAt = $state<number | undefined>(undefined);
    let noticeClock = $state(Date.now());
    // Before the first heartbeat there is no progress reading yet; while the
    // player is loading or buffering, the probe poll carries the same notice.
    // Outside that window its last answer is stale and not used.
    const noticeSource = $derived(
        playerStore.transcodeProgress ??
            ((playerStore.isLoading || playerStore.isBuffering) && probeState.encoder
                ? probeState.encoder
                : null),
    );
    // Keyed by play session: a new session starts its notices over, while
    // between sources (probe poll → first heartbeat) the fallback stays
    // "seen" and does not show twice. One effect, so a session change and a
    // fallback that arrives with it cannot cancel each other out.
    let fallbackSession: string | null = null;
    $effect(() => {
        const session = playerStore.playSessionId;
        const fallbackFrom = noticeSource?.softwareFallbackFrom;
        untrack(() => {
            if (session !== fallbackSession) {
                fallbackSession = session;
                fallbackSeenAt = undefined;
            }
            if (fallbackFrom && fallbackSeenAt === undefined) {
                fallbackSeenAt = Date.now();
                noticeClock = fallbackSeenAt;
            }
        });
    });
    // Only the software-fallback notice expires on its own; tick once when it does.
    $effect(() => {
        const seenAt = fallbackSeenAt;
        if (seenAt === undefined) return;
        const timer = setTimeout(
            () => (noticeClock = Date.now()),
            Math.max(0, seenAt + SOFTWARE_FALLBACK_NOTICE_MS - Date.now()) + 50,
        );
        return () => clearTimeout(timer);
    });
    const encoderNotice = $derived(transcodeNotice(noticeSource, fallbackSeenAt, noticeClock));
    // Adaptive Live TV ladder, highest first, with the variant the decoder shows now.
    const abrLadder = $derived(playerStore.liveTvQuality?.ladder ?? null);
    const abrCurrent = $derived(
        abrLadder ? currentAdaptiveVariant(abrLadder, playerStore.decodedResolution) : null,
    );
    const abrVariants = $derived.by(
        (): { key: string; label: string; bitrate: string; playing: boolean }[] => {
            if (!abrLadder) return [];
            const rows = abrLadder.rungs.map((rung) => ({
                key: rung.id,
                label: `${rung.height}p`,
                bitrate: m.player_tt_abr_up_to({ bitrate: String(rung.maxBitrateBps / 1_000_000) }),
                playing: abrCurrent?.kind === 'rung' && abrCurrent.id === rung.id,
            }));
            if (abrLadder.includesOriginal) {
                rows.unshift({
                    key: 'original',
                    label: m.livetv_quality_status_original(),
                    bitrate: m.player_tt_abr_source_bitrate(),
                    playing: abrCurrent?.kind === 'original',
                });
            }
            return rows;
        },
    );
    const abrCurrentLabel = $derived(abrVariants.find((variant) => variant.playing)?.label ?? null);
    // Colour by the playing variant's place in the ladder: green at the top, red at
    // the bottom, so a drop in quality shows without reading the badge.
    const abrTier = $derived.by((): 'top' | 'high' | 'low' | 'bottom' | null => {
        const index = abrVariants.findIndex((variant) => variant.playing);
        if (index < 0) return null;
        if (index === 0) return 'top';
        if (index === abrVariants.length - 1) return 'bottom';
        return index / (abrVariants.length - 1) <= 0.5 ? 'high' : 'low';
    });

    const infoBadgesVisible = $derived(
        (playerStore.showControls || playerStore.isPaused) &&
            !!(playerStore.transcodingInfo || playerStore.hdrFormatLabel || playerStore.playMethod),
    );
    const encoderNoticeVisible = $derived(
        encoderNotice !== null &&
            !playerStore.isReconnecting &&
            !probeState.error &&
            !playerStore.error,
    );

    let probePercent = $derived(
        probeState.probing && typeof probeState.progress === 'number'
            ? Math.round(probeState.progress * 100)
            : null,
    );

    // Get branded logo for play button
    let logoSmall = $derived($page.data?.branding?.logoSmall || '');

    // Get browser name for tooltips
    let browserName = $derived(browser ? getBrowserName() : 'Browser');

    function handleBackClick() {
        onback?.();
    }

    function handleInfoBadgesPointerEnter() {
        playerStore.setShowControls(true);
    }

    function handleInfoBadgesPointerLeave() {
        playerStore.showControlsTemporarily();
    }

    // The re-encode target from the codec badge's "HEVC → H264" text.
    function transcodeTargetCodec(videoCodec: string | undefined): string | null {
        const arrow = videoCodec?.split('→');
        return arrow && arrow.length > 1 ? arrow[arrow.length - 1].trim() : null;
    }

    let hdrDetails = $derived(
        playerStore.hdrInfo
            ? buildHdrDetails(playerStore.hdrInfo, {
                  isVideoTranscode: playerStore.transcodingInfo?.isTranscoding ?? false,
                  targetCodec: transcodeTargetCodec(playerStore.transcodingInfo?.videoCodec),
                  caps: capabilities
                      ? {
                            dolbyVision: capabilities.dolbyVision.supported,
                            hdr10: capabilities.hdr10.supported,
                            hdr10Plus: capabilities.hdr10Plus.supported,
                            hlg: capabilities.hlg.supported,
                            hdrDisplay: capabilities.hdrDisplay,
                        }
                      : null,
              })
            : null,
    );

    function formatDvBaseLayer(layer: DvBaseLayer): string {
        switch (layer) {
            case 'hdr10':
                return 'HDR10';
            case 'sdr':
                return 'SDR';
            case 'hlg':
                return 'HLG';
            default:
                return m.player_tt_hdr_base_none();
        }
    }

    function formatSourceContainer(container: string | undefined): string {
        return container?.trim() ? container.toUpperCase() : m.player_tt_unknown();
    }

    function formatHlsContainer(container: string | undefined): string {
        switch (container) {
            case 'mpegts':
                return m.player_tt_hls_mpegts();
            case 'fmp4':
                return m.player_tt_hls_fmp4();
            default:
                return m.player_tt_hls_unknown_segments();
        }
    }

    function formatHlsClient(client: string | undefined): string {
        return client === 'native' ? m.player_tt_hls_native() : m.player_tt_hls_js();
    }

    function formatHlsAudioMode(mode: string | undefined): string {
        const audioTrackCount = playerStore.currentMediaSource?.audioStreams?.length ?? 0;

        switch (mode) {
            case 'muxed':
                return m.player_tt_hls_audio_muxed();
            case 'demux':
                return audioTrackCount > 1
                    ? m.player_tt_hls_audio_demux_multi({
                          count: audioTrackCount,
                      })
                    : m.player_tt_hls_audio_demux_single();
            default:
                return m.player_tt_hls_audio_unknown();
        }
    }

    function formatTranscodeType(type: string | undefined): string {
        switch (type) {
            case 'audio-only':
                return m.player_tt_type_audio_only();
            case 'audio-drop':
                return m.player_tt_type_audio_drop();
            case 'full':
                return m.player_tt_type_full();
            case 'tonemapping':
                return m.player_tt_type_tonemapping();
            case 'remux':
                return m.player_tt_type_remux();
            case 'audiobook-remux':
                return m.player_tt_type_audiobook_remux();
            default:
                return m.player_tt_type_default();
        }
    }

    function formatTranscodeAction(action: string | undefined): string {
        return action === 'transcode'
            ? m.player_tt_action_transcode()
            : action === 'copy'
              ? m.player_tt_action_copy()
              : m.player_tt_action_unknown();
    }

    function formatHardwareAcceleration(
        progress: NonNullable<typeof playerStore.transcodeProgress>,
    ): string {
        if (progress.isHardwareAccelerated) {
            return m.player_tt_hw_yes({
                name: progress.gpuEncoder || progress.gpuDecoder || 'GPU',
            });
        }
        if (progress.videoAction === 'copy' && progress.audioAction === 'transcode') {
            return m.player_tt_hw_no_audio();
        }
        return m.player_tt_hw_no_software();
    }

    function formatTranscodeProgress(
        progress: NonNullable<typeof playerStore.transcodeProgress>,
    ): string {
        return `${progress.progressPercent}% (${progress.segmentsReady}/${progress.totalSegments || '?'})`;
    }

    function formatFps(fps: number | undefined): string {
        return fps !== undefined ? fps.toFixed(fps >= 10 ? 0 : 1) : m.player_tt_pending();
    }

    /** Keeps fractional precision (23.75, 23.98, 29.97...) instead of
     *  rounding to a whole number above 10fps — unlike formatFps(), which is
     *  fine for the coarser encode-throughput display but would hide the
     *  difference between e.g. 23.976 and 24 content fps. */
    function formatContentFps(fps: number | undefined): string {
        if (fps === undefined) return m.player_tt_pending();
        const rounded = Math.round(fps * 100) / 100;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
    }

    function formatSpeed(speed: number | undefined): string {
        return speed !== undefined
            ? `${speed.toFixed(speed >= 10 ? 0 : 2)}x`
            : m.player_tt_pending();
    }

    /**
     * Render a structured transcode reason via Paraglide. Falls back to the
     * English string for unknown codes (shouldn't happen in normal operation,
     * but keeps the client resilient to server/client skew).
     */
    function renderTranscodeReason(reason: TranscodeReason): string {
        const p = reason.params ?? {};
        switch (reason.code) {
            case 'hdr_tonemap_dolby_vision':
                return m.player_reason_hdr_tonemap_dolby_vision();
            case 'video_10bit_h264':
                return m.player_reason_video_10bit_h264();
            case 'video_codec_incompatible':
                return m.player_reason_video_codec_incompatible({
                    codec: String(p.codec ?? ''),
                });
            case 'audio_codec_incompatible':
                return m.player_reason_audio_codec_incompatible({
                    codecs: String(p.codecs ?? ''),
                });
            case 'container_incompatible':
                return m.player_reason_container_incompatible({
                    container: String(p.container ?? ''),
                });
            case 'multi_audio_needs_hls':
                return m.player_reason_multi_audio_needs_hls();
            case 'video_level_exceeded':
                return p.max !== undefined
                    ? m.player_reason_video_level_exceeded_max({
                          level: String(p.level),
                          max: String(p.max),
                      })
                    : m.player_reason_video_level_exceeded({
                          level: String(p.level),
                      });
            case 'video_profile_exceeded':
                return p.allowed !== undefined
                    ? m.player_reason_video_profile_exceeded_allowed({
                          profile: String(p.profile),
                          allowed: String(p.allowed),
                      })
                    : m.player_reason_video_profile_exceeded({
                          profile: String(p.profile),
                      });
            case 'video_profile_excluded':
                return m.player_reason_video_profile_excluded({
                    profile: String(p.profile),
                });
            case 'resolution_exceeded':
                return p.maxWidth !== undefined
                    ? m.player_reason_resolution_exceeded_max({
                          width: String(p.width),
                          height: String(p.height),
                          maxWidth: String(p.maxWidth),
                          maxHeight: String(p.maxHeight),
                      })
                    : m.player_reason_resolution_exceeded({
                          width: String(p.width),
                          height: String(p.height),
                      });
            case 'resolution_exceeded_user_cap':
                return p.maxHeight !== undefined
                    ? m.player_reason_resolution_exceeded_user_cap_max({
                          width: String(p.width),
                          height: String(p.height),
                          maxHeight: String(p.maxHeight),
                      })
                    : m.player_reason_resolution_exceeded_user_cap({
                          width: String(p.width),
                          height: String(p.height),
                      });
            case 'bitrate_exceeded':
                return p.maxMbps !== undefined
                    ? m.player_reason_bitrate_exceeded_max({
                          mbps: String(p.mbps),
                          maxMbps: String(p.maxMbps),
                      })
                    : m.player_reason_bitrate_exceeded({
                          mbps: String(p.mbps),
                      });
            case 'bitrate_exceeded_user_cap':
                return p.maxMbps !== undefined
                    ? m.player_reason_bitrate_exceeded_user_cap_max({
                          mbps: String(p.mbps),
                          maxMbps: String(p.maxMbps),
                      })
                    : m.player_reason_bitrate_exceeded_user_cap({
                          mbps: String(p.mbps),
                      });
            case 'audio_channels_exceeded':
                return m.player_reason_audio_channels_exceeded({
                    channels: String(p.channels),
                    max: String(p.max),
                });
            case 'preview_mode':
                return m.player_reason_preview_mode();
            case 'client_requested':
            case 'subtitle_burn_in':
            case 'audio_format_requested':
            case 'audio_bitrate_requested':
            case 'audio_bitrate_exceeded':
            case 'audio_container_incompatible': {
                const info = playerStore.transcodingInfo;
                const index =
                    info?.transcodeReasonCodes?.findIndex(
                        (candidate) => candidate.code === reason.code,
                    ) ?? -1;
                return info?.transcodeReasons?.[index] ?? reason.code.replaceAll('_', ' ');
            }
            default: {
                const exhaustive: never = reason.code;
                return exhaustive;
            }
        }
    }

    /**
     * Prefer structured reason codes (i18n) over the legacy English strings.
     * Falls back to the string array when the server hasn't emitted codes yet.
     */
    function getDisplayReasons(): string[] {
        const info = playerStore.transcodingInfo;
        if (!info) return [];
        if (info.transcodeReasonCodes && info.transcodeReasonCodes.length > 0) {
            return info.transcodeReasonCodes.map(renderTranscodeReason).filter((s) => s.length > 0);
        }
        return info.transcodeReasons ?? [];
    }
</script>

<!-- Top progress bar shown while a Lumastra version change is restarting playback.
     The centre spinner still shows for normal buffer/load; this bar is the
     dedicated "switching version" signal so the user knows the track change
     is a short deliberate restart, not a stall. -->
<NavigationProgressBar active={playerStore.isVersionSwitching} />

<div
    class="overlay-container"
    class:visible={playerStore.showControls ||
        playerStore.isPaused ||
        playerStore.isBuffering ||
        playerStore.isLoading ||
        playerStore.error ||
        probeState.error}>
    <!-- Top gradient with title and back button -->
    <div class="top-overlay" class:visible={playerStore.showControls || playerStore.isPaused}>
        <button class="back-button" onclick={handleBackClick} aria-label={m.player_go_back()}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
        </button>

        {#if title}
            <h1 class="title">{title}</h1>
        {/if}
    </div>

    <!-- Media info badges - positioned below top bar on right, moves down when in watch party -->
    {#if infoBadgesVisible}
        <div
            class="info-badges-container"
            data-controls-hover-lock
            role="presentation"
            onpointerenter={handleInfoBadgesPointerEnter}
            onpointerleave={handleInfoBadgesPointerLeave}
            class:in-watch-party={isInWatchParty}>
            <!-- Playback method badge (Direct Play / Remux / Transcode / Audio-Transcode / Audio only) -->
            {#if playerStore.playMethod}
                {@const reasons = getDisplayReasons()}
                {@const isVideoTranscode = playerStore.transcodingInfo?.isTranscoding || false}
                {@const isAudioTranscode = playerStore.transcodingInfo?.isAudioTranscoding || false}
                {@const isAudioOnlyRung = playerStore.playMethod === 'AudioOnly'}
                {@const isAudioOnlyTranscode =
                    !isAudioOnlyRung && !isVideoTranscode && isAudioTranscode}
                <div class="badge-with-tooltip">
                    <span
                        class="info-badge playmethod-badge"
                        class:direct={playerStore.playMethod === 'DirectPlay'}
                        class:remux={playerStore.playMethod === 'DirectStream' &&
                            !isAudioOnlyTranscode}
                        class:transcode={playerStore.playMethod === 'Transcode' &&
                            !isAudioOnlyTranscode}
                        class:audio-transcode={isAudioOnlyTranscode || isAudioOnlyRung}>
                        {#if playerStore.playMethod === 'DirectPlay'}
                            {m.player_method_direct()}
                        {:else if isAudioOnlyRung}
                            <!-- The rung's own label, not "Audio-Transcode": the video
                                 stream is dropped entirely, not merely re-encoded. -->
                            {m.player_quality_audio_only_label()}
                        {:else if isAudioOnlyTranscode}
                            {m.player_method_audio_transcode()}
                        {:else if playerStore.playMethod === 'DirectStream'}
                            {m.player_method_remux()}
                        {:else}
                            {m.player_method_transcode()}
                        {/if}
                    </span>
                    <div class="custom-tooltip">
                        {#if playerStore.playMethod === 'DirectPlay'}
                            <div class="tooltip-header direct">
                                {m.player_tt_direct_title()}
                            </div>
                            <div class="tooltip-body">
                                {m.player_tt_direct_body({
                                    browser: browserName,
                                })}
                                <div class="tooltip-note">
                                    {m.player_tt_direct_note()}
                                </div>
                            </div>
                        {:else if isAudioOnlyRung}
                            <div class="tooltip-header audio-transcode">
                                {m.player_quality_audio_only_label()}
                            </div>
                            <div class="tooltip-body">
                                {m.player_quality_audio_only_sublabel()}
                            </div>
                        {:else if isAudioOnlyTranscode}
                            <div class="tooltip-header audio-transcode">
                                {m.player_tt_audio_transcode_title()}
                            </div>
                            <div class="tooltip-body">
                                {m.player_tt_audio_transcode_body({
                                    browser: browserName,
                                })}
                                {#if reasons.length > 0}
                                    {#each reasons as reason, i (i)}
                                        <div class="tooltip-reason">
                                            • {reason}
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        {:else if playerStore.playMethod === 'DirectStream'}
                            {@const sourceContainer =
                                playerStore.currentMediaSource?.container?.toUpperCase() || 'MKV'}
                            <div class="tooltip-header remux">
                                {m.player_tt_remux_title()}
                            </div>
                            <div class="tooltip-body">
                                {m.player_tt_remux_body({ sourceContainer })}
                                <div class="tooltip-note">
                                    {m.player_tt_remux_note()}
                                </div>
                            </div>
                        {:else if reasons.length > 0}
                            <div class="tooltip-header transcode">
                                {m.player_tt_transcoding_required_title()}
                            </div>
                            <div class="tooltip-body">
                                {#each reasons as reason, i (i)}
                                    <div class="tooltip-reason">• {reason}</div>
                                {/each}
                            </div>
                        {:else}
                            <div class="tooltip-header transcode">
                                {m.player_tt_transcode_title()}
                            </div>
                            <div class="tooltip-body">
                                {m.player_tt_transcode_body()}
                            </div>
                        {/if}
                        {#if playerStore.playbackDeliveryInfo?.type === 'hls'}
                            <div class="tooltip-meta">
                                <div class="tooltip-row">
                                    <span>{m.player_tt_playback()}</span>
                                    <strong>
                                        {formatHlsClient(
                                            playerStore.playbackDeliveryInfo.hlsClient,
                                        )}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hls_container()}</span>
                                    <strong>
                                        {formatHlsContainer(
                                            playerStore.playbackDeliveryInfo.hlsContainer,
                                        )}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hls_audio()}</span>
                                    <strong>
                                        {formatHlsAudioMode(
                                            playerStore.playbackDeliveryInfo.hlsAudioMode,
                                        )}
                                    </strong>
                                </div>
                            </div>
                        {/if}
                        {#if capabilities}
                            <div class="tooltip-caps">
                                {m.player_tt_caps_supports({
                                    browser: browserName,
                                })}
                                {[
                                    capabilities.h265?.supported ? 'HEVC' : null,
                                    capabilities.av1?.supported ? 'AV1' : null,
                                    capabilities.vp9?.supported ? 'VP9' : null,
                                ]
                                    .filter(Boolean)
                                    .join(', ') || m.player_tt_caps_h264_only()}
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            <!-- Adaptive (ABR) badge: Live TV served the synchronized ladder. The badge
                 names the variant playing now; the tooltip lists every variant the
                 player can switch between. -->
            {#if playerStore.isLive && abrLadder}
                <div class="badge-with-tooltip">
                    <span
                        class="info-badge abr-badge"
                        class:abr-top={abrTier === 'top'}
                        class:abr-high={abrTier === 'high'}
                        class:abr-low={abrTier === 'low'}
                        class:abr-bottom={abrTier === 'bottom'}>
                        {abrCurrentLabel
                            ? m.player_abr_badge_current({ quality: abrCurrentLabel })
                            : m.player_abr_badge()}
                    </span>
                    <div class="custom-tooltip">
                        <div class="tooltip-header abr">{m.player_tt_abr_title()}</div>
                        <div class="tooltip-body">
                            {m.player_tt_abr_body({ count: String(abrVariants.length) })}
                        </div>
                        <div class="tooltip-meta">
                            {#each abrVariants as variant (variant.key)}
                                <div class="tooltip-row" class:abr-playing={variant.playing}>
                                    <span>
                                        {variant.label}
                                        {#if variant.playing}
                                            · {m.player_tt_abr_playing()}
                                        {/if}
                                    </span>
                                    <strong>{variant.bitrate}</strong>
                                </div>
                            {/each}
                        </div>
                    </div>
                </div>
            {/if}

            <!-- Resolution badge -->
            {#if playerStore.transcodingInfo?.resolution}
                <!-- The decoded size, not the source file's: a 720p transcode of a
                     1080p file used to read 1920x1080. -->
                <Tooltip text={m.player_tt_video_resolution()} position="bottom" fixed>
                    <span class="info-badge resolution-badge">
                        {playerStore.decodedResolution ?? playerStore.transcodingInfo.resolution}
                    </span>
                </Tooltip>
            {/if}

            <!-- FPS badge: live measured fps once sampled, source fps as fallback
                 until then. Hover shows the source fps for reference. Desktop-only
                 (hidden under the mobile breakpoint below). -->
            {#if playerStore.videoInfo?.averageFrameRate != null || playerStore.liveFps != null}
                {@const sourceFps = playerStore.videoInfo?.averageFrameRate}
                {@const displayFps = stableDisplayFps(playerStore.liveFps, sourceFps)}
                <Tooltip
                    text={m.player_tt_source_fps({ fps: formatContentFps(sourceFps) })}
                    position="bottom"
                    fixed>
                    <span class="info-badge fps-badge">
                        {formatContentFps(displayFps)}
                        {m.player_tt_fps()}
                    </span>
                </Tooltip>
            {/if}

            <!-- HDR format badge (only shown when content is HDR). Hover explains the
                 source's real format (DV profile + base layer), what reaches the
                 screen and why they differ. -->
            {#if playerStore.hdrFormatLabel && hdrDetails}
                {@const d = hdrDetails}
                {@const tonemapMode = playerStore.transcodeProgress?.hdrTonemapMode}
                <div class="badge-with-tooltip">
                    <span
                        class="info-badge hdr-badge"
                        class:tonemap-software={tonemapMode === 'software'}>
                        {playerStore.hdrFormatLabel}
                    </span>
                    <div class="custom-tooltip hdr-tooltip">
                        <div class="tooltip-header hdr" class:dv={d.baseLayer !== null}>
                            {m.player_tt_hdr_title()}
                        </div>
                        <div class="tooltip-body">
                            <div class="tooltip-row">
                                <span>{m.player_tt_hdr_source()}</span>
                                <strong>{d.sourceLabel}</strong>
                            </div>
                            {#if d.baseLayer}
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hdr_base_layer()}</span>
                                    <strong>{formatDvBaseLayer(d.baseLayer)}</strong>
                                </div>
                            {/if}
                            <div class="tooltip-row">
                                <span>{m.player_tt_hdr_output()}</span>
                                <strong>
                                    {#if d.outcome === 'tonemapped'}
                                        {m.player_tt_hdr_output_sdr()}
                                    {:else if d.outcome === 'dv_base_layer'}
                                        {formatDvBaseLayer(d.baseLayer ?? 'hdr10')}
                                    {:else}
                                        {d.outputLabel}
                                    {/if}
                                </strong>
                            </div>
                            {#if d.outcome === 'tonemapped' && tonemapMode && tonemapMode !== 'n/a'}
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hdr_tonemap()}</span>
                                    <strong>
                                        {tonemapMode === 'software'
                                            ? m.player_tt_hdr_tonemap_software()
                                            : m.player_tt_hdr_tonemap_hardware()}
                                    </strong>
                                </div>
                            {/if}
                            {#if capabilities}
                                {#if d.baseLayer !== null}
                                    <div class="tooltip-row">
                                        <span>
                                            {m.player_tt_hdr_browser_dv({ browser: browserName })}
                                        </span>
                                        <strong>
                                            {capabilities.dolbyVision.supported
                                                ? m.player_tt_hdr_yes()
                                                : m.player_tt_hdr_no()}
                                        </strong>
                                    </div>
                                {/if}
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hdr_display()}</span>
                                    <strong>{capabilities.hdrDisplay ? 'HDR' : 'SDR'}</strong>
                                </div>
                            {/if}
                            <div class="tooltip-divider"></div>
                            <div class="hdr-explain">
                                {#if d.outcome === 'passthrough'}
                                    {m.player_tt_hdr_passthrough({
                                        format: d.sourceLabel,
                                        browser: browserName,
                                    })}
                                {:else if d.outcome === 'dv_base_layer'}
                                    {m.player_tt_hdr_dv_base_layer({
                                        browser: browserName,
                                        base: formatDvBaseLayer(d.baseLayer ?? 'hdr10'),
                                    })}
                                {:else if d.outcome === 'dv_stripped'}
                                    {m.player_tt_hdr_dv_stripped({ output: d.outputLabel })}
                                {:else if d.outcome === 'hdr_reencoded'}
                                    {m.player_tt_hdr_reencoded({ output: d.outputLabel })}
                                {:else}
                                    {m.player_tt_hdr_tonemapped({ source: d.sourceLabel })}
                                    {#if d.tonemapCause === 'codec_no_hdr'}
                                        {m.player_tt_hdr_cause_codec()}
                                    {:else if d.tonemapCause === 'browser_no_dv'}
                                        {m.player_tt_hdr_cause_no_dv({ browser: browserName })}
                                    {:else if d.tonemapCause === 'browser_no_hdr'}
                                        {m.player_tt_hdr_cause_no_hdr({ browser: browserName })}
                                    {:else}
                                        {m.player_tt_hdr_cause_other()}
                                    {/if}
                                {/if}
                            </div>
                            {#if tonemapMode === 'software'}
                                <div class="tooltip-note">
                                    {m.player_tt_tone_mapped_software_from({
                                        source: d.sourceLabel,
                                    })}
                                </div>
                            {/if}
                            {#if d.displaySdr}
                                <div class="tooltip-note">{m.player_tt_hdr_display_sdr()}</div>
                            {/if}
                        </div>
                    </div>
                </div>
            {:else if playerStore.hdrFormatLabel}
                <Tooltip
                    text={playerStore.transcodeProgress?.hdrTonemapMode === 'software'
                        ? m.player_tt_tone_mapped_software_from({
                              source:
                                  playerStore.hdrInfo?.sourceFormat ??
                                  playerStore.hdrFormatLabel ??
                                  '',
                          })
                        : playerStore.hdrInfo?.isToneMapped
                          ? m.player_tt_tone_mapped_from({
                                source: playerStore.hdrInfo.sourceFormat ?? '',
                            })
                          : playerStore.hdrFormatLabel}
                    position="bottom"
                    fixed>
                    <span
                        class="info-badge hdr-badge"
                        class:tonemap-software={playerStore.transcodeProgress?.hdrTonemapMode ===
                            'software'}>
                        {playerStore.hdrFormatLabel}
                    </span>
                </Tooltip>
            {/if}

            <!-- Video codec badge -->
            {#if playerStore.transcodingInfo?.videoCodec}
                <div class="badge-with-tooltip">
                    <span
                        class="info-badge codec-badge"
                        class:transcoding={playerStore.transcodingInfo?.isTranscoding}>
                        {playerStore.transcodingInfo.videoCodec}
                    </span>
                    <div class="custom-tooltip codec-tooltip">
                        <div class="tooltip-header codec">
                            {m.player_tt_codec_title()}
                        </div>
                        <div class="tooltip-body">
                            <div class="tooltip-row">
                                <span>{m.player_tt_codec()}</span>
                                <strong>
                                    {playerStore.transcodingInfo.videoCodec}
                                </strong>
                            </div>
                            <div class="tooltip-row">
                                <span>{m.player_tt_source_container()}</span>
                                <strong>
                                    {formatSourceContainer(
                                        playerStore.currentMediaSource?.container,
                                    )}
                                </strong>
                            </div>
                            {#if playerStore.playbackDeliveryInfo?.type === 'hls'}
                                <div class="tooltip-row">
                                    <span>{m.player_tt_playback()}</span>
                                    <strong>
                                        {formatHlsClient(
                                            playerStore.playbackDeliveryInfo.hlsClient,
                                        )}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hls_container()}</span>
                                    <strong>
                                        {formatHlsContainer(
                                            playerStore.playbackDeliveryInfo.hlsContainer,
                                        )}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hls_audio()}</span>
                                    <strong>
                                        {formatHlsAudioMode(
                                            playerStore.playbackDeliveryInfo.hlsAudioMode,
                                        )}
                                    </strong>
                                </div>
                            {:else}
                                <div class="tooltip-row">
                                    <span>{m.player_tt_playback()}</span>
                                    <strong>{m.player_tt_direct_file()}</strong>
                                </div>
                            {/if}
                            {#if playerStore.transcodeProgress}
                                {@const progress = playerStore.transcodeProgress}
                                <div class="tooltip-divider"></div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_transcode_label()}</span>
                                    <strong>
                                        {formatTranscodeType(progress.transcodeType)}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_video()}</span>
                                    <strong>
                                        {formatTranscodeAction(progress.videoAction)}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_audio()}</span>
                                    <strong>
                                        {formatTranscodeAction(progress.audioAction)}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_progress()}</span>
                                    <strong>
                                        {formatTranscodeProgress(progress)}
                                    </strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_fps()}</span>
                                    <strong>{formatFps(progress.fps)}</strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_speed()}</span>
                                    <strong>{formatSpeed(progress.speed)}</strong>
                                </div>
                                <div class="tooltip-row">
                                    <span>{m.player_tt_hardware()}</span>
                                    <strong>
                                        {formatHardwareAcceleration(progress)}
                                    </strong>
                                </div>
                            {/if}
                        </div>
                    </div>
                </div>
            {/if}

            <!-- Bitrate badge -->
            {#if playerStore.transcodingInfo?.videoBitrate}
                <Tooltip text={m.player_tt_video_bitrate()} position="bottom" fixed>
                    <span
                        class="info-badge bitrate-badge"
                        class:transcoding={playerStore.transcodingInfo?.isTranscoding}>
                        {playerStore.transcodingInfo.videoBitrate}
                    </span>
                </Tooltip>
            {/if}

            <!-- Transcode progress badge -->
            {#if playerStore.transcodeProgress}
                {@const view = buildTranscodeProgressView(
                    playerStore.transcodeProgress,
                    progressClock,
                )}
                {@const reasons = getDisplayReasons()}
                <div class="badge-with-tooltip">
                    <span
                        class="info-badge transcode-progress-badge"
                        class:complete={view.state === 'complete'}
                        class:slow={view.state === 'slow'}
                        class:paused={view.state === 'paused'}>
                        {#if view.state === 'paused'}
                            <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
                                <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
                            </svg>
                        {:else}
                            <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
                                <path
                                    d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
                                <path d="M8 3.5v5l3.5 2" />
                            </svg>
                        {/if}
                        {view.percent}%
                    </span>
                    <div class="custom-tooltip">
                        <div class="tooltip-header transcode-progress">
                            {m.player_tt_transcode_progress_title()}
                        </div>
                        <div class="tooltip-body">
                            <!-- Progress bar -->
                            <!-- Coverage: every transcoded stretch of the file, with
                                 a marker where the encoder is now. -->
                            <div class="transcode-progress-bar">
                                {#each view.ranges as range (range.start)}
                                    <div
                                        class="transcode-progress-fill"
                                        style="left: {range.start}%; width: {range.end -
                                            range.start}%">
                                    </div>
                                {/each}
                                {#if view.encoderPercent !== undefined}
                                    <div
                                        class="transcode-progress-encoder"
                                        style="left: {view.encoderPercent}%">
                                    </div>
                                {/if}
                            </div>
                            <div class="transcode-stats">
                                <span
                                    >{m.player_tt_percent_complete({
                                        percent: view.percent,
                                    })}</span>
                                <span
                                    >{m.player_tt_segments_count({
                                        ready: view.segmentsReady,
                                        total: view.totalSegments,
                                    })}</span>
                            </div>
                            <div class="transcode-stats">
                                <span
                                    >{m.player_tt_elapsed({
                                        time: formatClock(view.elapsedSeconds),
                                    })}</span>
                                {#if view.etaSeconds !== undefined}
                                    <span
                                        >{m.player_tt_eta({
                                            time: formatClock(view.etaSeconds),
                                        })}</span>
                                {/if}
                            </div>
                            {#if view.aheadSeconds !== undefined && view.state !== 'complete'}
                                <div class="transcode-stats">
                                    <span
                                        >{m.player_tt_ahead_of_playback({
                                            time: formatClock(Math.max(0, view.aheadSeconds)),
                                        })}</span>
                                </div>
                            {/if}
                            {#if view.state === 'paused'}
                                <div class="transcode-reasons-divider"></div>
                                <div class="tooltip-reason paused">
                                    • {m.player_tt_transcode_paused()}
                                </div>
                            {:else if view.state === 'slow'}
                                <div class="transcode-reasons-divider"></div>
                                <div class="tooltip-reason">
                                    • {m.player_tt_transcode_throttled()}
                                </div>
                            {/if}
                            {#if reasons.length > 0}
                                <div class="transcode-reasons-divider"></div>
                                {#each reasons as reason, i (i)}
                                    <div class="tooltip-reason">• {reason}</div>
                                {/each}
                            {/if}
                        </div>
                    </div>
                </div>
            {/if}

            <!-- Stream bitrate badge: what the stream carries (segment bytes over
                 media seconds). The link's burst download speed moved into the
                 tooltip — on a LAN it read "330 Mbps" for a 4 Mbps stream. -->
            {#if playerStore.streamBitrate}
                <Tooltip
                    text={playerStore.downloadBandwidth
                        ? m.player_tt_stream_bitrate_with_download({
                              download: formatStreamBitrate(playerStore.downloadBandwidth),
                          })
                        : m.player_tt_stream_bitrate()}
                    position="bottom"
                    fixed>
                    <span class="info-badge speed-badge">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
                            <path
                                d="M4 16v4h4l-5-5 1 1zm8-11c-3.9 0-7 3.1-7 7s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm.5-8H11v4l3.2 1.9.8-1.2-2.5-1.5V9z" />
                        </svg>
                        {formatStreamBitrate(playerStore.streamBitrate)}
                    </span>
                </Tooltip>
            {:else if playerStore.downloadBandwidth}
                {@const speedMbps = playerStore.downloadBandwidth / 1000000}
                <Tooltip text={m.player_tt_download_speed()} position="bottom" fixed>
                    <span class="info-badge speed-badge">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
                            <path
                                d="M4 16v4h4l-5-5 1 1zm8-11c-3.9 0-7 3.1-7 7s3.1 7 7 7 7-3.1 7-7-3.1-7-7-7zm0 12c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm.5-8H11v4l3.2 1.9.8-1.2-2.5-1.5V9z" />
                        </svg>
                        {speedMbps >= 100 ? speedMbps.toFixed(0) : speedMbps.toFixed(1)} Mbps
                    </span>
                </Tooltip>
            {/if}
            {#if encoderNoticeVisible}
                <!-- A row of its own below every badge row, however many wrap. -->
                <div class="transcode-notice-row">
                    <TranscodeNoticeBadge notice={encoderNotice} />
                </div>
            {/if}
        </div>
    {/if}

    <!-- Center overlay for loading/buffering/error.
         Every `.center-overlay` is absolutely centered at the same point, so at
         most ONE of them may render at a time. A terminal error wins: the video
         element keeps firing `waiting` after the stream is torn down, so
         `isBuffering` can flip back to true even after setError() cleared it —
         gate on the errors here rather than relying on the store alone, or the
         spinner and "Buffering" label draw underneath the error card and its
         Retry button. -->
    {#if (playerStore.isLoading || playerStore.isBuffering) && !probeState.error && !playerStore.error && !playerStore.isReconnecting}
        <div class="center-overlay">
            <div class="spinner">
                <svg viewBox="0 0 50 50" width="60" height="60">
                    <circle
                        cx="25"
                        cy="25"
                        r="20"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="4"
                        stroke-linecap="round"
                        stroke-dasharray="31.4 31.4">
                        <animateTransform
                            attributeName="transform"
                            type="rotate"
                            from="0 25 25"
                            to="360 25 25"
                            dur="1s"
                            repeatCount="indefinite" />
                    </circle>
                </svg>
            </div>
            {#if (playerStore.isLoading || playerStore.isBuffering) && probeState.probing}
                <p class="status-text">
                    {#if probeState.phase === 'starting'}
                        Starting transcoder — FFmpeg is opening the file.
                    {:else}
                        Preparing video for first playback — this happens once per file.
                    {/if}
                </p>
                <div class="probe-progress-bar">
                    <div
                        class="probe-progress-fill"
                        class:indeterminate={probePercent === null}
                        style={probePercent !== null ? `width: ${probePercent}%;` : undefined}>
                    </div>
                </div>
                <p class="probe-progress-label">
                    {#if probeState.phase === 'starting'}
                        Starting transcoder…
                    {:else if probePercent !== null}
                        Analyzing video structure — {probePercent}%
                    {:else}
                        Analyzing video structure…
                    {/if}
                </p>
            {:else}
                <p class="status-text">
                    {playerStore.isLoading ? m.loading() : m.player_buffering()}
                </p>
            {/if}
        </div>
    {/if}

    {#if playerStore.isReconnecting && !probeState.error && !playerStore.error}
        <!-- Hide the "reconnecting" badge once a TERMINAL error is shown
             (server FFmpeg failure via probeState.error, or a fatal
             playerStore.error). A final error means we're not reconnecting —
             showing both stacked the badge on top of "Playback failed to start". -->
        <div class="reconnect-badge" role="status" aria-live="polite">
            <span class="reconnect-spinner" aria-hidden="true"></span>
            <span class="reconnect-text">
                {playerStore.reconnectNeedsTap
                    ? m.player_reconnecting_tap()
                    : m.player_reconnecting()}
                {#if !playerStore.reconnectNeedsTap}
                    <span class="reconnect-diagnostic">{reconnectDiagnostic}</span>
                {/if}
            </span>
        </div>
    {/if}

    {#if encoderNoticeVisible && !infoBadgesVisible}
        <!-- Same anchor as the badges; with the badges shown it is their last row. -->
        <div class="transcode-notice-anchor">
            <TranscodeNoticeBadge notice={encoderNotice} />
        </div>
    {/if}

    {#if probeState.error}
        <!-- Server-side FFmpeg startup failure. Preferred over playerStore.error
             because this arrives before hls.js even notices the missing init
             segment — showing both would stack two overlays. -->
        <div class="center-overlay error">
            <div class="error-icon">
                <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
                    <path
                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                </svg>
            </div>
            <p class="error-title">{m.player_ffmpeg_error_title()}</p>
            <p class="error-text">
                {m.player_ffmpeg_error_body({
                    message: probeState.error.message,
                })}
            </p>
            <button class="retry-button" onclick={() => window.location.reload()}>
                {m.retry()}
            </button>
        </div>
    {:else if playerStore.error && !playerStore.isReconnecting}
        <div class="center-overlay error">
            <div class="error-icon">
                <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
                    <path
                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                </svg>
            </div>
            <p class="error-text">{playerStore.error}</p>
            <button class="retry-button" onclick={() => window.location.reload()}>
                {m.retry()}
            </button>
        </div>
    {/if}

    <!-- Big play button when paused -->
    {#if playerStore.isPaused && !playerStore.isLoading && !playerStore.isBuffering && !playerStore.error && !probeState.error}
        <div class="center-overlay play-indicator">
            <div class="big-play-button">
                {#if logoSmall}
                    <img src={logoSmall} alt={m.play()} class="branded-play-logo" />
                {:else}
                    <svg viewBox="0 0 24 24" fill="currentColor" width="64" height="64">
                        <path d="M8 5v14l11-7z" />
                    </svg>
                {/if}
            </div>
        </div>
    {/if}
</div>

<style>
    .overlay-container {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
    }

    .overlay-container.visible {
        opacity: 1;
    }

    .top-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        background: linear-gradient(rgba(0, 0, 0, 0.8), transparent);
        padding: 1rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        opacity: 0;
        /* Local player-container z-index tier (see the comment on
           VideoPlayer.svelte's .video-element): backdrop 0, video 1,
           overlays 2, controls 3. Without this, this positioned element
           defaults to z-index:auto and paints BEHIND the video (z-index:1)
           per CSS painting order, so clicks on the back button never reach
           it. */
        z-index: 2;
        transition: opacity 0.3s ease;
        pointer-events: auto;
    }

    .top-overlay.visible {
        opacity: 1;
    }

    .back-button {
        background: rgba(0, 0, 0, 0.5);
        border: none;
        color: white;
        cursor: pointer;
        padding: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background-color 0.2s;
    }

    .back-button:hover {
        background: rgba(255, 255, 255, 0.2);
    }

    .title {
        font-size: 1.25rem;
        font-weight: 500;
        color: white;
        margin: 0;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .info-badges-container {
        position: absolute;
        top: 4rem; /* Below title bar */
        left: 1.5rem; /* Left side to avoid avatar/watch party on right */
        z-index: 10;
        pointer-events: auto;
        opacity: 0.7;
        transition: opacity 0.2s;
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 0.35rem;
        max-width: 50%; /* Don't take too much space */
    }

    .info-badges-container:hover {
        opacity: 1;
    }

    /* The encoder notice: the badges' last row, or alone at their anchor. */
    .transcode-notice-row {
        flex-basis: 100%;
    }

    .transcode-notice-anchor {
        position: absolute;
        top: 4rem;
        left: 1.5rem;
        z-index: 10;
        max-width: min(36rem, calc(100% - 3rem));
        pointer-events: none;
    }

    .info-badge {
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        color: white;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        letter-spacing: 0.3px;
        white-space: nowrap;
        backdrop-filter: blur(4px);
        /* Fixed-width digits: live values (fps, %, Mbps) must not resize the
           badge on every update and shift the badges beside it. */
        font-variant-numeric: tabular-nums;
    }

    /* Playback method badges */
    .playmethod-badge.direct {
        background: rgba(46, 204, 113, 0.9); /* Green */
    }

    .playmethod-badge.remux {
        background: rgba(52, 152, 219, 0.9); /* Blue */
    }

    .playmethod-badge.transcode {
        background: rgba(241, 196, 15, 0.9); /* Yellow */
        color: #333;
    }

    .playmethod-badge.audio-transcode {
        background: rgba(168, 85, 247, 0.9); /* Purple */
    }

    .abr-badge {
        background: rgba(20, 184, 166, 0.9); /* Teal until the playing variant is known */
        transition: background-color 0.3s ease;
    }

    .abr-badge.abr-top {
        background: rgba(46, 204, 113, 0.9); /* Green */
    }

    .abr-badge.abr-high {
        background: rgba(20, 184, 166, 0.9); /* Teal */
    }

    .abr-badge.abr-low {
        background: rgba(245, 158, 11, 0.9); /* Amber */
        color: #333;
    }

    .abr-badge.abr-bottom {
        background: rgba(239, 68, 68, 0.9); /* Red */
    }

    .tooltip-header.abr {
        background: rgba(20, 184, 166, 0.2);
        color: #2dd4bf;
    }

    .tooltip-row.abr-playing span,
    .tooltip-row.abr-playing strong {
        color: #2dd4bf;
    }

    .resolution-badge {
        background: rgba(59, 130, 246, 0.9); /* Blue */
    }

    .fps-badge {
        background: rgba(107, 114, 128, 0.85); /* Gray — matches bitrate-badge */
        font-size: 9px;
    }

    .hdr-badge {
        background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 50%, #667eea 100%);
    }

    .hdr-badge.tonemap-software {
        background: rgba(245, 158, 11, 0.9); /* Amber — same as .codec-badge.transcoding */
    }

    .codec-badge {
        background: rgba(34, 197, 94, 0.9); /* Green for direct */
    }

    .codec-badge.transcoding {
        background: rgba(245, 158, 11, 0.9); /* Amber for transcoding */
    }

    .bitrate-badge {
        background: rgba(107, 114, 128, 0.85); /* Gray */
        font-size: 9px;
    }

    .bitrate-badge.transcoding {
        background: rgba(239, 68, 68, 0.85); /* Red for bitrate reduction */
    }

    .transcode-progress-badge {
        background: rgba(14, 165, 233, 0.85); /* Sky blue */
        display: flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 9px;
    }

    .transcode-progress-badge.complete {
        background: rgba(46, 204, 113, 0.85); /* Green when done */
    }

    .transcode-progress-badge.slow {
        background: rgba(245, 158, 11, 0.9); /* Amber when encoding falls behind realtime */
    }

    .transcode-progress-badge.paused {
        background: rgba(100, 116, 139, 0.9); /* Slate: throttled, far enough ahead */
    }

    .tooltip-header.transcode-progress {
        background: rgba(14, 165, 233, 0.2);
        color: #0ea5e9;
    }

    .transcode-progress-bar {
        position: relative;
        height: 4px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 0.5rem;
    }

    .transcode-progress-fill {
        position: absolute;
        top: 0;
        height: 100%;
        background: linear-gradient(90deg, #0ea5e9, #38bdf8);
        border-radius: 2px;
        transition:
            left 0.5s ease,
            width 0.5s ease;
    }

    .transcode-progress-encoder {
        position: absolute;
        top: 0;
        width: 2px;
        height: 100%;
        margin-left: -1px;
        background: #fff;
        transition: left 0.5s ease;
    }

    .transcode-stats {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.7);
        margin-bottom: 0.25rem;
    }

    .transcode-reasons-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 0.5rem 0;
    }

    .speed-badge {
        background: rgb(var(--color-primary-500-rgb) / 0.85); /* Primary */
        display: flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 9px;
    }

    /* Custom tooltip container */
    .badge-with-tooltip {
        position: relative;
        display: inline-flex;
        align-items: stretch;
    }

    .badge-with-tooltip .info-badge {
        display: flex;
        align-items: center;
    }

    .custom-tooltip {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        min-width: 280px;
        max-width: 360px;
        background: rgba(15, 15, 15, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 0;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(16px);
        opacity: 0;
        visibility: hidden;
        transform: translateY(-4px);
        transition: all 0.2s ease;
        z-index: 1000;
        pointer-events: auto;
    }

    .custom-tooltip::before {
        content: '';
        position: absolute;
        top: -8px;
        left: 0;
        right: 0;
        height: 8px;
    }

    .badge-with-tooltip:hover .custom-tooltip,
    .badge-with-tooltip:focus-within .custom-tooltip {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
    }

    .tooltip-header {
        padding: 0.6rem 0.8rem;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px 8px 0 0;
    }

    .tooltip-header.direct {
        background: rgba(46, 204, 113, 0.2);
        color: #2ecc71;
    }

    .tooltip-header.remux {
        background: rgba(52, 152, 219, 0.2);
        color: #3498db;
    }

    .tooltip-header.transcode {
        background: rgba(241, 196, 15, 0.2);
        color: #f1c40f;
    }

    .tooltip-header.audio-transcode {
        background: rgba(168, 85, 247, 0.2);
        color: #a855f7;
    }

    .tooltip-header.hdr {
        background: rgba(245, 158, 11, 0.2);
        color: #f59e0b;
    }

    .tooltip-header.hdr.dv {
        background: rgba(168, 85, 247, 0.2);
        color: #c084fc;
    }

    .hdr-explain {
        font-size: 11px;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.85);
    }

    .tooltip-header.codec {
        background: rgba(34, 197, 94, 0.2);
        color: #22c55e;
    }

    .tooltip-body {
        padding: 0.7rem 0.8rem;
        font-size: 11px;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.9);
    }

    .tooltip-reason {
        margin-top: 0.4rem;
        padding: 0.35rem 0.5rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.8);
        border-left: 2px solid rgba(241, 196, 15, 0.6);
    }

    .tooltip-reason.paused {
        border-left-color: rgba(148, 163, 184, 0.7);
    }

    .tooltip-note {
        margin-top: 0.5rem;
        font-size: 10px;
        color: rgba(255, 255, 255, 0.5);
        font-style: italic;
    }

    .tooltip-meta {
        padding: 0.6rem 0.8rem;
        background: rgba(255, 255, 255, 0.03);
        border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .tooltip-row {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 0.35rem;
        font-size: 10px;
    }

    .tooltip-row:last-child {
        margin-bottom: 0;
    }

    .tooltip-row span {
        color: rgba(255, 255, 255, 0.55);
    }

    .tooltip-row strong {
        color: rgba(255, 255, 255, 0.92);
        font-weight: 600;
        text-align: right;
    }

    .tooltip-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 0.55rem 0;
    }

    .tooltip-caps {
        padding: 0.5rem 0.8rem;
        font-size: 9px;
        color: rgba(255, 255, 255, 0.5);
        background: rgba(255, 255, 255, 0.03);
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 0 0 8px 8px;
    }

    .speed-badge svg {
        opacity: 0.9;
    }

    .center-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        color: white;
        pointer-events: auto;
        /* Same local tier as .top-overlay above (2) — see the comment there
           and on VideoPlayer.svelte's .video-element. Without it the Retry
           button and big play button both live behind the video. */
        z-index: 2;
    }

    .reconnect-badge {
        position: absolute;
        top: 1rem;
        left: 1rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        max-width: calc(100% - 2rem);
        padding: 0.4rem 0.75rem;
        background: rgba(0, 0, 0, 0.7);
        color: rgba(255, 255, 255, 0.95);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        pointer-events: none;
        z-index: 5;
        backdrop-filter: blur(4px);
    }

    .reconnect-text {
        display: flex;
        flex-direction: column;
    }

    .reconnect-diagnostic {
        margin-top: 0.1rem;
        color: rgba(255, 255, 255, 0.7);
        font-size: 11px;
        font-weight: 400;
    }

    .reconnect-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: rgba(255, 255, 255, 0.95);
        animation: reconnect-spin 0.8s linear infinite;
    }

    @keyframes reconnect-spin {
        to {
            transform: rotate(360deg);
        }
    }

    .spinner {
        color: white;
    }

    .status-text {
        font-size: 14px;
        opacity: 0.8;
        margin: 0;
        text-align: center;
        max-width: 320px;
    }

    .probe-progress-bar {
        width: 260px;
        height: 6px;
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
        overflow: hidden;
        margin-top: 0.25rem;
    }

    .probe-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #0ea5e9, #38bdf8);
        border-radius: 3px;
        transition: width 0.4s ease;
    }

    .probe-progress-fill.indeterminate {
        width: 40%;
        animation: probe-slide 1.4s ease-in-out infinite;
    }

    @keyframes probe-slide {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(350%);
        }
    }

    .probe-progress-label {
        font-size: 12px;
        opacity: 0.7;
        margin: 0;
        letter-spacing: 0.2px;
    }

    .center-overlay.error {
        text-align: center;
        max-width: 300px;
    }

    .error-icon {
        color: #e50914;
    }

    .error-title {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.95);
    }

    .error-text {
        margin: 0;
        font-size: 14px;
        color: rgba(255, 255, 255, 0.9);
    }

    .retry-button {
        background: #e50914;
        color: white;
        border: none;
        padding: 0.75rem 2rem;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .retry-button:hover {
        background: #f40612;
    }

    .center-overlay.play-indicator {
        pointer-events: none;
    }

    .big-play-button {
        background: rgba(0, 0, 0, 0.6);
        border-radius: 50%;
        padding: 1.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition:
            transform 0.2s,
            background-color 0.2s;
    }

    .big-play-button:hover {
        background: rgba(0, 0, 0, 0.8);
        transform: scale(1.1);
    }

    .branded-play-logo {
        width: 80px;
        height: 80px;
        object-fit: contain;
        filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
    }

    /* Mobile adjustments */
    @media (max-width: 640px) {
        .top-overlay {
            padding: 0.75rem;
            padding-top: max(0.75rem, env(safe-area-inset-top));
            padding-left: max(0.75rem, env(safe-area-inset-left));
            padding-right: max(0.75rem, env(safe-area-inset-right));
        }

        .title {
            font-size: 0.9rem;
            max-width: calc(100% - 120px); /* Leave space for badges on right */
        }

        /* Info badges on left side - below title on mobile */
        .info-badges-container {
            top: 3.5rem;
            left: 0.75rem;
            gap: 0.25rem;
            max-width: 60%;
        }

        .transcode-notice-anchor {
            top: 3.5rem;
            left: 0.75rem;
            max-width: calc(100% - 1.5rem);
        }

        .info-badge {
            padding: 0.15rem 0.35rem;
            font-size: 8px;
        }

        /* Desktop-only: not enough badge real estate on small screens. */
        .fps-badge {
            display: none;
        }

        .big-play-button {
            padding: 1rem;
        }

        .big-play-button svg {
            width: 48px;
            height: 48px;
        }

        .branded-play-logo {
            width: 60px;
            height: 60px;
        }
    }

    /* Landscape mobile - use safe areas for notch/home indicator */
    @media (max-width: 920px) and (orientation: landscape) {
        .top-overlay {
            padding-top: max(0.5rem, env(safe-area-inset-top));
            padding-left: max(1rem, env(safe-area-inset-left));
            padding-right: max(1rem, env(safe-area-inset-right));
        }

        .info-badges-container {
            left: max(1rem, env(safe-area-inset-left));
            top: 3.5rem;
        }

        .transcode-notice-anchor {
            left: max(1rem, env(safe-area-inset-left));
            top: 3.5rem;
        }
    }
</style>
