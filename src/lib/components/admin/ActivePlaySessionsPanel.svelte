<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import LiveTvDiagnostics from './LiveTvDiagnostics.svelte';
    import { page } from '$app/state';
    import { untrack } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { adminWorkspaceUrl, writeAdminWorkspaceUrl } from './admin-workspace-url';
    import AdminWorkspaceTabs from './AdminWorkspaceTabs.svelte';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        StopCircle,
        Stop,
        Film,
        MusicalNote,
        DevicePhoneMobile,
        ComputerDesktop,
        Clock,
        PlayCircle,
        PauseCircle,
        CheckCircle,
        ChevronDown,
        Signal,
        Bolt,
        Tv,
        ExclamationTriangle,
        Cog,
        ArrowPath,
        ArrowTopRightOnSquare,
        ClipboardDocument,
        ChatBubbleOvalLeft,
        XCircle,
        WrenchScrewdriver,
        type IconSource,
    } from 'svelte-hero-icons';
    import SendSessionMessageModal from './SendSessionMessageModal.svelte';
    import PlaybackPlanModal from './PlaybackPlanModal.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { sendSessionMessage } from '$lib/api/admin';
    import { trackDeviceCommand } from '$lib/utils/device-command-tracker';
    import { isSettled } from '$lib/utils/device-remote';
    import Tooltip, { type TooltipLine } from '$lib/components/ui/Tooltip.svelte';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import { displayName } from '$lib/utils/data-extraction';
    import { detectFormFactor, type FormFactor } from '$lib/utils/user-agent';
    import { formatElapsed, getDisplayStatus } from '$lib/utils/metric-formatters';
    import { getStatusColor, getStatusBg } from '$lib/utils/metric-styles';
    import { formatHdrLabel, hdrBadgeColor } from '$lib/shared/hdr-labels';
    import { getPlayMethodShortLabel } from '$lib/utils/playback-method';
    import {
        getAvatarUrl,
        getCatalogPosterSrcSet,
        getCatalogPosterUrl,
    } from '$lib/utils/image-utils';
    import { openMediaModalFromUrl } from '$lib/utils/modal-utils';
    import { isSeries, isEpisode, isAudio, isMusic } from '$lib/utils/media-types';
    import {
        deriveDelivery,
        deriveSessionState,
        isStruggling,
        type Delivery,
        type Method,
        type Health,
    } from '$lib/shared/session-state';
    import type { ProxyStatusResponse } from '$lib/schemas/livetv';
    import AdaptiveStreamBadge from '$lib/components/sessions/AdaptiveStreamBadge.svelte';
    import { adaptiveEncoderFor, variantName } from '$lib/components/sessions/adaptive-display';
    import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';
    import type { FFmpegJobInfo } from '$lib/types/admin-metrics';
    import { resolve } from '$lib/paths';
    import { announcesFeature, CLIENT_FEATURE_ADMIN_MESSAGE } from '$lib/shared/client-features';
    import { maintenanceNotice } from '$lib/stores/maintenance-notice.store.svelte';
    import { formatCountdown } from '$lib/utils/countdown.js';
    import CrossfadeStreamIndicator from '$lib/components/music/CrossfadeStreamIndicator.svelte';

    const NO_MESSAGE_SUPPORT_HINT =
        "This client can't display messages — it didn't announce support for them";

    /** IPs a Jellyfin-mirrored poll session reports when it has no real client IP to give. */
    function isUnknownIp(ip: string | null | undefined): boolean {
        return !ip || ip === '0.0.0.0' || ip === '::';
    }

    /**
     * Friendly label for ffprobe's raw `format_name`, which is often a
     * comma-joined muxer alias list (e.g. "mov,mp4,m4a,3gp,3g2,mj2" for the
     * ISOBMFF muxer, which is what everyone actually calls "MP4"). Falls back
     * to the first token, upper-cased, for anything not in the table — the
     * raw string stays available via the caller's title tooltip.
     */
    const CONTAINER_FRIENDLY_NAMES: Record<string, string> = {
        'mov,mp4,m4a,3gp,3g2,mj2': 'MP4',
        'matroska,webm': 'MKV',
        mpegts: 'MPEG-TS',
        avi: 'AVI',
        asf: 'ASF',
        flac: 'FLAC',
        ogg: 'OGG',
        wav: 'WAV',
    };

    function containerFriendlyName(raw: string): string {
        const known = CONTAINER_FRIENDLY_NAMES[raw];
        if (known) return known;
        const first = raw.split(',')[0]?.trim();
        return first ? first.toUpperCase() : raw;
    }

    interface Props {
        sessions: AdminPlaySession[];
        loading: boolean;
        proxyStatus: ProxyStatusResponse | null;
        liveTvError: boolean;
        isStandalone: boolean;
        jobsBySession: Map<string, FFmpegJobInfo[]>;
        killingSessionId: string | null;
        killingChannelId: string | null;
        stoppingJobId: string | null;
        onKillSession: (id: string, username: string, title: string) => void;
        onKillChannel: (channelId: string, channelName: string) => void;
        onStopJob: (playSessionId: string) => void;
        /** "Message users" page; the header links there (live message + maintenance chip). */
        messageUsersHref?: string;
        urlFilters?: boolean;
        loadError?: boolean;
        /** FFMPEG_SEGMENT_DURATION from the ffmpeg-jobs config — turns segment counts into seconds. */
        segmentDurationSec?: number;
    }

    let {
        sessions,
        loading,
        proxyStatus,
        liveTvError,
        isStandalone,
        jobsBySession,
        killingSessionId,
        killingChannelId,
        stoppingJobId,
        onKillSession,
        onKillChannel,
        onStopJob,
        messageUsersHref,
        urlFilters = false,
        loadError = false,
        segmentDurationSec,
    }: Props = $props();

    // ── Maintenance chip countdown ──────────────────────────────
    // Ticks only while a banner is live.
    let maintenanceNow = $state(Date.now());
    $effect(() => {
        if (!maintenanceNotice.notice) return;
        const id = setInterval(() => (maintenanceNow = Date.now()), 1000);
        return () => clearInterval(id);
    });

    // ── Row expansion ───────────────────────────────────────────
    // A `?session=<id>` link (the Home avatars) opens that row on arrival.
    const expandedSessions = new SvelteSet<string>(
        untrack(() => {
            const id = page.url.searchParams.get('session');
            return id ? [id] : [];
        }),
    );
    function toggleExpanded(id: string): void {
        if (expandedSessions.has(id)) expandedSessions.delete(id);
        else expandedSessions.add(id);
    }

    // ── Bandwidth sparkline ─────────────────────────────────────
    // The page polls every 5 s; keep the last 2 minutes per session in memory.
    // Nothing server-side stores this history, so it starts empty on each visit.
    const BANDWIDTH_SAMPLES = 24;
    const bandwidthHistory = new SvelteMap<string, number[]>();
    $effect(() => {
        const current = sessions;
        untrack(() => {
            const live = new Set(current.map((s) => s.__id));
            for (const id of [...bandwidthHistory.keys()]) {
                if (!live.has(id)) bandwidthHistory.delete(id);
            }
            for (const session of current) {
                const prev = bandwidthHistory.get(session.__id) ?? [];
                const next = [...prev, session.bandwidth_mbps ?? 0].slice(-BANDWIDTH_SAMPLES);
                bandwidthHistory.set(session.__id, next);
            }
        });
    });
    function sparklinePoints(samples: number[]): string {
        const max = Math.max(...samples, 0.1);
        const step = 40 / Math.max(1, samples.length - 1);
        return samples
            .map((v, i) => `${(i * step).toFixed(1)},${(15 - (v / max) * 14).toFixed(1)}`)
            .join(' ');
    }

    /** "HEVC → H.264 · h264_qsv · 34% CPU" — the job behind a transcode, or source quality for direct play. */
    function deliverySummary(session: AdminPlaySession, delivery: Delivery): string {
        if (!delivery.encoder) {
            return [session.resolution, formatSessionBitrate(session.bitrate_kbps)]
                .filter(Boolean)
                .join(' · ');
        }
        const codecs =
            session.video_codec && delivery.outputCodec
                ? `${session.video_codec.toUpperCase()} → ${delivery.outputCodec.toUpperCase()}`
                : undefined;
        // Software encode: "CPU 88%". Hardware: "h264_qsv · GPU 61%".
        const engine =
            delivery.encoder === 'CPU'
                ? `CPU${delivery.cpuPercent != null ? ` ${Math.round(delivery.cpuPercent)}%` : ''}`
                : [
                      delivery.encoder,
                      delivery.gpuPercent != null
                          ? `GPU ${Math.round(delivery.gpuPercent)}%`
                          : undefined,
                  ]
                      .filter(Boolean)
                      .join(' · ');
        return [codecs, engine].filter(Boolean).join(' · ');
    }

    function deliveryHint(delivery: Delivery): string | undefined {
        const parts: string[] = [];
        if (delivery.slowReason) {
            parts.push(
                delivery.slowReason === 'gpu_busy'
                    ? m.admin_sessions_slow_gpu_busy_hint()
                    : m.admin_sessions_slow_cpu_slow_hint(),
            );
        }
        if (delivery.softwareFallbackFrom) {
            parts.push(
                m.admin_sessions_software_fallback_hint({
                    encoder: delivery.softwareFallbackFrom,
                }),
            );
        }
        if (delivery.encodeSpeed != null) {
            parts.push(
                m.admin_sessions_encode_speed_hint({ speed: delivery.encodeSpeed.toFixed(1) }),
            );
        }
        if (delivery.headroomSec != null) {
            parts.push(
                m.admin_sessions_headroom_hint({ seconds: Math.round(delivery.headroomSec) }),
            );
        }
        return parts.length ? parts.join('\n') : undefined;
    }

    function bufferTextColor(sec: number | undefined): string {
        if (sec == null) return 'text-surface-300';
        if (sec < 2) return 'text-red-300';
        if (sec < 10) return 'text-amber-300';
        return 'text-surface-300';
    }

    let expandedJobId = $state<string | null>(null);
    let expandedPayloadId = $state<string | null>(null);
    let posterErrors = $state(new Set<string>());

    /** How long to wait for a device to report what it did with an admin message. */
    const ADMIN_MESSAGE_FOLLOW_MS = 30_000;

    // Message modal state
    let messageModalOpen = $state(false);
    let messageModalSessionId = $state<string | null>(null);

    // Plan inspector state — null when closed; when set, the modal
    // fetches the plan from /api/admin/playback-plans/[planId].
    let viewingPlanId = $state<string | null>(null);
    let messageModalLabel = $state('');

    /**
     * Whether this session's client announced it can draw an admin message.
     *
     * Absent and empty are the SAME answer — "announces nothing" — which is
     * what every client build from before the feature list existed reports,
     * along with every mirrored session that has no client to ask. The button
     * is DISABLED rather than hidden: an operator who remembers it being there
     * needs to learn why it is not usable, and a vanished control teaches
     * nothing. The reason is in the tooltip.
     */
    function canRenderMessages(session: AdminPlaySession): boolean {
        return announcesFeature(session.clientFeatures, CLIENT_FEATURE_ADMIN_MESSAGE);
    }

    function openMessageModal(session: AdminPlaySession): void {
        const parts = [
            displayName(session.username),
            deviceLabel(session) || 'Unknown device',
            session.series_title || session.title,
        ].filter(Boolean);
        messageModalLabel = parts.join(' · ');
        messageModalSessionId = session.__id;
        messageModalOpen = true;
    }

    async function handleSendSessionMessage(body: {
        message: string;
        severity: 'info' | 'warning' | 'error';
        durationMs: number;
    }): Promise<void> {
        if (!messageModalSessionId) return;
        const { data, error } = await sendSessionMessage(messageModalSessionId, {
            text: body.message,
            severity: body.severity,
        });
        if (error || !data) {
            toasts.error(error || m.admin_session_message_failed());
            return;
        }
        messageModalOpen = false;

        if (data.delivery !== 'command' || !data.command) {
            toasts.success(m.admin_session_message_sent());
            return;
        }

        // A device reports what it did: follow the command (the admin is its
        // sender, so the status frames reach this account).
        void trackDeviceCommand(data.command, {
            timeoutMs: ADMIN_MESSAGE_FOLLOW_MS,
            onUpdate: (command) => {
                if (command.status === 'delivered') {
                    toasts.success(m.admin_session_message_delivered());
                } else if (command.status === 'applied') {
                    toasts.success(m.admin_session_message_shown());
                } else if (command.status === 'acknowledged') {
                    toasts.success(m.admin_session_message_read());
                } else if (isSettled(command)) {
                    toasts.error(m.admin_session_message_not_shown());
                }
            },
        });
    }

    // Clear expandedJobId if the job no longer exists
    $effect(() => {
        if (expandedJobId) {
            const allJobs = [...jobsBySession.values()].flat();
            if (!allJobs.some((j) => j.jobId === expandedJobId)) {
                expandedJobId = null;
            }
        }
    });

    function formatPosition(ms: number): string {
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    /** Watch-session progress 0-100, or null when duration isn't known yet. */
    function watchProgressPercent(session: AdminPlaySession): number | null {
        if (!session.playItemDuration || session.playItemDuration <= 0) return null;
        const current = session.playCurrentTime ?? 0;
        return Math.min(100, Math.max(0, (current / session.playItemDuration) * 100));
    }

    function formatElapsedSince(isoDate: string): string {
        const parsed = new Date(isoDate).getTime();
        if (isNaN(parsed)) return '?';
        const diff = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
        if (diff < 60) return `${diff}s`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        return `${h}h ${m}m`;
    }

    /** Classes intentionally use lighter `/20` backgrounds — session rows are
     *  visually dense, so pills here stay subtler than the plan-modal variant. */
    function methodPill(method: Method): { label: string; classes: string } {
        switch (method.kind) {
            case 'direct':
                return {
                    label: getPlayMethodShortLabel('direct'),
                    classes: 'text-emerald-400 border-emerald-700/40 bg-emerald-900/20',
                };
            case 'remux':
                return {
                    label: getPlayMethodShortLabel('remux'),
                    classes: 'text-blue-400 border-blue-700/40 bg-blue-900/20',
                };
            case 'audio_transcode':
                return {
                    label: getPlayMethodShortLabel('audio_transcode'),
                    classes: 'text-amber-300 border-amber-700/40 bg-amber-900/20',
                };
            case 'full_transcode':
                return {
                    label: getPlayMethodShortLabel('full_transcode'),
                    classes: 'text-red-300 border-red-700/40 bg-red-900/20',
                };
            case 'audio_only':
                return {
                    label: getPlayMethodShortLabel('audio_only'),
                    classes: 'text-amber-300 border-amber-700/40 bg-amber-900/20',
                };
            case 'starting':
                return {
                    label: 'Starting…',
                    classes: 'text-surface-300 border-surface-600 bg-surface-800/50',
                };
            case 'completing':
                return {
                    label: 'Completing',
                    classes: 'text-emerald-400 border-emerald-700/40 bg-emerald-900/20',
                };
        }
    }

    function healthDot(health: Health): {
        label: string;
        classes: string;
        dotColor: string;
    } {
        switch (health.kind) {
            case 'playing':
                return {
                    label: 'Playing',
                    classes: 'text-emerald-300',
                    dotColor: 'bg-emerald-500',
                };
            case 'paused':
                return {
                    label: 'Paused',
                    classes: 'text-amber-300',
                    dotColor: 'bg-amber-500',
                };
            case 'low_buffer':
                return {
                    label: `Low buffer (${health.seconds.toFixed(1)}s)`,
                    classes: 'text-amber-300',
                    dotColor: 'bg-amber-500',
                };
            case 'stalled':
                return {
                    label: `Stalled ${Math.round(health.since)}s`,
                    classes: 'text-red-300',
                    dotColor: 'bg-red-500 animate-pulse',
                };
            case 'errored':
                return {
                    label: 'Error',
                    classes: 'text-red-300',
                    dotColor: 'bg-red-500',
                };
        }
    }

    function posterMediaId(session: AdminPlaySession): string | undefined {
        if (isEpisode(session.media_type) && session.series_id) {
            return session.series_id;
        }
        return session.media_id;
    }

    /**
     * Locator badge on the poster ("S03E05"). Compact — no dots — so it
     * stays legible on the tiny thumbnail overlay.
     */
    function posterLocator(session: AdminPlaySession): string {
        const season =
            session.season_number != null
                ? `S${String(session.season_number).padStart(2, '0')}`
                : '';
        const episode =
            session.episode_number != null
                ? `E${String(session.episode_number).padStart(2, '0')}`
                : '';
        return `${season}${episode}`;
    }

    /**
     * Inline episode locator for the title row ("S03·E05"). Synthesized
     * locally — DO NOT read `session.season_title` here, it is whatever
     * Jellyfin's locale-configured "Season N" string looks like, which
     * leaks user-facing German into the admin UI.
     */
    function episodeLocator(session: AdminPlaySession): string {
        const season =
            session.season_number != null
                ? `S${String(session.season_number).padStart(2, '0')}`
                : '';
        const episode =
            session.episode_number != null
                ? `E${String(session.episode_number).padStart(2, '0')}`
                : '';
        if (season && episode) return `${season}·${episode}`;
        return `${season}${episode}`;
    }

    // Build the device label: "Lumastra Web · Firefox 30 on Windows".
    // `browsername` is already the parseUserAgent() result from the server —
    // skip it when it's redundant with clientname (e.g., app-identity clients
    // that send no browser UA return `browsername === clientname`).
    function deviceLabel(session: AdminPlaySession): string {
        const parts = [[session.clientname, session.clientVersion].filter(Boolean).join(' ')];
        if (session.browsername && session.browsername !== session.clientname) {
            parts.push(session.browsername);
        }
        return parts.filter(Boolean).join(' · ');
    }

    /**
     * Coarse device class for the inline form-factor chip.
     * Classifies from the raw UA first, then the friendly client name as a
     * fallback — native apps that don't send a browser UA still get tagged
     * (e.g. clientname "Lumastra iOS" → mobile).
     */
    function sessionFormFactor(session: AdminPlaySession): FormFactor {
        return detectFormFactor(session.user_agent_raw, session.clientname);
    }

    function formFactorChip(ff: FormFactor): { label: string; classes: string } | null {
        switch (ff) {
            case 'mobile':
                return {
                    label: 'Mobile',
                    classes: 'bg-teal-900/40 text-teal-300 border-teal-700/40',
                };
            case 'tablet':
                return {
                    label: 'Tablet',
                    classes: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/40',
                };
            case 'desktop':
                return {
                    label: 'Desktop',
                    classes: 'bg-slate-800/60 text-slate-300 border-slate-600/50',
                };
            case 'tv':
                return {
                    label: 'TV',
                    classes: 'bg-indigo-900/40 text-indigo-300 border-indigo-700/40',
                };
            default:
                return null;
        }
    }

    function deviceIcon(ff: FormFactor): IconSource {
        switch (ff) {
            case 'mobile':
            case 'tablet':
                return DevicePhoneMobile;
            case 'tv':
                return Tv;
            default:
                return ComputerDesktop;
        }
    }

    /**
     * Subtitle stream is "off" when no index AND no language tag is
     * present. Jellyfin and Lumastra both use null/undefined for off and
     * the heartbeat handler clears `subtitle_language` when
     * `subtitle_method` flips to 'none' (see play-sessions.queries.ts
     * heartbeat CASE), so the language column is a reliable presence
     * signal on its own. Mirrors the audio path where a Jellyfin-style
     * poller reports the language tag without a stream index.
     */
    function subtitleSelected(session: AdminPlaySession): boolean {
        const idx = session.subtitle_stream_index;
        if (idx != null && idx >= 0) return true;
        return Boolean(session.subtitle_language);
    }

    /**
     * Resolve which entry in `audio_tracks` the user is currently
     * hearing. Tries each signal in order:
     *   1. heartbeat-reported `audio_stream_index` (most authoritative)
     *   2. session-level `audio_language` matched against a track's
     *      language (fallback for pollers that report only the language)
     *   3. `isDefault`-flagged track (file-level default)
     * Returns undefined when none of the signals identify a track.
     *
     * Shared between `effectiveAudioLanguage` (drives the badge) and
     * `buildAudioTooltip` (drives the → arrow on the active row) so
     * they can never disagree about which track is active.
     */
    function activeAudioTrackIndex(session: AdminPlaySession): number | undefined {
        const tracks = session.audio_tracks;
        if (!tracks?.length) return undefined;

        if (session.audio_stream_index != null) {
            const byIdx = tracks.find((t) => t.index === session.audio_stream_index);
            if (byIdx) return byIdx.index;
        }

        if (session.audio_language) {
            const wanted = session.audio_language.toLowerCase();
            const byLang = tracks.find((t) => t.language?.toLowerCase() === wanted);
            if (byLang) return byLang.index;
        }

        const dflt = tracks.find((t) => t.isDefault);
        return dflt?.index;
    }

    /**
     * Resolve the language label for the active audio track. Uses
     * `activeAudioTrackIndex` to find the same track the tooltip
     * arrow will mark, so badge and tooltip always agree.
     */
    function effectiveAudioLanguage(session: AdminPlaySession): string | undefined {
        const tracks = session.audio_tracks;
        const activeIdx = activeAudioTrackIndex(session);
        if (activeIdx != null && tracks) {
            const active = tracks.find((t) => t.index === activeIdx);
            if (active?.language) return active.language.toUpperCase();
        }
        // No track-level match — fall back to whatever the session row
        // carries directly.
        if (session.audio_language) return session.audio_language.toUpperCase();
        return undefined;
    }

    /**
     * Resolve which entry in `subtitle_tracks` is currently rendering.
     * Returns undefined when subtitles are off (no selected index) OR
     * none of the signals identify a track. Same fallback chain as
     * `activeAudioTrackIndex` minus the `isDefault` step (subtitle
     * defaults are unreliable across containers and many sessions
     * legitimately have no track active).
     */
    function activeSubtitleTrackIndex(session: AdminPlaySession): number | undefined {
        if (!subtitleSelected(session)) return undefined;
        const tracks = session.subtitle_tracks;
        if (!tracks?.length) return undefined;

        if (session.subtitle_stream_index != null) {
            const byIdx = tracks.find((t) => t.index === session.subtitle_stream_index);
            if (byIdx) return byIdx.index;
        }

        if (session.subtitle_language) {
            const wanted = session.subtitle_language.toLowerCase();
            const byLang = tracks.find((t) => t.language?.toLowerCase() === wanted);
            if (byLang) return byLang.index;
        }

        return undefined;
    }

    /**
     * Resolve the language label for the active subtitle track. Returns
     * undefined when subtitles are off (no selected index).
     */
    function effectiveSubtitleLanguage(session: AdminPlaySession): string | undefined {
        if (!subtitleSelected(session)) return undefined;
        const tracks = session.subtitle_tracks;
        const activeIdx = activeSubtitleTrackIndex(session);
        if (activeIdx != null && tracks) {
            const active = tracks.find((t) => t.index === activeIdx);
            if (active?.language) return active.language.toUpperCase();
        }
        return session.subtitle_language?.toUpperCase();
    }

    function audioTrackCountLabel(session: AdminPlaySession): string | null {
        const n = session.audio_tracks?.length ?? 0;
        return n > 1 ? `×${n}` : null;
    }

    async function copyId(id: string, kind: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(id);
            toasts.success(`${kind} ID copied`);
        } catch {
            toasts.error('Copy failed');
        }
    }

    function bufferBarWidth(sec: number | undefined): number {
        if (sec == null) return 0;
        return Math.min((sec / 10) * 100, 100);
    }

    function bufferBarColor(sec: number | undefined): string {
        if (sec == null) return 'bg-surface-600';
        if (sec < 2) return 'bg-red-500';
        if (sec < 5) return 'bg-amber-500';
        return 'bg-emerald-500';
    }

    function bufferLabel(sec: number | undefined): string {
        if (sec == null) return '—';
        return `${sec.toFixed(1)}s`;
    }

    function hasBufferHealth(session: AdminPlaySession): boolean {
        return session.buffer_health_sec != null;
    }

    function bufferTooltip(session: AdminPlaySession): string {
        const current = session.buffer_health_sec;
        const status = session.playIsPlaying ? 'playing' : 'paused';
        if (current == null) {
            return 'Client buffer ahead is not available for this session.';
        }
        return `Client-reported buffered seconds ahead of the current playhead (${current.toFixed(
            1,
        )}s, ${status}). Derived from the browser video buffer, not server transcode progress.`;
    }

    /**
     * Colour an encoder chip by STATE first, kind second.
     *
     * Keying only on kind made a failed or terminating encoder look identical to a
     * healthy one — which defeats the point of listing them, since the reason to show
     * a stopping encoder at all is to explain a budget number that has no other
     * visible cause.
     */
    // "720p ×2 · 360p ×1": which variant the channel's adaptive viewers play now.
    function adaptiveViewersByVariant(channelId: string): string {
        const counts: Record<string, number> = {};
        for (const session of sessions) {
            if (session.media_id !== channelId || session.media_type !== 'tvchannel') continue;
            if (!session.adaptive?.current) continue;
            const name = variantName(session.adaptive.current);
            counts[name] = (counts[name] ?? 0) + 1;
        }
        return Object.entries(counts)
            .map(([name, count]) => `${name} ×${count}`)
            .join(' · ');
    }

    // The adaptive encoder group of the Live TV channel this session watches.
    function adaptiveEncoderForSession(session: AdminPlaySession) {
        if (!session.adaptive || !session.media_id || !proxyStatus) return null;
        const channel = proxyStatus.channels.find((c) => c.channelId === session.media_id);
        return adaptiveEncoderFor(channel?.encoders);
    }

    /** Health token -> translated label. Never render the raw wire token. */
    function encoderHealthLabel(health: string): string {
        if (health === 'starting') return m.admin_sessions_encoder_health_starting();
        if (health === 'degraded') return m.admin_sessions_encoder_health_degraded();
        if (health === 'failed') return m.admin_sessions_encoder_health_failed();
        return m.admin_sessions_encoder_health_healthy();
    }

    function encoderChipClass(enc: { kind: string; health: string; stopping?: boolean }): string {
        if (enc.health === 'failed') return 'bg-red-900/40 text-red-300 border-red-700/40';
        if (enc.stopping) return 'bg-surface-800/60 text-surface-300 border-surface-700/40';
        if (enc.health === 'starting') return 'bg-amber-900/40 text-amber-300 border-amber-700/40';
        if (enc.kind === 'ingest')
            return 'bg-surface-700/40 text-surface-300 border-surface-600/40';
        if (enc.kind === 'adaptive') return 'bg-purple-900/40 text-purple-300 border-purple-700/40';
        return 'bg-blue-900/40 text-blue-300 border-blue-700/40';
    }

    function capacityColor(active: number, max: number): string {
        const ratio = max > 0 ? active / max : 0;
        if (ratio >= 1) return 'bg-red-900/40 text-red-300 border-red-700/40';
        if (ratio >= 0.5) return 'bg-amber-900/40 text-amber-300 border-amber-700/40';
        return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40';
    }

    function getSessionJobs(sessionId: string): {
        jobs: FFmpegJobInfo[];
        errorCount: number;
        hasActive: boolean;
    } {
        const jobs = jobsBySession.get(sessionId) ?? [];
        const errorCount = jobs.filter((j) => j.error || j.status === 'error').length;
        const hasActive = jobs.some(
            (j) =>
                j.processRunning ||
                j.status === 'active' ||
                j.status === 'starting' ||
                j.status === 'ready',
        );
        return { jobs, errorCount, hasActive };
    }

    /**
     * Operator-facing label for a job's transcode type. Falls back to the raw
     * token for values that don't need a friendlier label.
     */
    function transcodeTypeLabel(type: string): string {
        if (type === 'audio-drop') return m.admin_sessions_transcode_type_audio_drop();
        return type;
    }

    function formatSessionBitrate(kbps: number | undefined): string {
        if (kbps == null || kbps <= 0) return '';
        if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
        return `${Math.round(kbps)} kbps`;
    }

    function formatBandwidth(mbps: number | undefined): string {
        if (mbps == null || mbps <= 0) return '';
        if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
        return `${(mbps * 1000).toFixed(0)} Kbps`;
    }

    /**
     * Treat blank/whitespace as missing. media_streams rows from older
     * probes can carry empty strings instead of NULL on display_title /
     * language / codec, and `??` doesn't catch empty string so the
     * naive label construction produced "→ " with nothing else.
     */
    function nonEmpty(s: string | null | undefined): string | undefined {
        if (!s) return undefined;
        const trimmed = s.trim();
        return trimmed ? trimmed : undefined;
    }

    function audioTrackLabel(t: {
        language?: string;
        codec?: string;
        channels?: number;
        displayTitle?: string;
        index: number;
    }): string {
        const dt = nonEmpty(t.displayTitle);
        if (dt) return dt;
        const parts: string[] = [];
        const lang = nonEmpty(t.language);
        parts.push(lang ? lang.toUpperCase() : 'UND');
        const codec = nonEmpty(t.codec);
        if (codec) parts.push(codec);
        if (t.channels && t.channels > 0) parts.push(`${t.channels}ch`);
        const joined = parts.join(' · ');
        // Final safety net: surface the index so a fully-empty row
        // never renders as a bare arrow with no anchor for the admin.
        return joined || `track ${t.index}`;
    }

    function subtitleTrackLabel(t: {
        language?: string;
        codec?: string;
        isForced: boolean;
        displayTitle?: string;
        index: number;
    }): string {
        const dt = nonEmpty(t.displayTitle);
        if (dt) return dt;
        const parts: string[] = [];
        const lang = nonEmpty(t.language);
        parts.push(lang ? lang.toUpperCase() : 'UND');
        const codec = nonEmpty(t.codec);
        if (codec) parts.push(codec);
        if (t.isForced) parts.push('forced');
        const joined = parts.join(' · ');
        return joined || `track ${t.index}`;
    }

    function buildAudioTooltip(session: AdminPlaySession): TooltipLine[] {
        const tracks = session.audio_tracks;
        if (!tracks?.length) return [{ text: session.audio_language ?? 'Unknown' }];
        const activeIdx = activeAudioTrackIndex(session);
        return tracks.map((t) => {
            const label = audioTrackLabel(t);
            const isCurrent = activeIdx != null && t.index === activeIdx;
            return isCurrent
                ? { text: `→ ${label}`, class: 'text-blue-300' }
                : { text: `   ${label}`, class: 'text-surface-300' };
        });
    }

    function buildSubtitleTooltip(session: AdminPlaySession): TooltipLine[] {
        const tracks = session.subtitle_tracks;
        if (!tracks?.length) return [{ text: session.subtitle_language ?? 'None' }];
        const activeIdx = activeSubtitleTrackIndex(session);
        const lines: TooltipLine[] = tracks.map((t) => {
            const label = subtitleTrackLabel(t);
            const isCurrent = activeIdx != null && t.index === activeIdx;
            return isCurrent
                ? { text: `→ ${label}`, class: 'text-purple-300' }
                : { text: `   ${label}`, class: 'text-surface-300' };
        });
        // Subtitles can be off — surface that as the first row, with the
        // arrow on it when no track is currently rendering.
        const hasActive = activeIdx != null;
        lines.unshift(
            hasActive
                ? { text: '   None', class: 'text-surface-300' }
                : { text: '→ None', class: 'text-purple-300' },
        );
        return lines;
    }

    function effectiveJobProgress(job: FFmpegJobInfo): number {
        if (job.progressPercent > 0) return job.progressPercent;
        if (
            job.totalSegments === 0 &&
            job.segmentsReady > 0 &&
            (job.status === 'ready' || !job.processRunning)
        )
            return 100;
        return 0;
    }

    function getModalMediaType(mediaType: string | undefined): 'movie' | 'tv' {
        if (!mediaType) return 'movie';
        if (isSeries(mediaType) || isEpisode(mediaType)) return 'tv';
        return 'movie';
    }

    function handleOpenModal(session: AdminPlaySession): void {
        if (!session.media_id) return;
        openMediaModalFromUrl(
            { internal: session.media_id },
            getModalMediaType(session.media_type),
        ).catch(() => {
            // Modal open failed (network error, deleted media, etc.) — silent for admin UI
        });
    }

    function jobSeverity(job: FFmpegJobInfo): number {
        if (job.error || job.status === 'error') return 0;
        if (job.lastProgressSecondsAgo > 30) return 1;
        if (job.status === 'starting' || job.status === 'ready') return 3;
        return 2;
    }

    type SourceBadge = { label: string; classes: string };

    /**
     * Sources whose playback a Terminate cannot actually stop.
     *
     * A kill marks our row KILLED (and the row stays dead — heartbeats and
     * creates both refuse to revive it), but the bytes are not ours: a
     * Jellyfin/Subsonic row mirrors another server's stream, and a 'local' row
     * is a file playing off the viewer's own device. Saying so in the tooltip
     * is the difference between an operator who knows the stream is still
     * running and one who thinks they stopped it.
     */
    function terminateHint(source: string | undefined): string {
        switch (source) {
            case 'jellyfin':
            case 'subsonic':
                return `${m.admin_sessions_terminate_label()} — ${m.admin_sessions_terminate_remote_note()}`;
            case 'local':
                return `${m.admin_sessions_terminate_label()} — ${m.admin_sessions_terminate_local_note()}`;
            default:
                return m.admin_sessions_terminate_label();
        }
    }

    function sourceBadge(source: string | undefined, deviceId?: string): SourceBadge {
        if (source === 'lumastra' && deviceId?.startsWith('jellyfin-compat-')) {
            return {
                label: '/j Compat',
                classes: 'bg-teal-900/50 text-teal-300 border-teal-700/40',
            };
        }
        switch (source) {
            case 'jellyfin':
                return {
                    label: 'Jellyfin',
                    classes: 'bg-purple-900/50 text-purple-300 border-purple-700/40',
                };
            case 'livetv':
                return {
                    label: 'LiveTV',
                    classes: 'bg-green-900/50 text-green-300 border-green-700/40',
                };
            case 'music':
                return {
                    label: 'Music',
                    classes: 'bg-pink-900/50 text-pink-300 border-pink-700/40',
                };
            case 'subsonic':
                return {
                    label: 'Subsonic',
                    classes: 'bg-amber-900/50 text-amber-300 border-amber-700/40',
                };
            case 'local':
                // Playing a file the device already downloaded. The bytes never
                // came from this server, so there is no bitrate, no transcode,
                // and Stop cannot actually stop it — see the title text below.
                return {
                    label: 'Downloaded',
                    classes: 'bg-slate-700/50 text-slate-300 border-slate-500/40',
                };
            default:
                return {
                    label: 'Lumastra',
                    classes: 'bg-blue-900/50 text-blue-300 border-blue-700/40',
                };
        }
    }

    function formatRelativeTime(isoDate: string | undefined): string {
        if (!isoDate) return '?';
        const parsed = new Date(isoDate).getTime();
        if (isNaN(parsed)) return '?';
        const diff = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        return `${Math.floor(diff / 3600)}h ago`;
    }

    function statusBadge(status: string | undefined): {
        label: string;
        classes: string;
    } {
        switch (status) {
            case 'ACTIVE':
                return {
                    label: 'Active',
                    classes: 'text-emerald-300 border-emerald-700/40 bg-emerald-900/20',
                };
            case 'PAUSED':
                return {
                    label: 'Paused',
                    classes: 'text-amber-300 border-amber-700/40 bg-amber-900/20',
                };
            case 'CRASHED':
                return {
                    label: 'Crashed',
                    classes: 'text-red-300 border-red-700/40 bg-red-900/20',
                };
            case 'COMPLETED':
                return {
                    label: 'Completed',
                    classes: 'text-surface-300 border-surface-600/40 bg-surface-800/30',
                };
            case 'KILLED':
                return {
                    label: 'Killed',
                    classes: 'text-red-400 border-red-800/40 bg-red-950/20',
                };
            default:
                return {
                    label: 'Unknown',
                    classes: 'text-surface-300 border-surface-600/40 bg-surface-800/30',
                };
        }
    }

    function truncateId(id: string | undefined): string {
        if (!id) return '—';
        return id.slice(-8);
    }

    let localFilters = $state({ q: '', media: 'all', health: 'all' });
    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let search = $derived(urlFilters ? (workspaceUrl.searchParams.get('q') ?? '') : localFilters.q);
    function filterValue(key: 'media' | 'health', allowed: string[]): string {
        const value = urlFilters ? workspaceUrl.searchParams.get(key) : localFilters[key];
        return value && allowed.includes(value) ? value : 'all';
    }
    let mediaTypeFilter = $derived(filterValue('media', ['all', 'music', 'video']));
    let healthFilter = $derived(filterValue('health', ['all', 'attention', 'paused']));

    function setFilter(key: 'q' | 'media' | 'health', value: string): void {
        if (!urlFilters) {
            localFilters = { ...localFilters, [key]: value };
            return;
        }
        const url = new URL(workspaceUrl);
        if (!value || value === 'all') url.searchParams.delete(key);
        else url.searchParams.set(key, value);
        writeAdminWorkspaceUrl(url, page.state, true);
    }

    function clearFilters(): void {
        if (!urlFilters) {
            localFilters = { q: '', media: 'all', health: 'all' };
            return;
        }
        const url = new URL(workspaceUrl);
        for (const key of ['q', 'media', 'health']) url.searchParams.delete(key);
        writeAdminWorkspaceUrl(url, page.state, true);
    }

    // Reuse the established classifier; paused sessions are not playback problems.
    /** Same rule as the amber row marker, so the filter count matches what is highlighted. */
    function needsAttention(session: AdminPlaySession): boolean {
        const jobs = jobsBySession.get(session.__id) ?? [];
        const state = deriveSessionState(session, jobs);
        return (
            session.isBuffering === true ||
            session.status === 'CRASHED' ||
            isStruggling(state, deriveDelivery(session, jobs, segmentDurationSec), jobs)
        );
    }

    let attentionCount = $derived(sessions.filter(needsAttention).length);
    let pausedCount = $derived(
        sessions.filter((session) => session.playIsPlaying === false).length,
    );
    let filteredSessions = $derived.by(() => {
        const query = search.trim().toLocaleLowerCase();
        return sessions
            .filter((session) => {
                const music =
                    isAudio(session.media_type) ||
                    isMusic(session.media_type) ||
                    session.media_type === 'track' ||
                    session.media_type === 'radio';
                if (mediaTypeFilter === 'music' && !music) return false;
                if (mediaTypeFilter === 'video' && music) return false;
                if (healthFilter === 'attention' && !needsAttention(session)) return false;
                if (healthFilter === 'paused' && session.playIsPlaying !== false) return false;
                return (
                    !query ||
                    [
                        session.username,
                        displayName(session.username),
                        session.title,
                        session.series_title,
                        deviceLabel(session),
                        session.__id,
                    ].some((value) => value?.toLocaleLowerCase().includes(query))
                );
            })
            .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
    });

    /**
     * Derive the cache-state badge label for a music audio_transcode session.
     * Returns null when no badge should be shown.
     */
    function musicCacheStateBadge(session: AdminPlaySession): string | null {
        const mode = session.music_transcode_mode;
        if (!mode) return null;
        if (mode === 'cached') return 'cached';
        if (mode === 'stream_copy_seek') return 'seek';
        if (mode === 'encode' || mode === 'encode_no_cache') return 'live';
        return null;
    }

    function musicCacheStateBadgeClasses(badge: string): string {
        if (badge === 'cached') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40';
        if (badge === 'seek') return 'bg-cyan-900/40 text-cyan-300 border-cyan-700/40';
        if (badge === 'live') return 'bg-amber-900/40 text-amber-300 border-amber-700/40';
        return 'bg-surface-800/60 text-surface-300 border-surface-600/40';
    }
</script>

<!-- ── Active Play Sessions ────────────────────────────────────── -->
<div>
    <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3
            class="text-sm font-medium text-surface-300 uppercase tracking-wider flex items-center gap-2">
            <Icon src={PlayCircle} class="w-4 h-4 text-yellow-400" />
            {m.admin_redesign_sessions_live_title()}
            {#if sessions.length > 0}
                <span class="text-surface-300 normal-case font-normal">{sessions.length}</span>
            {/if}
        </h3>
        {#if messageUsersHref}
            <div class="flex flex-wrap items-center gap-2">
                {#if maintenanceNotice.notice}
                    <!-- The global store every open app gets over SSE, so this
                         is exactly what viewers see right now. -->
                    <a
                        href={resolve(`${messageUsersHref}?kind=maintenance`)}
                        class="inline-flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40">
                        <Icon src={WrenchScrewdriver} class="h-3.5 w-3.5" />
                        {m.admin_sessions_maintenance_live({
                            left: formatCountdown(maintenanceNotice.notice.endsAt - maintenanceNow),
                        })}
                    </a>
                {/if}
                <a
                    href={resolve(`${messageUsersHref}?kind=live`)}
                    title={m.admin_sessions_broadcast_all_hint()}
                    class="inline-flex items-center gap-1.5 rounded-lg border border-blue-700/60 bg-blue-900/20 px-3 py-1.5 text-xs font-medium text-blue-300 hover:border-blue-600 hover:bg-blue-900/40">
                    <Icon src={ChatBubbleOvalLeft} class="h-3.5 w-3.5" />
                    {m.admin_sessions_message_users()}
                </a>
            </div>
        {/if}
    </div>

    <div class="rounded-xl border border-surface-700 bg-surface-900/40 p-3 mb-4 space-y-3">
        <AdminWorkspaceTabs
            label={m.admin_redesign_sessions_status_filter()}
            items={[
                {
                    id: 'all',
                    label: m.admin_redesign_sessions_all(),
                    count: loading || loadError ? undefined : sessions.length,
                },
                {
                    id: 'attention',
                    label: m.admin_redesign_sessions_attention(),
                    count: loading || loadError ? undefined : attentionCount,
                },
                {
                    id: 'paused',
                    label: m.admin_redesign_sessions_paused(),
                    count: loading || loadError ? undefined : pausedCount,
                },
            ]}
            value={healthFilter}
            onchange={(value) => setFilter('health', value)} />
        <div class="flex flex-wrap items-end gap-3">
            <label class="flex-1 min-w-40 text-xs text-surface-300">
                {m.admin_redesign_sessions_search()}
                <input
                    type="search"
                    value={search}
                    oninput={(event) => setFilter('q', event.currentTarget.value)}
                    placeholder={m.admin_redesign_sessions_search_hint()}
                    class="mt-1 w-full rounded-lg border border-surface-600 bg-surface-950 px-3 py-2 text-sm text-white" />
            </label>
            <label class="text-xs text-surface-300">
                {m.admin_redesign_sessions_media()}
                <select
                    value={mediaTypeFilter}
                    onchange={(event) => setFilter('media', event.currentTarget.value)}
                    class="mt-1 block rounded-lg border border-surface-600 bg-surface-950 px-3 py-2 text-sm text-white">
                    <option value="all">{m.admin_redesign_sessions_all()}</option>
                    <option value="music">{m.admin_redesign_sessions_music()}</option>
                    <option value="video">{m.admin_redesign_sessions_video()}</option>
                </select>
            </label>
            {#if search || mediaTypeFilter !== 'all' || healthFilter !== 'all'}
                <button
                    type="button"
                    class="rounded-lg px-3 py-2 text-sm text-sky-300 hover:bg-surface-800"
                    onclick={clearFilters}>{m.admin_redesign_sessions_clear()}</button>
            {/if}
        </div>
        <p class="text-xs text-surface-300">{m.admin_redesign_sessions_filter_note()}</p>
    </div>

    {#if loading}
        <div class="bg-surface-800/30 rounded-lg px-4 py-3 text-surface-300 text-sm">
            {m.admin_redesign_sessions_loading()}
        </div>
    {:else if loadError && sessions.length === 0}
        <p
            class="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-amber-200"
            role="status">
            {m.admin_redesign_sessions_unavailable()}
        </p>
    {:else if sessions.length === 0}
        <div
            class="bg-surface-800/30 rounded-lg px-4 py-3 text-surface-300 text-sm flex items-center gap-2">
            <Icon src={PlayCircle} class="w-4 h-4 opacity-50" />
            {m.admin_sessions_none_active()}
        </div>
    {:else if filteredSessions.length === 0}
        <div
            class="bg-surface-800/30 rounded-lg px-4 py-3 text-surface-300 text-sm flex items-center gap-2">
            <Icon src={PlayCircle} class="w-4 h-4 opacity-50" />
            {m.admin_redesign_sessions_no_matches()}
        </div>
    {:else}
        <div
            class="mb-1 hidden grid-cols-[minmax(0,1fr)_5.5rem] text-[11px] font-medium uppercase tracking-wider text-surface-300 lg:grid"
            aria-hidden="true">
            <div
                class="grid grid-cols-[2.5rem_minmax(7rem,1fr)_minmax(9rem,1.6fr)_minmax(9rem,1.3fr)_6.5rem_4.5rem_7.5rem] gap-x-4 px-3">
                <span></span>
                <span>{m.admin_sessions_col_viewer()}</span>
                <span>{m.admin_sessions_col_title()}</span>
                <span>{m.admin_sessions_col_delivery()}</span>
                <span>{m.admin_sessions_col_bandwidth()}</span>
                <span>{m.admin_sessions_col_buffer()}</span>
                <span>{m.admin_sessions_col_progress()}</span>
            </div>
            <span></span>
        </div>
        <div class="space-y-2">
            {#each filteredSessions as session (session.__id)}
                {@const sessionJobsInfo = getSessionJobs(session.__id)}
                {@const sessionJobs = sessionJobsInfo.jobs}
                {@const state = deriveSessionState(session, sessionJobs)}
                {@const methodUi = methodPill(state.method)}
                {@const healthUi = healthDot(state.health)}
                {@const hasJobs = state.resource.jobCount > 0}
                {@const posterId = posterMediaId(session)}
                {@const pLocator = posterLocator(session)}
                {@const epLocator = episodeLocator(session)}
                {@const hasPosterError = posterId ? posterErrors.has(posterId) : false}
                {@const srcBadge = sourceBadge(session.source, session.deviceId)}
                {@const statusUi = statusBadge(session.status)}
                {@const isPayloadExpanded = expandedPayloadId === session.__id}
                {@const formFactor = sessionFormFactor(session)}
                {@const ffChip = formFactorChip(formFactor)}
                {@const audioLang = effectiveAudioLanguage(session)}
                {@const audioCount = audioTrackCountLabel(session)}
                {@const subLang = effectiveSubtitleLanguage(session)}
                {@const subsOn = subtitleSelected(session)}
                {@const hasSubsAvailable = (session.subtitle_tracks?.length ?? 0) > 0}
                {@const cacheStateBadge = musicCacheStateBadge(session)}
                {@const canMessage = canRenderMessages(session)}
                {@const isJellyfinMirror = session.source === 'jellyfin'}
                {@const isExpanded = expandedSessions.has(session.__id)}
                {@const delivery = deriveDelivery(session, sessionJobs, segmentDurationSec)}
                {@const struggling = isStruggling(state, delivery, sessionJobs)}
                {@const deliveryDetail = deliverySummary(session, delivery)}
                {@const deliveryTooltip = deliveryHint(delivery)}
                {@const watchPct = watchProgressPercent(session)}
                {@const summaryTitle = [session.series_title, epLocator, session.title]
                    .filter(Boolean)
                    .join(' · ')}

                <div
                    class="bg-surface-800/45 border rounded-lg overflow-hidden transition-colors {state.severity ===
                    'error'
                        ? 'border-red-700/50'
                        : struggling
                          ? 'border-amber-600/50'
                          : 'border-surface-700/70'}">
                    <!-- Summary row: the fixed columns an operator scans across
                         sessions. Everything else is in the expansion below. -->
                    <div class="grid grid-cols-1 items-center sm:grid-cols-[minmax(0,1fr)_auto]">
                        <button
                            type="button"
                            class="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-700/20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-400 lg:grid-cols-[2.5rem_minmax(7rem,1fr)_minmax(9rem,1.6fr)_minmax(9rem,1.3fr)_6.5rem_4.5rem_7.5rem] lg:gap-x-4"
                            aria-expanded={isExpanded}
                            aria-label={m.admin_sessions_row_toggle({
                                username: displayName(session.username),
                                title: session.series_title || session.title,
                            })}
                            onclick={() => toggleExpanded(session.__id)}>
                            <!-- Poster -->
                            <span
                                class="relative row-span-3 h-[3.75rem] w-10 overflow-hidden rounded border border-surface-700/80 bg-surface-900/80 lg:row-span-1">
                                {#if posterId && !hasPosterError}
                                    <img
                                        src={getCatalogPosterUrl(posterId, {
                                            size: 'thumb',
                                            fallback:
                                                session.media_type === 'tvchannel'
                                                    ? 'none'
                                                    : undefined,
                                        })}
                                        alt=""
                                        loading="lazy"
                                        decoding="async"
                                        class="absolute inset-0 h-full w-full {session.media_type ===
                                        'tvchannel'
                                            ? 'object-contain p-1'
                                            : 'object-cover'}"
                                        onerror={() => {
                                            posterErrors = new Set([...posterErrors, posterId]);
                                        }} />
                                {:else}
                                    <span
                                        class="absolute inset-0 flex items-center justify-center bg-surface-900">
                                        <Icon
                                            src={session.media_type === 'tvchannel'
                                                ? Tv
                                                : isAudio(session.media_type) ||
                                                    isMusic(session.media_type)
                                                  ? MusicalNote
                                                  : Film}
                                            class="h-4 w-4 text-surface-300" />
                                    </span>
                                {/if}
                            </span>

                            <!-- Viewer (+ title on phones) -->
                            <span class="flex min-w-0 flex-col">
                                <span class="flex min-w-0 items-center gap-1.5">
                                    <Avatar
                                        size="2xs"
                                        username={session.username}
                                        src={getAvatarUrl(session.username)}
                                        initials={session.username.slice(0, 1).toUpperCase()}
                                        alt=""
                                        border="border border-surface-800" />
                                    <span class="truncate text-sm font-medium text-surface-100"
                                        >{displayName(session.username)}</span>
                                    {#if struggling}
                                        <Icon
                                            src={ExclamationTriangle}
                                            class="h-3.5 w-3.5 shrink-0 {state.severity === 'error'
                                                ? 'text-red-400'
                                                : 'text-amber-400'}"
                                            aria-label={m.admin_sessions_needs_look()} />
                                    {/if}
                                </span>
                                <span
                                    class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-surface-300">
                                    <Icon src={deviceIcon(formFactor)} class="h-3 w-3 shrink-0" />
                                    <span class="truncate" title={deviceLabel(session) || 'Unknown'}
                                        >{deviceLabel(session) || 'Unknown'}</span>
                                    {#if session.isCarPlay}
                                        <span
                                            class="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200"
                                            >CarPlay</span>
                                    {/if}
                                </span>
                            </span>

                            <!-- Title (desktop) -->
                            <span class="col-start-2 flex min-w-0 flex-col lg:col-start-auto">
                                <span
                                    class="truncate text-sm font-medium text-white"
                                    title={summaryTitle}
                                    >{session.series_title || session.title}</span>
                                {#if session.series_title}
                                    <span class="truncate text-xs text-surface-300"
                                        >{[epLocator, session.title]
                                            .filter(Boolean)
                                            .join(' · ')}</span>
                                {:else if session.artistName}
                                    <span class="truncate text-xs text-surface-300"
                                        >{session.artistName}</span>
                                {/if}
                            </span>

                            <!-- Delivery / bandwidth / buffer / progress: one wrapped line on
                                 phones, four aligned columns from lg up. -->
                            <span
                                class="col-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] lg:contents">
                                <span
                                    class="flex min-w-0 flex-col lg:text-xs"
                                    title={deliveryTooltip}>
                                    <span class="flex items-center gap-1.5">
                                        <span
                                            class="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium {methodUi.classes}"
                                            >{methodUi.label}</span>
                                        {#if session.adaptive}
                                            <AdaptiveStreamBadge adaptive={session.adaptive} />
                                        {/if}
                                        {#if delivery.encodeSpeed != null}
                                            <span
                                                class="font-mono {delivery.encodeSpeed < 1
                                                    ? 'text-amber-300'
                                                    : 'text-surface-300'}"
                                                >{delivery.encodeSpeed.toFixed(1)}×</span>
                                        {/if}
                                        {#if delivery.slowReason}
                                            <span
                                                class="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                                                data-testid="session-slow-transcode"
                                                >{delivery.slowReason === 'gpu_busy'
                                                    ? m.admin_sessions_slow_gpu_busy()
                                                    : m.admin_sessions_slow_cpu_slow()}</span>
                                        {/if}
                                    </span>
                                    {#if deliveryDetail}
                                        <span
                                            title={deliveryDetail}
                                            class="mt-0.5 hidden truncate text-xs text-surface-300 lg:block"
                                            >{deliveryDetail}</span>
                                    {/if}
                                </span>
                                <span class="flex items-center gap-1.5 font-mono text-cyan-300">
                                    {#if session.bandwidth_mbps}
                                        {formatBandwidth(session.bandwidth_mbps)}
                                    {:else}
                                        <span class="text-surface-300">—</span>
                                    {/if}
                                    {#if (bandwidthHistory.get(session.__id)?.length ?? 0) > 1}
                                        <svg
                                            class="h-4 w-10 shrink-0 text-cyan-500/70"
                                            viewBox="0 0 40 16"
                                            preserveAspectRatio="none"
                                            aria-hidden="true">
                                            <polyline
                                                fill="none"
                                                stroke="currentColor"
                                                stroke-width="1.5"
                                                points={sparklinePoints(
                                                    bandwidthHistory.get(session.__id) ?? [],
                                                )} />
                                        </svg>
                                    {/if}
                                </span>
                                <span
                                    class="font-mono {hasBufferHealth(session)
                                        ? bufferTextColor(session.buffer_health_sec)
                                        : 'text-surface-300'}"
                                    title={hasBufferHealth(session)
                                        ? bufferTooltip(session)
                                        : undefined}>
                                    {#if session.isBuffering}
                                        <span class="italic text-amber-400"
                                            >{m.admin_redesign_sessions_buffering()}</span>
                                    {:else if hasBufferHealth(session)}
                                        <span class="lg:hidden"
                                            >{m.admin_sessions_buffer_label()}</span>
                                        {bufferLabel(session.buffer_health_sec)}
                                    {:else}
                                        —
                                    {/if}
                                </span>
                                <span class="flex min-w-[6rem] flex-col">
                                    <span
                                        class="flex items-center gap-1 font-mono {session.playIsPlaying ===
                                        false
                                            ? 'text-surface-300'
                                            : 'text-surface-200'}">
                                        {#if session.playIsPlaying === false}
                                            <Icon src={PauseCircle} class="h-3.5 w-3.5" />
                                        {/if}
                                        {formatPosition(
                                            Math.round((session.playCurrentTime ?? 0) * 1000),
                                        )}
                                        {#if session.playItemDuration}
                                            <span class="text-surface-300"
                                                >/ {formatPosition(
                                                    Math.round(session.playItemDuration * 1000),
                                                )}</span>
                                        {/if}
                                    </span>
                                    {#if watchPct != null}
                                        <span
                                            class="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-surface-800"
                                            role="progressbar"
                                            aria-label="Watch progress"
                                            aria-valuenow={Math.round(watchPct)}
                                            aria-valuemin={0}
                                            aria-valuemax={100}>
                                            <span
                                                class="block h-full rounded-full bg-cyan-500/70"
                                                style="width: {watchPct}%"></span>
                                        </span>
                                    {/if}
                                </span>
                            </span>
                        </button>
                        <div
                            class="flex items-center gap-1.5 px-3 pb-2.5 pl-[4.25rem] sm:p-0 sm:pr-3">
                            <button
                                onclick={(e) => {
                                    e.stopPropagation();
                                    if (isJellyfinMirror || !canMessage) return;
                                    openMessageModal(session);
                                }}
                                disabled={isJellyfinMirror || !canMessage}
                                class="inline-flex items-center justify-center gap-1 h-8 px-2 sm:w-8 sm:px-0 rounded transition-colors shrink-0
                                    {!isJellyfinMirror && canMessage
                                    ? 'text-blue-300 border border-blue-800/50 bg-blue-950/20 hover:bg-blue-900/40 hover:text-blue-200'
                                    : 'text-surface-300 border border-surface-700/50 bg-surface-800/30 cursor-not-allowed'}"
                                title={isJellyfinMirror
                                    ? m.admin_sessions_jellyfin_no_control_hint()
                                    : canMessage
                                      ? 'Send message to this session'
                                      : NO_MESSAGE_SUPPORT_HINT}
                                aria-label={isJellyfinMirror
                                    ? m.admin_sessions_jellyfin_no_control_hint()
                                    : canMessage
                                      ? 'Send message to this session'
                                      : NO_MESSAGE_SUPPORT_HINT}>
                                <Icon src={ChatBubbleOvalLeft} class="w-4 h-4 shrink-0" />
                                <span class="sm:hidden text-[11px] font-medium">
                                    {m.admin_sessions_message_short_label()}
                                </span>
                            </button>
                            <button
                                onclick={(e) => {
                                    e.stopPropagation();
                                    if (isJellyfinMirror) return;
                                    onKillSession(session.__id, session.username, session.title);
                                }}
                                disabled={isJellyfinMirror || killingSessionId === session.__id}
                                class="inline-flex items-center justify-center gap-1 h-8 px-2 sm:w-8 sm:px-0 rounded transition-colors shrink-0
                                    {isJellyfinMirror
                                    ? 'text-surface-300 border border-surface-700/50 bg-surface-800/30 cursor-not-allowed'
                                    : 'text-red-300 border border-red-800/50 bg-red-950/20 hover:bg-red-900/40 hover:text-red-200 disabled:opacity-50 disabled:cursor-not-allowed'}"
                                title={isJellyfinMirror
                                    ? m.admin_sessions_jellyfin_no_control_hint()
                                    : terminateHint(session.source)}
                                aria-label={isJellyfinMirror
                                    ? m.admin_sessions_jellyfin_no_control_hint()
                                    : killingSessionId === session.__id
                                      ? m.admin_sessions_terminating_label()
                                      : m.admin_sessions_terminate_label()}>
                                <Icon src={XCircle} class="w-4 h-4 shrink-0" />
                                <span class="sm:hidden text-[11px] font-medium">
                                    {m.admin_sessions_terminate_short_label()}
                                </span>
                            </button>
                        </div>
                    </div>
                    {#if isExpanded}
                        <div class="space-y-1 border-t border-surface-700/50 px-4 py-3">
                            <!-- Row 1: identity. Wraps instead of overflowing on narrow
                                 widths; the viewer name is shrink-0 with a reserved max
                                 width so it's never squeezed to nothing by the fixed-width
                                 badges/ids that follow. -->
                            <div
                                class="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 text-[11px] text-surface-300">
                                <Avatar
                                    size="2xs"
                                    username={session.username}
                                    src={getAvatarUrl(session.username)}
                                    initials={session.username.slice(0, 1).toUpperCase()}
                                    alt=""
                                    border="border border-surface-800" />
                                <span
                                    class="text-surface-200 font-medium truncate shrink-0 max-w-[8rem] sm:max-w-[14rem]">
                                    {displayName(session.username)}
                                </span>
                                {#if session.ip_address && !isUnknownIp(session.ip_address)}
                                    <span class="text-surface-300 shrink-0">·</span>
                                    <span class="font-mono text-surface-300 shrink-0">
                                        {session.ip_address}
                                    </span>
                                {:else if isUnknownIp(session.ip_address)}
                                    <span class="text-surface-300 shrink-0">·</span>
                                    <span
                                        class="italic text-surface-300 shrink-0"
                                        title={m.admin_sessions_ip_unknown_hint()}>
                                        {m.admin_sessions_ip_unknown()}
                                    </span>
                                {/if}
                                <span class="text-surface-300 shrink-0">·</span>
                                <span class="inline-flex items-center gap-1 min-w-0">
                                    <Icon
                                        src={deviceIcon(formFactor)}
                                        class="w-3.5 h-3.5 text-surface-300 shrink-0" />
                                    <Tooltip
                                        text={session.user_agent_raw ??
                                            deviceLabel(session) ??
                                            'Unknown'}
                                        position="bottom"
                                        fixed
                                        triggerClass="min-w-0">
                                        <span class="truncate max-w-[320px]">
                                            {deviceLabel(session) || 'Unknown'}
                                        </span>
                                    </Tooltip>
                                </span>
                                {#if session.isCarPlay}
                                    <span
                                        class="inline-flex items-center px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-[10px] font-medium shrink-0"
                                        >CarPlay</span>
                                {/if}
                                {#if ffChip}
                                    <span
                                        class="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 {ffChip.classes}">
                                        {ffChip.label}
                                    </span>
                                {/if}
                                <Tooltip
                                    text={srcBadge.label === 'Jellyfin'
                                        ? 'Session polled from an external Jellyfin server'
                                        : srcBadge.label === '/j Compat'
                                          ? 'Jellyfin-protocol client connected to Lumastra via /j compat API'
                                          : srcBadge.label === 'Subsonic'
                                            ? 'Subsonic client now-playing session'
                                            : 'Native Lumastra session'}
                                    position="bottom"
                                    fixed>
                                    <span
                                        class="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 {srcBadge.classes}">
                                        {srcBadge.label}
                                    </span>
                                </Tooltip>
                                <span class="flex-1"></span>
                                {#if session.lastHeartbeatAt}
                                    {#if session.source !== 'lumastra' && session.lastSeenAt}
                                        <Tooltip
                                            text="Heartbeat (last reported {session.lastHeartbeatAt}) / Last seen by external source ({session.lastSeenAt})"
                                            position="bottom"
                                            fixed>
                                            <span
                                                class="inline-flex items-center gap-1 shrink-0 text-surface-300">
                                                <Icon
                                                    src={Clock}
                                                    class="w-3 h-3 text-surface-300" />
                                                {m.admin_sessions_last_update_label()}
                                                {formatRelativeTime(session.lastHeartbeatAt)} /
                                                {m.admin_sessions_last_polled_label()}
                                                {formatRelativeTime(session.lastSeenAt)}
                                            </span>
                                        </Tooltip>
                                    {:else}
                                        <Tooltip
                                            text="Heartbeat (last reported {session.lastHeartbeatAt})"
                                            position="bottom"
                                            fixed>
                                            <span
                                                class="inline-flex items-center gap-1 shrink-0 text-surface-300">
                                                <Icon
                                                    src={Clock}
                                                    class="w-3 h-3 text-surface-300" />
                                                {m.admin_sessions_last_update_label()}
                                                {formatRelativeTime(session.lastHeartbeatAt)}
                                            </span>
                                        </Tooltip>
                                    {/if}
                                {:else if session.source !== 'lumastra' && session.lastSeenAt}
                                    <Tooltip
                                        text="Last seen by external source ({session.lastSeenAt})"
                                        position="bottom"
                                        fixed>
                                        <span
                                            class="inline-flex items-center gap-1 shrink-0 text-surface-300">
                                            <Icon src={Clock} class="w-3 h-3 text-surface-300" />
                                            {m.admin_sessions_last_polled_label()}
                                            {formatRelativeTime(session.lastSeenAt)}
                                        </span>
                                    </Tooltip>
                                {:else if session.started_at}
                                    <Tooltip
                                        text="Session started at {session.started_at}"
                                        position="bottom"
                                        fixed>
                                        <span class="inline-flex items-center gap-1 shrink-0">
                                            <Icon src={Clock} class="w-3 h-3 text-surface-300" />
                                            started {formatElapsedSince(session.started_at)} ago
                                        </span>
                                    </Tooltip>
                                {/if}
                            </div>
                            <!-- Row 2: title -->
                            <div
                                class="flex items-center gap-2 min-w-0 text-base font-semibold text-white mt-0.5">
                                <Icon
                                    src={isAudio(session.media_type) || isMusic(session.media_type)
                                        ? MusicalNote
                                        : Film}
                                    class="w-4 h-4 text-surface-300 shrink-0" />
                                {#if isEpisode(session.media_type) && session.series_title && session.series_id}
                                    <Tooltip
                                        text="Open series detail page in admin"
                                        position="bottom"
                                        fixed
                                        triggerClass="min-w-0 max-w-full">
                                        <a
                                            href={resolve(
                                                `/admin/library/media/${session.series_id}`,
                                            )}
                                            class="truncate hover:underline underline-offset-2">
                                            {session.series_title}
                                        </a>
                                    </Tooltip>
                                    <Tooltip
                                        text="Open series detail page in admin"
                                        position="bottom"
                                        fixed>
                                        <a
                                            href={resolve(
                                                `/admin/library/media/${session.series_id}`,
                                            )}
                                            class="text-surface-300 hover:text-surface-300 transition-colors shrink-0">
                                            <Icon src={ArrowTopRightOnSquare} class="w-3.5 h-3.5" />
                                        </a>
                                    </Tooltip>
                                {:else if session.media_id}
                                    {#if isAudio(session.media_type) || isMusic(session.media_type) || session.media_type === 'track' || session.media_type === 'radio'}
                                        <!-- No modal for tracks/radio — just show title + admin link -->
                                        <Tooltip
                                            text={session.title}
                                            position="bottom"
                                            fixed
                                            triggerClass="min-w-0 max-w-full">
                                            <span class="truncate">{session.title}</span>
                                        </Tooltip>
                                    {:else}
                                        <Tooltip
                                            text="Open the media detail modal — same view that users see on the home page"
                                            position="bottom"
                                            fixed
                                            triggerClass="min-w-0 max-w-full">
                                            <button
                                                onclick={() => handleOpenModal(session)}
                                                class="truncate hover:underline underline-offset-2 text-left min-w-0">
                                                {session.title}
                                            </button>
                                        </Tooltip>
                                    {/if}
                                    <Tooltip
                                        text="Open this media's detail page in admin"
                                        position="bottom"
                                        fixed>
                                        <a
                                            href={resolve(
                                                `/admin/library/media/${session.media_id}`,
                                            )}
                                            class="text-surface-300 hover:text-surface-300 transition-colors shrink-0">
                                            <Icon src={ArrowTopRightOnSquare} class="w-3.5 h-3.5" />
                                        </a>
                                    </Tooltip>
                                {:else}
                                    <span class="truncate" title={session.title}
                                        >{session.title}</span>
                                {/if}
                            </div>

                            <!-- Row 3: episode locator + episode title -->
                            {#if isEpisode(session.media_type) && (session.season_number != null || session.episode_number != null)}
                                <div class="flex items-center gap-2 min-w-0 text-sm mt-0.5">
                                    {#if epLocator}
                                        <span
                                            class="font-mono text-[11px] text-violet-300 bg-violet-950/40 border border-violet-800/40 rounded px-1.5 py-0.5 shrink-0">
                                            {epLocator}
                                        </span>
                                    {/if}
                                    {#if session.series_title}
                                        {#if session.media_id}
                                            <Tooltip
                                                text="Open the episode detail modal — same view that users see on the home page"
                                                position="bottom"
                                                fixed
                                                triggerClass="min-w-0 max-w-full">
                                                <button
                                                    onclick={() => handleOpenModal(session)}
                                                    class="text-surface-300 truncate hover:text-white hover:underline underline-offset-2 transition-colors text-left min-w-0">
                                                    {session.title}
                                                </button>
                                            </Tooltip>
                                            <Tooltip
                                                text="Open this episode's detail page in admin"
                                                position="bottom"
                                                fixed>
                                                <a
                                                    href={resolve(
                                                        `/admin/library/media/${session.media_id}`,
                                                    )}
                                                    class="text-surface-300 hover:text-surface-300 transition-colors shrink-0">
                                                    <Icon
                                                        src={ArrowTopRightOnSquare}
                                                        class="w-3.5 h-3.5" />
                                                </a>
                                            </Tooltip>
                                        {:else}
                                            <span class="text-surface-300 truncate">
                                                {session.title}
                                            </span>
                                        {/if}
                                    {/if}
                                </div>
                            {/if}

                            <!-- Row 3b: music track metadata (artist · album) -->
                            {#if (isAudio(session.media_type) || isMusic(session.media_type)) && (session.artistName || session.albumName)}
                                <div
                                    class="flex items-center gap-1 min-w-0 text-sm text-surface-300 mt-0.5 truncate">
                                    {#if session.artistName}
                                        <span class="truncate">{session.artistName}</span>
                                    {/if}
                                    {#if session.artistName && session.albumName}
                                        <span class="text-surface-300 shrink-0">·</span>
                                    {/if}
                                    {#if session.albumName}
                                        <span class="truncate italic">{session.albumName}</span>
                                    {/if}
                                </div>
                            {/if}

                            <!-- Row 3b-fade: crossfade in progress (music only) -->
                            {#if (isAudio(session.media_type) || isMusic(session.media_type)) && session.crossfade}
                                <CrossfadeStreamIndicator
                                    crossfade={session.crossfade}
                                    class="mt-0.5" />
                            {/if}

                            <!-- Row 3b-next: next track in queue (music only) -->
                            {#if (isAudio(session.media_type) || isMusic(session.media_type)) && session.nextTrack}
                                <div
                                    class="flex items-center gap-1 min-w-0 text-xs text-surface-300 mt-0.5 truncate">
                                    <span class="shrink-0">{m.stream_next()}</span>
                                    <span class="truncate">
                                        {session.nextTrack.title}{session.nextTrack.artistName
                                            ? ` — ${session.nextTrack.artistName}`
                                            : ''}
                                    </span>
                                </div>
                            {/if}

                            <!-- Row 3c: radio metadata (program · DJ · now-playing) -->
                            {#if session.media_type === 'radio'}
                                {#if session.radioProgram || session.radioDj}
                                    <div
                                        class="flex items-center gap-1 min-w-0 text-sm text-surface-300 mt-0.5 truncate">
                                        {#if session.radioProgram}
                                            <span class="truncate">{session.radioProgram}</span>
                                        {/if}
                                        {#if session.radioProgram && session.radioDj}
                                            <span class="text-surface-300 shrink-0">·</span>
                                        {/if}
                                        {#if session.radioDj}
                                            <span class="truncate">DJ {session.radioDj}</span>
                                        {/if}
                                    </div>
                                {/if}
                                {#if session.nowPlayingTrack || session.nowPlayingArtist}
                                    <div
                                        class="flex items-center gap-1 min-w-0 text-xs text-pink-400/80 mt-0.5 truncate">
                                        <Icon src={MusicalNote} class="w-3 h-3 shrink-0" />
                                        {#if session.nowPlayingArtist && session.nowPlayingTrack}
                                            <span class="truncate"
                                                >{session.nowPlayingArtist} –
                                                {session.nowPlayingTrack}</span>
                                        {:else}
                                            <span class="truncate"
                                                >{session.nowPlayingTrack ??
                                                    session.nowPlayingArtist}</span>
                                        {/if}
                                    </div>
                                {/if}
                            {/if}
                            <!-- Row 4: state atoms (status · health · method · ffmpeg ·|· bw · buffer) -->
                            <div
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mt-2">
                                <!-- Explicit status badge -->
                                {#if session.status}
                                    <span
                                        class="inline-flex items-center px-1.5 py-0.5 rounded border font-medium {statusUi.classes}">
                                        {statusUi.label}
                                    </span>
                                    {#if session.status === 'PAUSED' && session.pausedAt}
                                        <span class="text-amber-400/80"
                                            >paused {formatRelativeTime(session.pausedAt)}</span>
                                    {/if}
                                {:else if state.health.kind === 'playing' && session.playIsPlaying == null}
                                    <span class="text-surface-300"
                                        >{m.admin_redesign_sessions_status_unknown()}</span>
                                {:else}
                                    <!-- Health atom fallback when status is absent -->
                                    <span
                                        class="inline-flex items-center gap-1.5 {healthUi.classes}">
                                        <span
                                            class="inline-block w-2 h-2 rounded-full {healthUi.dotColor}">
                                        </span>
                                        {healthUi.label}
                                    </span>
                                {/if}
                                {#if needsAttention(session) && (session.status || session.isBuffering)}
                                    <span class="inline-flex items-center gap-1 text-amber-300">
                                        <Icon src={ExclamationTriangle} class="w-3.5 h-3.5" />
                                        {session.status === 'CRASHED'
                                            ? statusUi.label
                                            : session.isBuffering
                                              ? m.admin_redesign_sessions_buffering()
                                              : healthUi.label}
                                    </span>
                                {/if}
                                <!-- Method pill -->
                                <span
                                    class="inline-flex items-center px-1.5 py-0.5 rounded border font-medium {methodUi.classes}">
                                    {methodUi.label}
                                </span>
                                <!-- Cache-state badge (music audio_transcode only) -->
                                {#if cacheStateBadge}
                                    <span
                                        class="inline-flex items-center px-1.5 py-0.5 rounded border font-medium text-[10px] {musicCacheStateBadgeClasses(
                                            cacheStateBadge,
                                        )}"
                                        title="Music transcode cache state">
                                        {cacheStateBadge}
                                    </span>
                                {/if}
                                <!-- Resource atom -->
                                {#if hasJobs}
                                    <span class="inline-flex items-center gap-1 text-violet-400">
                                        <Icon
                                            src={Cog}
                                            class="w-3 h-3 {state.resource.runningJobs > 0
                                                ? 'animate-spin'
                                                : ''}" />
                                        {state.resource.jobCount} FFmpeg
                                    </span>
                                {/if}
                                <!-- Spacer -->
                                <span class="flex-1"></span>
                                {#if session.bandwidth_mbps}
                                    <span class="font-mono text-cyan-400">
                                        {formatBandwidth(session.bandwidth_mbps)}
                                    </span>
                                {/if}
                                {#if hasBufferHealth(session)}
                                    <Tooltip text={bufferTooltip(session)} position="bottom" fixed>
                                        <div class="flex items-center gap-1.5 cursor-default">
                                            <span class="text-[10px] text-surface-300">
                                                {m.admin_sessions_buffer_label()}
                                            </span>
                                            <div
                                                class="w-10 h-1 bg-surface-700 rounded-full overflow-hidden">
                                                <div
                                                    class="h-full rounded-full transition-all {bufferBarColor(
                                                        session.buffer_health_sec,
                                                    )}"
                                                    style="width: {bufferBarWidth(
                                                        session.buffer_health_sec,
                                                    )}%">
                                                </div>
                                            </div>
                                            <span class="text-[10px] text-surface-300">
                                                {bufferLabel(session.buffer_health_sec)}
                                            </span>
                                        </div>
                                    </Tooltip>
                                {/if}
                            </div>
                            <!-- Adaptive bitrate: variant now, ladder, switches, encoder -->
                            {#if session.adaptive}
                                {@const abrEncoder = adaptiveEncoderForSession(session)}
                                <div class="mt-2" data-testid="session-adaptive">
                                    <AdaptiveStreamBadge
                                        adaptive={session.adaptive}
                                        detailed
                                        encoder={abrEncoder}
                                        encoderHealthLabel={abrEncoder
                                            ? encoderHealthLabel(abrEncoder.health)
                                            : undefined} />
                                </div>
                            {/if}
                            <!-- Row 5: tech specs (source codec · audio · subs merged) -->
                            {#if session.resolution || session.video_codec || session.audio_codec || session.bitrate_kbps || session.container || audioLang || session.audio_tracks?.length || subLang || hasSubsAvailable}
                                <div
                                    class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-surface-300 mt-2">
                                    {#if session.resolution || session.video_codec || session.audio_codec || session.bitrate_kbps || session.container}
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="text-surface-300">source</span>
                                            <span title={session.container ?? undefined}>
                                                {[
                                                    session.resolution,
                                                    session.video_codec,
                                                    session.audio_codec,
                                                    formatSessionBitrate(session.bitrate_kbps),
                                                    session.container
                                                        ? containerFriendlyName(session.container)
                                                        : undefined,
                                                ]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </span>
                                        </span>
                                    {/if}
                                    {#if audioLang || session.audio_tracks?.length}
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="text-surface-300"
                                                >{m.player_tt_audio()}</span>
                                            <Tooltip
                                                lines={buildAudioTooltip(session)}
                                                position="bottom"
                                                fixed>
                                                <span
                                                    class="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 cursor-default font-mono inline-flex items-center gap-1">
                                                    <span>{audioLang ?? 'UND'}</span>
                                                    {#if audioCount}
                                                        <span class="text-blue-400/70 text-[10px]"
                                                            >{audioCount}</span>
                                                    {/if}
                                                </span>
                                            </Tooltip>
                                        </span>
                                    {/if}
                                    {#if subLang}
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="text-surface-300">subs</span>
                                            <Tooltip
                                                lines={buildSubtitleTooltip(session)}
                                                position="bottom"
                                                fixed>
                                                <span
                                                    class="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 cursor-default font-mono">
                                                    CC {subLang}
                                                </span>
                                            </Tooltip>
                                        </span>
                                    {:else if subsOn}
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="text-surface-300">subs</span>
                                            <Tooltip
                                                lines={buildSubtitleTooltip(session)}
                                                position="bottom"
                                                fixed>
                                                <span
                                                    class="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 cursor-default font-mono">
                                                    CC —
                                                </span>
                                            </Tooltip>
                                        </span>
                                    {:else if hasSubsAvailable}
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="text-surface-300">subs</span>
                                            <Tooltip
                                                lines={buildSubtitleTooltip(session)}
                                                position="bottom"
                                                fixed>
                                                <span
                                                    class="px-1.5 py-0.5 rounded bg-surface-800/60 text-surface-300 cursor-default font-mono">
                                                    CC off
                                                </span>
                                            </Tooltip>
                                        </span>
                                    {/if}
                                </div>
                            {/if}

                            <!-- Row 7: ids (copyable) -->
                            <div
                                class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-surface-300 mt-2 pt-2 border-t border-surface-800/60">
                                <span class="text-surface-300">ids</span>
                                {#if session.file_id}
                                    <button
                                        type="button"
                                        onclick={() => copyId(session.file_id ?? '', 'File')}
                                        class="group inline-flex items-center gap-1 hover:text-surface-200 transition-colors"
                                        title="Copy File ID">
                                        <span class="text-surface-300">File</span>
                                        <span>{session.file_id}</span>
                                        <Icon
                                            src={ClipboardDocument}
                                            class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                {/if}
                                <button
                                    type="button"
                                    onclick={() => copyId(session.__id, 'Session')}
                                    class="group inline-flex items-center gap-1 hover:text-surface-200 transition-colors"
                                    title="Copy Session ID">
                                    <span class="text-surface-300">Session</span>
                                    <span>{session.__id}</span>
                                    <Icon
                                        src={ClipboardDocument}
                                        class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                </button>
                                {#if session.source !== 'lumastra' && session.sourceSessionId}
                                    <button
                                        type="button"
                                        onclick={() =>
                                            copyId(session.sourceSessionId ?? '', 'Source session')}
                                        class="group inline-flex items-center gap-1 hover:text-surface-200 transition-colors"
                                        title="Copy source session ID: {session.sourceSessionId}">
                                        <span class="text-surface-300">Source</span>
                                        <span>{truncateId(session.sourceSessionId)}</span>
                                        <Icon
                                            src={ClipboardDocument}
                                            class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                {/if}
                                {#if session.deviceId}
                                    <button
                                        type="button"
                                        onclick={() => copyId(session.deviceId ?? '', 'Device')}
                                        class="group inline-flex items-center gap-1 hover:text-surface-200 transition-colors"
                                        title="Copy device ID: {session.deviceId}">
                                        <span class="text-surface-300">Device</span>
                                        <span>{truncateId(session.deviceId)}</span>
                                        <Icon
                                            src={ClipboardDocument}
                                            class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                    </button>
                                {/if}
                                {#if session.planId}
                                    <Tooltip
                                        text="Inspect playback plan (transcode pipeline, reasons, GPU encoder)"
                                        position="bottom"
                                        fixed>
                                        <button
                                            type="button"
                                            onclick={() => (viewingPlanId = session.planId ?? null)}
                                            class="group inline-flex items-center gap-1 hover:text-violet-300 transition-colors">
                                            <span class="text-surface-300">Plan</span>
                                            <span
                                                class="underline decoration-dotted decoration-surface-600 underline-offset-2"
                                                >{truncateId(session.planId)}</span>
                                            <Icon
                                                src={Cog}
                                                class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                        </button>
                                    </Tooltip>
                                {/if}
                                {#if session.externalPayload}
                                    <button
                                        type="button"
                                        onclick={() =>
                                            (expandedPayloadId = isPayloadExpanded
                                                ? null
                                                : session.__id)}
                                        class="group inline-flex items-center gap-1 hover:text-surface-200 transition-colors"
                                        title="{isPayloadExpanded
                                            ? 'Hide'
                                            : 'Show'} external payload">
                                        <span class="text-surface-300">ext</span>
                                        <Icon
                                            src={ChevronDown}
                                            class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity {isPayloadExpanded
                                                ? 'rotate-180'
                                                : ''}" />
                                    </button>
                                {/if}
                            </div>

                            <!-- Row 8: external payload (collapsed by default) -->
                            {#if session.externalPayload && isPayloadExpanded}
                                <div
                                    class="mt-2 rounded bg-surface-900/60 border border-surface-700/50 p-2 overflow-x-auto">
                                    <pre
                                        class="text-[10px] text-surface-300 font-mono whitespace-pre-wrap break-all">{JSON.stringify(
                                            session.externalPayload,
                                            null,
                                            2,
                                        )}</pre>
                                </div>
                            {/if}
                        </div>
                    {/if}

                    <!-- ── FFmpeg Children ─────────────────────────────── -->
                    {#if hasJobs && isExpanded}
                        <div class="border-t border-surface-700/50 bg-surface-900/30">
                            <div class="px-4 py-2">
                                <div
                                    class="text-[11px] text-surface-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <Icon src={Cog} class="w-3 h-3 text-violet-400" />
                                    FFmpeg Jobs ({sessionJobs.length})
                                </div>
                                <div class="space-y-1.5">
                                    {#each sessionJobs.sort((a, b) => jobSeverity(a) - jobSeverity(b)) as job (job.jobId)}
                                        {@const isError = !!(job.error || job.status === 'error')}
                                        {@const isStale = job.lastProgressSecondsAgo > 30}
                                        {@const isJobExpanded = expandedJobId === job.jobId}
                                        {@const isCompleted =
                                            effectiveJobProgress(job) >= 100 &&
                                            !job.processRunning &&
                                            !isError}

                                        <div
                                            class="bg-surface-800/60 rounded-lg border overflow-hidden
                                                {isError
                                                ? 'border-red-700/50'
                                                : isStale
                                                  ? 'border-amber-700/30'
                                                  : isCompleted
                                                    ? 'border-surface-800/60'
                                                    : 'border-surface-700/50'}">
                                            {#if isCompleted && !isJobExpanded}
                                                <!-- Compact completed row -->
                                                <div
                                                    class="px-3 py-1.5 flex items-center gap-3 hover:bg-surface-700/20 transition-colors cursor-pointer text-[11px] text-surface-300"
                                                    onclick={(e) => {
                                                        e.stopPropagation();
                                                        expandedJobId = job.jobId;
                                                    }}
                                                    onkeydown={(e) =>
                                                        e.key === 'Enter' &&
                                                        (expandedJobId = job.jobId)}
                                                    role="button"
                                                    aria-expanded="false"
                                                    tabindex="0">
                                                    <Icon
                                                        src={CheckCircle}
                                                        class="w-3.5 h-3.5 text-emerald-500/80 shrink-0" />
                                                    <span class="text-surface-300 shrink-0"
                                                        >{job.transcodeType &&
                                                        job.transcodeType !== 'unknown'
                                                            ? transcodeTypeLabel(job.transcodeType)
                                                            : job.mode}</span>
                                                    <span class="shrink-0"
                                                        >took {formatElapsed(
                                                            job.elapsedSeconds,
                                                        )}</span>
                                                    {#if job.resolution}
                                                        <span class="text-surface-300 shrink-0"
                                                            >·</span>
                                                        <span class="text-surface-300 shrink-0"
                                                            >{job.resolution}</span>
                                                    {/if}
                                                    <span class="flex-1"></span>
                                                    <Icon
                                                        src={ChevronDown}
                                                        class="w-3 h-3 text-surface-300 shrink-0" />
                                                </div>
                                            {:else}
                                                <!-- Job summary row -->
                                                <div
                                                    class="px-3 py-2 flex items-center gap-3 hover:bg-surface-700/20 transition-colors cursor-pointer"
                                                    onclick={(e) => {
                                                        e.stopPropagation();
                                                        expandedJobId = isJobExpanded
                                                            ? null
                                                            : job.jobId;
                                                    }}
                                                    onkeydown={(e) =>
                                                        e.key === 'Enter' &&
                                                        (expandedJobId = isJobExpanded
                                                            ? null
                                                            : job.jobId)}
                                                    role="button"
                                                    aria-expanded={isJobExpanded}
                                                    tabindex="0">
                                                    <!-- Status badge -->
                                                    <span
                                                        class="px-1.5 py-0.5 text-[10px] rounded-full font-medium shrink-0
                                                        {getStatusColor(
                                                            getDisplayStatus(
                                                                job.status,
                                                                job.progressPercent,
                                                            ),
                                                        )}
                                                        {getStatusBg(
                                                            getDisplayStatus(
                                                                job.status,
                                                                job.progressPercent,
                                                            ),
                                                        )}">
                                                        {getDisplayStatus(
                                                            job.status,
                                                            job.progressPercent,
                                                        )}
                                                    </span>

                                                    <!-- Mode / transcode type — a single pill. If
                                                     `transcodeType` is set and more specific than
                                                     `mode`, prefer it; otherwise show `mode`. Avoids
                                                     the double-badge (e.g. "Remux Remux") when they
                                                     refer to the same underlying decision. -->
                                                    {#if job.transcodeType && job.transcodeType !== 'unknown'}
                                                        <span
                                                            class="px-1.5 py-0.5 text-[10px] rounded shrink-0 {job.transcodeType ===
                                                            'remux'
                                                                ? 'bg-green-900/50 text-green-400'
                                                                : job.transcodeType ===
                                                                        'audio-only' ||
                                                                    job.transcodeType ===
                                                                        'audio-drop' ||
                                                                    job.transcodeType ===
                                                                        'audiobook-remux'
                                                                  ? 'bg-yellow-900/50 text-yellow-400'
                                                                  : job.transcodeType ===
                                                                      'tonemapping'
                                                                    ? 'bg-amber-900/50 text-amber-400'
                                                                    : 'bg-red-900/50 text-red-400'}">
                                                            {transcodeTypeLabel(
                                                                job.transcodeType,
                                                            )}{#if job.transcodeDecision?.gpuEncoder}&nbsp;({job
                                                                    .transcodeDecision
                                                                    .gpuEncoder}){/if}
                                                        </span>
                                                    {:else}
                                                        <span
                                                            class="px-1.5 py-0.5 text-[10px] rounded bg-violet-900/50 text-violet-400 shrink-0">
                                                            {job.mode}
                                                        </span>
                                                    {/if}

                                                    <!-- Video info -->
                                                    {#if job.resolution || job.videoCodec}
                                                        <div
                                                            class="flex items-center gap-1.5 text-[11px] text-surface-300 shrink-0">
                                                            {#if job.resolution}
                                                                <span>{job.resolution}</span>
                                                            {/if}
                                                            {#if job.videoCodec}
                                                                <span class="text-surface-300">
                                                                    {job.videoCodec}{job.videoOutputCodec &&
                                                                    job.videoOutputCodec !==
                                                                        job.videoCodec
                                                                        ? ` → ${job.videoOutputCodec}`
                                                                        : ''}
                                                                </span>
                                                            {/if}
                                                            {#if job.videoRange && job.videoRange !== 'SDR'}
                                                                {@const badgeColor = hdrBadgeColor(
                                                                    job.videoRange,
                                                                )}
                                                                <span
                                                                    class="px-1 py-0.5 rounded text-[9px] {badgeColor ===
                                                                    'purple'
                                                                        ? 'bg-purple-900/50 text-purple-400'
                                                                        : badgeColor === 'teal'
                                                                          ? 'bg-teal-900/50 text-teal-400'
                                                                          : 'bg-amber-900/50 text-amber-400'}"
                                                                    >{formatHdrLabel(
                                                                        job.videoRange,
                                                                    ) ?? job.videoRange}</span>
                                                            {/if}
                                                        </div>
                                                    {/if}

                                                    <!-- Audio/subtitle track counts -->
                                                    {#if job.audioTrackCount > 0 || job.subtitleTrackCount > 0}
                                                        <div
                                                            class="flex items-center gap-1 text-[11px] text-surface-300 shrink-0">
                                                            {#if job.audioTrackCount > 0}
                                                                <Icon
                                                                    src={MusicalNote}
                                                                    class="w-3 h-3" />
                                                                <span>{job.audioTrackCount}</span>
                                                            {/if}
                                                            {#if job.subtitleTrackCount > 0}
                                                                {#if job.audioTrackCount > 0}
                                                                    <span class="text-surface-300"
                                                                        >·</span>
                                                                {/if}
                                                                <span
                                                                    >{job.subtitleTrackCount}
                                                                    sub</span>
                                                            {/if}
                                                        </div>
                                                    {/if}

                                                    <!-- Spacer -->
                                                    <div class="flex-1"></div>

                                                    <!-- Resources -->
                                                    <div
                                                        class="flex items-center gap-2 text-[11px] shrink-0">
                                                        {#if job.cpuPercent !== undefined}
                                                            <span
                                                                class={job.cpuPercent > 80
                                                                    ? 'text-red-400'
                                                                    : job.cpuPercent > 50
                                                                      ? 'text-yellow-400'
                                                                      : 'text-green-400'}>
                                                                CPU {job.cpuPercent.toFixed(0)}%
                                                            </span>
                                                        {/if}
                                                        {#if job.gpuVideoPercent !== undefined}
                                                            <span
                                                                class={job.gpuVideoPercent > 80
                                                                    ? 'text-red-400'
                                                                    : job.gpuVideoPercent > 50
                                                                      ? 'text-yellow-400'
                                                                      : 'text-cyan-400'}>
                                                                GPU {job.gpuVideoPercent.toFixed(
                                                                    0,
                                                                )}%
                                                            </span>
                                                        {/if}
                                                        {#if job.memoryMB !== undefined}
                                                            <span class="text-blue-400">
                                                                {job.memoryMB.toFixed(0)}MB
                                                            </span>
                                                        {/if}
                                                    </div>

                                                    <!-- Error inline -->
                                                    {#if isError && job.error}
                                                        <span
                                                            class="text-[11px] text-red-400 truncate max-w-[150px]"
                                                            title={job.error}>
                                                            {job.error}
                                                        </span>
                                                    {/if}

                                                    <!-- Progress bar -->
                                                    <div class="flex items-center gap-1.5 shrink-0">
                                                        <div
                                                            class="w-16 h-1.5 bg-surface-700 rounded-full overflow-hidden">
                                                            <div
                                                                class="h-full rounded-full transition-all duration-300
                                                                {isError
                                                                    ? 'bg-red-500'
                                                                    : 'bg-gradient-to-r from-violet-500 to-pink-500'}"
                                                                style="width: {effectiveJobProgress(
                                                                    job,
                                                                )}%">
                                                            </div>
                                                        </div>
                                                        <span
                                                            class="text-[11px] text-surface-300 w-8 text-right">
                                                            {effectiveJobProgress(job)}%
                                                        </span>
                                                    </div>

                                                    <!-- Elapsed -->
                                                    <span
                                                        class="text-[11px] text-surface-300 min-w-[72px] text-right shrink-0">
                                                        {job.processRunning ? 'running' : 'took'}
                                                        {formatElapsed(job.elapsedSeconds)}
                                                    </span>

                                                    <!-- Stop button -->
                                                    <button
                                                        class="p-1 rounded text-surface-300 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                                                        onclick={(e) => {
                                                            e.stopPropagation();
                                                            onStopJob(job.playSessionId);
                                                        }}
                                                        disabled={stoppingJobId ===
                                                            job.playSessionId}
                                                        title="Stop this FFmpeg job">
                                                        {#if stoppingJobId === job.playSessionId}
                                                            <Icon
                                                                src={ArrowPath}
                                                                class="w-3.5 h-3.5 animate-spin" />
                                                        {:else}
                                                            <Icon src={Stop} class="w-3.5 h-3.5" />
                                                        {/if}
                                                    </button>
                                                </div>

                                                <!-- Expanded job details -->
                                                {#if isJobExpanded}
                                                    <div
                                                        class="px-3 pb-2.5 border-t border-surface-700/50 pt-2.5">
                                                        <div
                                                            class="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                                                            <div>
                                                                <p class="text-surface-300 mb-0.5">
                                                                    Segments
                                                                </p>
                                                                <p class="text-white">
                                                                    {job.segmentsReady}
                                                                    / {job.totalSegments || '?'}
                                                                    {#if job.segmentOffset > 0}
                                                                        <span
                                                                            class="text-surface-300"
                                                                            >(offset:
                                                                            {job.segmentOffset})</span>
                                                                    {/if}
                                                                </p>
                                                            </div>
                                                            <div>
                                                                <p class="text-surface-300 mb-0.5">
                                                                    Last Progress
                                                                </p>
                                                                <p class="text-white">
                                                                    {#if effectiveJobProgress(job) >= 100}
                                                                        <span class="text-green-400"
                                                                            >{m.admin_task_completed()}</span>
                                                                    {:else}
                                                                        {job.lastProgressSecondsAgo}s
                                                                        ago
                                                                        {#if job.lastProgressSecondsAgo > 30}
                                                                            <span
                                                                                class="text-yellow-400"
                                                                                >(stale?)</span>
                                                                        {/if}
                                                                    {/if}
                                                                </p>
                                                            </div>
                                                            <div>
                                                                <p class="text-surface-300 mb-0.5">
                                                                    Process
                                                                </p>
                                                                <p class="text-white">
                                                                    {#if job.processRunning}
                                                                        <span class="text-green-400"
                                                                            >{m.admin_task_running()}</span>
                                                                        {#if job.processPid}
                                                                            <span
                                                                                class="text-surface-300"
                                                                                >(PID:
                                                                                {job.processPid})</span>
                                                                        {/if}
                                                                    {:else}
                                                                        <span
                                                                            class="text-surface-300"
                                                                            >Not running</span>
                                                                    {/if}
                                                                </p>
                                                            </div>
                                                            {#if job.seekCount > 0}
                                                                <div>
                                                                    <p
                                                                        class="text-surface-300 mb-0.5">
                                                                        Seek Count
                                                                    </p>
                                                                    <p class="text-white">
                                                                        {job.seekCount}
                                                                        seeks
                                                                    </p>
                                                                </div>
                                                            {/if}
                                                            {#if job.sourceBitrateMbps || job.targetBitrateMbps}
                                                                <div>
                                                                    <p
                                                                        class="text-surface-300 mb-0.5">
                                                                        Bitrate
                                                                    </p>
                                                                    <p class="text-white">
                                                                        {#if job.sourceBitrateMbps}{job.sourceBitrateMbps}
                                                                            Mbps{/if}
                                                                        {#if job.targetBitrateMbps && job.targetBitrateMbps !== job.sourceBitrateMbps}
                                                                            → {job.targetBitrateMbps}
                                                                            Mbps
                                                                        {/if}
                                                                    </p>
                                                                </div>
                                                            {/if}
                                                            {#if job.transcodeDecision?.videoAction === 'transcode' || job.transcodeDecision?.useGpu}
                                                                <a
                                                                    class="text-primary-300 underline"
                                                                    href={resolve(
                                                                        '/admin/settings/playback?category=ffmpeg-hardware',
                                                                    )}
                                                                    >{m.admin_hardware_configure()}</a>
                                                            {/if}
                                                            {#if job.transcodeDecision?.videoAction}
                                                                <div>
                                                                    <p
                                                                        class="text-surface-300 mb-0.5">
                                                                        {m.player_tt_video()}
                                                                    </p>
                                                                    <p class="text-white">
                                                                        {job.transcodeDecision
                                                                            .videoAction}
                                                                        {#if job.transcodeDecision.useGpu && job.transcodeDecision.gpuEncoder}
                                                                            <span
                                                                                class="text-green-400"
                                                                                >({job
                                                                                    .transcodeDecision
                                                                                    .gpuEncoder})</span>
                                                                        {/if}
                                                                    </p>
                                                                </div>
                                                            {/if}
                                                            {#if job.transcodeDecision?.audioAction}
                                                                <div>
                                                                    <p
                                                                        class="text-surface-300 mb-0.5">
                                                                        {m.player_tt_audio()}
                                                                    </p>
                                                                    <p class="text-white">
                                                                        {job.transcodeDecision
                                                                            .audioAction}
                                                                    </p>
                                                                </div>
                                                            {/if}
                                                            {#if job.transcodeDecision?.needsTonemapping}
                                                                <div>
                                                                    <p
                                                                        class="text-surface-300 mb-0.5">
                                                                        HDR
                                                                    </p>
                                                                    <p class="text-amber-400">
                                                                        Tonemapping{#if job.transcodeDecision.tonemappingAlgorithm}:
                                                                            {job.transcodeDecision
                                                                                .tonemappingAlgorithm}{/if}
                                                                    </p>
                                                                </div>
                                                            {/if}
                                                        </div>

                                                        {#if job.audioTracks.length > 0}
                                                            <div
                                                                class="mt-2.5 pt-2 border-t border-surface-700/40">
                                                                <p
                                                                    class="text-[10px] text-surface-300 mb-1.5">
                                                                    Audio Tracks
                                                                </p>
                                                                <div class="flex flex-wrap gap-1.5">
                                                                    {#each job.audioTracks as track, trackIndex (trackIndex)}
                                                                        <span
                                                                            class="px-1.5 py-0.5 bg-surface-700/50 rounded text-[10px] text-surface-300">
                                                                            {track.language ||
                                                                                'und'}
                                                                            {#if track.channels}
                                                                                <span
                                                                                    class="text-surface-300"
                                                                                    >({track.channels}ch)</span>
                                                                            {/if}
                                                                            {#if track.codec}
                                                                                <span
                                                                                    class="text-surface-300"
                                                                                    >{track.codec}</span>
                                                                            {/if}
                                                                        </span>
                                                                    {/each}
                                                                </div>
                                                            </div>
                                                        {/if}

                                                        {#if job.error}
                                                            <div
                                                                class="mt-2.5 pt-2 border-t border-surface-700/40">
                                                                <p class="text-red-400 text-[11px]">
                                                                    <strong>Error:</strong>
                                                                    {job.error}
                                                                </p>
                                                            </div>
                                                        {/if}

                                                        <div
                                                            class="mt-2 pt-2 border-t border-surface-700/40 text-[9px] text-surface-300 font-mono flex flex-wrap items-center gap-x-3 gap-y-1">
                                                            <button
                                                                type="button"
                                                                onclick={(e) => {
                                                                    e.stopPropagation();
                                                                    void copyId(job.jobId, 'Job');
                                                                }}
                                                                class="group inline-flex items-center gap-1 hover:text-surface-300 transition-colors"
                                                                title="Copy Job ID">
                                                                Job: {job.jobId}
                                                                <Icon
                                                                    src={ClipboardDocument}
                                                                    class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onclick={(e) => {
                                                                    e.stopPropagation();
                                                                    void copyId(job.itemId, 'Item');
                                                                }}
                                                                class="group inline-flex items-center gap-1 hover:text-surface-300 transition-colors"
                                                                title="Copy Item ID">
                                                                Item: {job.itemId}
                                                                <Icon
                                                                    src={ClipboardDocument}
                                                                    class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                                                            </button>
                                                            {#if job.podName}
                                                                <span>Pod: {job.podName}</span>
                                                            {/if}
                                                        </div>
                                                    </div>
                                                {/if}
                                            {/if}
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>

<!-- ── LiveTV Streams ──────────────────────────────────────────── -->
{#if isStandalone}
    {@const liveTvIsEmpty = !liveTvError && (!proxyStatus || proxyStatus.channels.length === 0)}
    {#if liveTvIsEmpty}
        <!-- Compact footer when no channels active -->
        <div class="mt-4 flex items-center gap-2 text-[11px] text-surface-300">
            <Icon src={Tv} class="w-3 h-3 opacity-50" />
            No active LiveTV streams
        </div>
    {:else}
        <div class="mt-4">
            <h3
                class="text-sm font-medium text-surface-300 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Icon src={Tv} class="w-4 h-4 text-purple-400" />
                LiveTV Streams
                {#if proxyStatus && !liveTvError}
                    {@const totalActive = proxyStatus.perSourceLimits.reduce(
                        (sum, s) => sum + s.activeStreams,
                        0,
                    )}
                    {@const totalMax = proxyStatus.perSourceLimits.reduce(
                        (sum, s) => sum + s.maxStreams,
                        0,
                    )}
                    <span
                        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border normal-case {capacityColor(
                            totalActive,
                            totalMax,
                        )}">
                        <Icon src={Signal} class="w-3 h-3" />
                        {totalActive} / {totalMax} upstream
                    </span>
                    {#if proxyStatus.egressCapacity}
                        {@const cap = proxyStatus.egressCapacity}
                        <span
                            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border normal-case {cap.limit ===
                            0
                                ? 'bg-red-900/40 text-red-300 border-red-700/40'
                                : capacityColor(cap.used, cap.limit)}"
                            title={m.admin_sessions_encoder_budget_title()}>
                            <Icon src={Bolt} class="w-3 h-3" />
                            {m.admin_sessions_encoder_budget({
                                used: String(cap.used),
                                limit: String(cap.limit),
                            })}
                        </span>
                    {/if}
                {/if}
            </h3>

            {#if liveTvError}
                <div
                    class="bg-surface-800/30 rounded-lg px-4 py-3 text-surface-300 text-sm flex items-center gap-2">
                    <Icon src={ExclamationTriangle} class="w-4 h-4 text-amber-500 opacity-70" />
                    LiveTV: unable to connect to proxy
                </div>
            {:else if proxyStatus}
                {#if proxyStatus.perSourceLimits.length > 1}
                    <div class="flex flex-wrap gap-2 mb-3">
                        {#each proxyStatus.perSourceLimits as source (source.sourceId)}
                            <span
                                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border {capacityColor(
                                    source.activeStreams,
                                    source.maxStreams,
                                )}"
                                title={source.sourceId}>
                                {source.sourceId.slice(0, 8)}…
                                {source.activeStreams} / {source.maxStreams}
                            </span>
                        {/each}
                    </div>
                {/if}

                <div class="bg-surface-800/50 border border-surface-700 rounded-xl overflow-hidden">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="border-b border-surface-700 text-surface-300 text-left">
                                <th class="px-4 py-2.5 font-medium">{m.media_channel()}</th>
                                <th class="px-4 py-2.5 font-medium"
                                    >{m.trending_viewer_plural()}</th>
                                <th class="px-4 py-2.5 font-medium">Multiplexing</th>
                                <th class="px-4 py-2.5 font-medium">FFmpeg</th>
                                <th class="px-4 py-2.5 font-medium">Uptime</th>
                                <th class="px-4 py-2.5 font-medium sr-only">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each proxyStatus.channels as channel (channel.channelId)}
                                <tr
                                    class="border-b border-surface-700/50 last:border-0 hover:bg-surface-700/20 transition-colors">
                                    <td class="px-4 py-2.5">
                                        <div class="flex items-center gap-2">
                                            <span
                                                class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-900/80">
                                                {#if !posterErrors.has(channel.channelId)}
                                                    <img
                                                        src={getCatalogPosterUrl(
                                                            channel.channelId,
                                                            {
                                                                size: 'thumb',
                                                                fallback: 'none',
                                                            },
                                                        )}
                                                        alt=""
                                                        loading="lazy"
                                                        decoding="async"
                                                        class="h-full w-full object-contain p-0.5"
                                                        onerror={() => {
                                                            posterErrors = new Set([
                                                                ...posterErrors,
                                                                channel.channelId,
                                                            ]);
                                                        }} />
                                                {:else}
                                                    <Icon
                                                        src={Tv}
                                                        class="h-4 w-4 text-purple-400" />
                                                {/if}
                                            </span>
                                            <span
                                                class="text-white font-medium truncate max-w-[200px]"
                                                title={channel.channelName}>
                                                {channel.channelName}
                                            </span>
                                        </div>
                                    </td>
                                    <td class="px-4 py-2.5 text-surface-300">
                                        {channel.viewers}
                                    </td>
                                    <td class="px-4 py-2.5">
                                        {#if channel.viewers > 1}
                                            <span
                                                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-900/40 text-blue-300 border border-blue-700/40">
                                                {m.playlist_shared()}
                                            </span>
                                        {:else if channel.viewers === 1}
                                            <span
                                                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-700/40 text-surface-300 border border-surface-600/40">
                                                {m.player_method_direct()}
                                            </span>
                                        {:else}
                                            <span class="text-surface-300">—</span>
                                        {/if}
                                    </td>
                                    <td class="px-4 py-2.5">
                                        {#if channel.ffmpegHealth === 'degraded'}
                                            <span
                                                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-900/40 text-amber-300 border-amber-700/40">
                                                {m.admin_sessions_encoder_health_degraded()}
                                            </span>
                                        {:else if channel.ffmpegHealth === 'error'}
                                            <span
                                                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-red-900/40 text-red-300 border-red-700/40">
                                                {m.error()}
                                            </span>
                                        {:else if channel.ffmpegHealthy}
                                            <span
                                                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-900/40 text-emerald-300 border-emerald-700/40">
                                                {m.admin_sessions_encoder_health_healthy()}
                                            </span>
                                        {:else}
                                            <span class="text-surface-400">
                                                {m.admin_livetv_unavailable()}
                                            </span>
                                        {/if}
                                    </td>
                                    <td class="px-4 py-2.5 text-surface-300 text-xs">
                                        {formatElapsedSince(channel.startedAt)}
                                    </td>
                                    <td class="px-4 py-2.5 text-right">
                                        <button
                                            onclick={() =>
                                                onKillChannel(
                                                    channel.channelId,
                                                    channel.channelName,
                                                )}
                                            disabled={killingChannelId === channel.channelId}
                                            class="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium bg-red-900/40 text-red-300 border border-red-700/40 hover:bg-red-800/50 hover:text-red-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                            title="Kill channel">
                                            <Icon src={StopCircle} class="w-3.5 h-3.5" />
                                            {killingChannelId === channel.channelId
                                                ? 'Killing…'
                                                : 'Kill'}
                                        </button>
                                    </td>
                                </tr>
                                <tr class="border-b border-surface-700/50">
                                    <td colspan="6" class="px-4 pb-3 pt-1">
                                        <LiveTvDiagnostics {channel} />
                                    </td>
                                </tr>
                                {#if (channel.encoders?.length ?? 0) > 1}
                                    <!-- Only when the ladder is actually in use: every
                                         channel has an ingest process, so listing one
                                         alone would be noise on every row. -->
                                    <tr class="border-b border-surface-700/50 last:border-0">
                                        <td colspan="6" class="px-4 pb-2.5 pt-0">
                                            <div
                                                class="flex flex-wrap items-center gap-1.5 text-[11px]">
                                                <span class="text-surface-300 mr-0.5"
                                                    >{m.admin_sessions_encoders_label()}</span>
                                                <!-- Keyed by INDEX on purpose. The
                                                     alternative — kind + rungId +
                                                     outputs — is derived from proxy
                                                     data, and any duplicate in it
                                                     throws each_key_duplicate and
                                                     kills the whole admin page. This
                                                     list is a short, poll-replaced
                                                     snapshot with no identity to
                                                     preserve across renders, so an
                                                     index key costs nothing and cannot
                                                     collide. -->
                                                {#each channel.encoders ?? [] as enc, encIndex (encIndex)}
                                                    <span
                                                        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border {encoderChipClass(
                                                            enc,
                                                        )}"
                                                        title="{enc.stopping
                                                            ? m.admin_sessions_encoder_stopping()
                                                            : encoderHealthLabel(
                                                                  enc.health,
                                                              )} · {m.admin_sessions_encoder_viewers(
                                                            { count: String(enc.viewers) },
                                                        )}{enc.reservedOutputs > 0
                                                            ? ' · ' +
                                                              m.admin_sessions_encoder_slots({
                                                                  count: String(
                                                                      enc.reservedOutputs,
                                                                  ),
                                                              })
                                                            : ''}">
                                                        <Icon src={Bolt} class="w-3 h-3" />
                                                        {enc.kind === 'ingest'
                                                            ? m.admin_sessions_encoder_ingest()
                                                            : enc.kind === 'adaptive'
                                                              ? m.admin_sessions_encoder_adaptive()
                                                              : (enc.rungId ??
                                                                enc.outputs[0] ??
                                                                enc.kind)}
                                                        {#if enc.kind === 'adaptive'}
                                                            <span class="opacity-70"
                                                                >({enc.outputs.join(', ')})</span>
                                                        {/if}
                                                        <span class="opacity-70"
                                                            >· {enc.viewers}</span>
                                                    </span>
                                                {/each}
                                                {#if adaptiveViewersByVariant(channel.channelId)}
                                                    <span
                                                        class="ml-1 text-surface-300"
                                                        data-testid="channel-abr-viewers"
                                                        >{m.sessions_abr_viewers_by_variant()}
                                                        <span class="text-teal-300"
                                                            >{adaptiveViewersByVariant(
                                                                channel.channelId,
                                                            )}</span
                                                        ></span>
                                                {/if}
                                            </div>
                                        </td>
                                    </tr>
                                {/if}
                            {/each}
                        </tbody>
                    </table>
                </div>

                {#if proxyStatus.orphanedEncoders && proxyStatus.orphanedEncoders.length > 0}
                    <!-- Encoders whose channel is no longer registered. They hold
                         encoder slots, so without this they would be an unexplained
                         gap between egressCapacity.used and the chips above. -->
                    <div
                        class="mt-3 rounded-lg border border-amber-700/40 bg-amber-900/10 px-4 py-2.5">
                        <div class="flex items-center gap-2 text-[11px] text-amber-300">
                            <Icon src={ExclamationTriangle} class="w-3.5 h-3.5" />
                            <span class="font-medium">{m.admin_sessions_encoders_orphaned()}</span>
                            <span class="text-surface-300"
                                >{m.admin_sessions_encoders_orphaned_hint()}</span>
                        </div>
                        <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                            {#each proxyStatus.orphanedEncoders as enc, orphanIndex (orphanIndex)}
                                <span
                                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border {encoderChipClass(
                                        enc,
                                    )}"
                                    title="{enc.channelId ?? ''} · {encoderHealthLabel(
                                        enc.health,
                                    )}">
                                    <Icon src={Bolt} class="w-3 h-3" />
                                    {enc.kind === 'adaptive'
                                        ? m.admin_sessions_encoder_adaptive()
                                        : (enc.rungId ?? enc.outputs[0] ?? enc.kind)}
                                </span>
                            {/each}
                        </div>
                    </div>
                {/if}
            {/if}
        </div>
    {/if}
{/if}

<!-- ── Per-session message modal ──────────────────────────────────── -->
<SendSessionMessageModal
    open={messageModalOpen}
    sessionLabel={messageModalLabel}
    maxChars={280}
    showDuration={false}
    onClose={() => (messageModalOpen = false)}
    onSend={handleSendSessionMessage} />

<!-- ── Playback plan inspector modal ──────────────────────────────── -->
<PlaybackPlanModal planId={viewingPlanId} onclose={() => (viewingPlanId = null)} />
