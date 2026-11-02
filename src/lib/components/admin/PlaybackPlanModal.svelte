<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    PlaybackPlanModal.svelte

    Inspector for a play_session.plan_id. Renders the PlaybackPlan that
    the planner stored in Valkey at session-start time as a three-lane
    pipeline (video / audio / subtitle): source codec → action → target
    codec, with reason chips on the action arrow and GPU encoder/decoder
    badges where present.

    The modal is read-only and renders exactly what's in Valkey — no
    re-derivation. When the plan has expired (TTL elapsed) we surface
    that explicitly with the planId still copy-able for offline lookup.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Z } from '$lib/utils/z-index';
    import {
        Icon,
        XMark,
        ArrowRightCircle,
        Cog,
        ExclamationTriangle,
        Clock,
        ClipboardDocument,
    } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { getAdminPlaybackPlan } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import type { PlaybackPlan } from '$lib/schemas/playback-plan';
    import { toPlayMethod, getPlayMethodLabel } from '$lib/utils/playback-method';

    interface Props {
        /** When non-null the modal is open and fetches that plan. */
        planId: string | null;
        onclose: () => void;
    }

    let { planId, onclose }: Props = $props();

    type LoadState =
        | { kind: 'idle' }
        | { kind: 'loading' }
        | { kind: 'expired' }
        | { kind: 'error'; message: string }
        | { kind: 'loaded'; plan: PlaybackPlan };

    let state = $state<LoadState>({ kind: 'idle' });

    /**
     * Fetch the plan whenever planId becomes non-null. We re-fetch on
     * every open (no caching) because a plan's status can change
     * mid-flight (TTL refresh on segment requests, or expiration).
     */
    $effect(() => {
        if (!planId) {
            state = { kind: 'idle' };
            return;
        }
        const id = planId;
        state = { kind: 'loading' };
        void (async () => {
            const { data, error } = await getAdminPlaybackPlan(id);
            // Bail if the modal has been closed / planId changed while we
            // were fetching, so a stale response doesn't overwrite a fresh
            // request's state.
            if (planId !== id) return;
            if (error || !data) {
                state = {
                    kind: 'error',
                    message: error || 'Failed to load plan',
                };
                return;
            }
            if (data.expired || !data.plan) {
                state = { kind: 'expired' };
                return;
            }
            state = { kind: 'loaded', plan: data.plan };
        })();
    });

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') onclose();
    }

    async function copyPlanId(id: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(id);
            toasts.success('Plan ID copied');
        } catch {
            toasts.error('Copy failed');
        }
    }

    // ─── Visual helpers ──────────────────────────────────────────────

    /**
     * Action label + colour for the arrow between source and target.
     * Audio gets a warmer palette than video so a row that's
     * full_transcode-on-video + audio-copy reads as two distinct things
     * rather than one big red block.
     */
    function videoActionStyle(action: 'copy' | 'transcode'): {
        label: string;
        classes: string;
    } {
        return action === 'copy'
            ? {
                  label: 'copy',
                  classes: 'border-emerald-700/40 bg-emerald-900/30 text-emerald-300',
              }
            : {
                  label: 'transcode',
                  classes: 'border-red-700/40 bg-red-900/30 text-red-300',
              };
    }

    function audioActionStyle(action: 'copy' | 'transcode'): {
        label: string;
        classes: string;
    } {
        return action === 'copy'
            ? {
                  label: 'copy',
                  classes: 'border-emerald-700/40 bg-emerald-900/30 text-emerald-300',
              }
            : {
                  label: 'transcode',
                  classes: 'border-amber-700/40 bg-amber-900/30 text-amber-300',
              };
    }

    function subtitleActionStyle(method: 'external_vtt' | 'burn_in' | 'client_render' | 'none'): {
        label: string;
        classes: string;
    } {
        switch (method) {
            case 'external_vtt':
                return {
                    label: 'external VTT',
                    classes: 'border-teal-700/40 bg-teal-900/30 text-teal-300',
                };
            case 'burn_in':
                return {
                    label: 'burn-in',
                    classes: 'border-red-700/40 bg-red-900/30 text-red-300',
                };
            case 'client_render':
                return {
                    label: 'client render',
                    classes: 'border-violet-700/40 bg-violet-900/30 text-violet-300',
                };
            case 'none':
                return {
                    label: 'none',
                    classes: 'border-surface-700 bg-surface-800/40 text-surface-400',
                };
        }
    }

    /** Classes use heavier `/30` backgrounds — modal pills sit on a
     *  larger surface with more breathing room than session-row pills. */
    function methodPill(method: string): {
        label: string;
        classes: string;
    } {
        const canonical = toPlayMethod(method);
        if (!canonical) {
            return {
                label: method.trim() || '—',
                classes: 'text-surface-300 border-surface-700 bg-surface-800/40',
            };
        }
        const label = getPlayMethodLabel(canonical);
        switch (canonical) {
            case 'direct':
                return {
                    label,
                    classes: 'text-emerald-300 border-emerald-700/40 bg-emerald-900/30',
                };
            case 'remux':
                return {
                    label,
                    classes: 'text-blue-300 border-blue-700/40 bg-blue-900/30',
                };
            case 'audio_transcode':
                return {
                    label,
                    classes: 'text-amber-300 border-amber-700/40 bg-amber-900/30',
                };
            case 'full_transcode':
                return {
                    label,
                    classes: 'text-red-300 border-red-700/40 bg-red-900/30',
                };
            // Shares audio_transcode's amber — both drop the video track's
            // pass-through, matching getPlayMethodPillTextClass()'s pairing.
            case 'audio_only':
                return {
                    label,
                    classes: 'text-amber-300 border-amber-700/40 bg-amber-900/30',
                };
        }
    }

    /**
     * Filter reason codes to those that apply to a particular lane so
     * each transcode arrow only shows the reasons that drove its own
     * action. Audio cap reasons cluster on the audio arrow; codec/HDR
     * reasons cluster on video; preview_mode is global and shown on
     * whichever lane is transcoding.
     */
    const VIDEO_REASON_CODES = new Set<string>([
        'video_codec_incompatible',
        'video_10bit_h264',
        'hdr_tonemap_dolby_vision',
        'video_level_exceeded',
        'video_profile_excluded',
        'video_profile_exceeded',
        'resolution_exceeded',
        'resolution_exceeded_user_cap',
        'bitrate_exceeded',
        'bitrate_exceeded_user_cap',
    ]);
    const AUDIO_REASON_CODES = new Set<string>([
        'audio_codec_incompatible',
        'audio_channels_exceeded',
    ]);
    const GLOBAL_REASON_CODES = new Set<string>([
        'container_incompatible',
        'multi_audio_needs_hls',
        'preview_mode',
    ]);

    function reasonsFor(plan: PlaybackPlan, lane: 'video' | 'audio' | 'global'): string[] {
        // Prefer structured codes when present (i18n-ready); fall back
        // to the legacy human-readable strings when the planner pre-dates
        // the structured array.
        const structured = plan.transcode_reason_codes;
        if (structured && structured.length > 0) {
            return structured
                .filter((r) => {
                    if (lane === 'video') return VIDEO_REASON_CODES.has(r.code);
                    if (lane === 'audio') return AUDIO_REASON_CODES.has(r.code);
                    return GLOBAL_REASON_CODES.has(r.code);
                })
                .map((r) => formatReasonCode(r.code, r.params));
        }
        // Legacy fallback: we can't distinguish lanes from a flat string
        // array, so pin all reasons to the 'global' band when called for
        // global, and emit nothing for lane-specific calls (avoids
        // duplicating every reason on every lane).
        if (lane !== 'global') return [];
        return plan.transcode_reasons ?? [];
    }

    function formatReasonCode(
        code: string,
        params: Record<string, string | number> | undefined,
    ): string {
        const codecArg = params?.codec ? ` (${String(params.codec)})` : '';
        const channelsArg = params?.channels !== undefined ? ` (${String(params.channels)}ch)` : '';
        const limitArg = params?.limit !== undefined ? ` > ${String(params.limit)}` : '';
        switch (code) {
            case 'video_codec_incompatible':
                return `Video codec incompatible${codecArg}`;
            case 'video_10bit_h264':
                return '10-bit H.264 not supported';
            case 'audio_codec_incompatible':
                return `Audio codec incompatible${codecArg}`;
            case 'container_incompatible':
                return 'Container incompatible';
            case 'hdr_tonemap_dolby_vision':
                return 'Dolby Vision tonemap';
            case 'multi_audio_needs_hls':
                return 'Multi-audio needs HLS';
            case 'video_level_exceeded':
                return `Video level exceeded${limitArg}`;
            case 'video_profile_excluded':
                return 'Video profile excluded';
            case 'video_profile_exceeded':
                return 'Video profile exceeded';
            case 'resolution_exceeded':
                return `Resolution exceeded${limitArg}`;
            case 'resolution_exceeded_user_cap':
                return `Resolution exceeded user cap${limitArg}`;
            case 'bitrate_exceeded':
                return `Bitrate exceeded${limitArg}`;
            case 'bitrate_exceeded_user_cap':
                return `Bitrate exceeded user cap${limitArg}`;
            case 'audio_channels_exceeded':
                return `Audio channels exceeded${channelsArg}`;
            case 'preview_mode':
                return 'Preview mode';
            default:
                return code;
        }
    }
</script>

{#if planId !== null}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="modal-overlay modal-overlay-50"
        style="z-index: {Z.MODAL}"
        role="dialog"
        aria-modal="true"
        aria-label="Playback plan inspector"
        tabindex="-1"
        onclick={() => onclose()}
        onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="card-bordered p-6 max-w-3xl w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain"
            role="document"
            use:trapFocus
            onclick={stopPropagation()}>
            <!-- Header -->
            <div class="flex items-start justify-between gap-3 mb-4">
                <div class="flex-1 min-w-0">
                    <h3 class="text-xl font-semibold text-white inline-flex items-center gap-2">
                        <Icon src={Cog} class="w-5 h-5 text-violet-400 shrink-0" />
                        Playback Plan
                    </h3>
                    <button
                        type="button"
                        onclick={() => copyPlanId(planId ?? '')}
                        class="group inline-flex items-center gap-1 text-[11px] font-mono text-surface-500 hover:text-surface-300 transition-colors mt-1.5"
                        title="Copy Plan ID">
                        <span class="text-surface-600">id</span>
                        <span>{planId}</span>
                        <Icon
                            src={ClipboardDocument}
                            class="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
                    </button>
                </div>
                <button
                    type="button"
                    class="p-2 -m-2 hover:bg-surface-700 rounded-lg transition-colors shrink-0"
                    onclick={onclose}
                    aria-label="Close">
                    <Icon src={XMark} class="w-5 h-5 text-surface-400" />
                </button>
            </div>

            {#if state.kind === 'loading'}
                <div
                    class="bg-surface-800/30 rounded-lg px-4 py-8 text-center text-surface-400 text-sm">
                    Loading plan…
                </div>
            {:else if state.kind === 'expired'}
                <div
                    class="bg-amber-900/20 border border-amber-700/40 rounded-lg px-4 py-4 text-amber-200 text-sm flex items-start gap-3">
                    <Icon src={Clock} class="w-5 h-5 shrink-0 mt-0.5 text-amber-400" />
                    <div class="space-y-1">
                        <div class="font-medium">Plan expired</div>
                        <p class="text-amber-200/80 text-xs leading-relaxed">
                            Playback plans are only kept for a short time — once a session ends or
                            that window passes, the saved decision is cleared. The session still
                            shows this id for reference, but the detailed plan can no longer be
                            inspected.
                        </p>
                    </div>
                </div>
            {:else if state.kind === 'error'}
                <div
                    class="bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-4 text-red-200 text-sm flex items-start gap-3">
                    <Icon src={ExclamationTriangle} class="w-5 h-5 shrink-0 mt-0.5 text-red-400" />
                    <div class="space-y-1">
                        <div class="font-medium">Failed to load plan</div>
                        <p class="text-red-200/80 text-xs">{state.message}</p>
                    </div>
                </div>
            {:else if state.kind === 'loaded'}
                {@const plan = state.plan}
                {@const methodUi = methodPill(plan.method)}
                {@const videoUi = videoActionStyle(plan.video_action)}
                {@const audioUi = audioActionStyle(plan.audio_action)}
                {@const subUi = subtitleActionStyle(plan.subtitle_method)}
                {@const videoReasons = reasonsFor(plan, 'video')}
                {@const audioReasons = reasonsFor(plan, 'audio')}
                {@const globalReasons = reasonsFor(plan, 'global')}

                <!-- Plan summary row -->
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] mb-4">
                    <span
                        class="inline-flex items-center px-2 py-0.5 rounded border font-medium {methodUi.classes}">
                        {methodUi.label}
                    </span>
                    <span class="text-surface-600">·</span>
                    <span class="text-surface-500">
                        delivery
                        <span class="font-mono text-surface-300">{plan.delivery_path}</span>
                    </span>
                    {#if plan.playback_branch}
                        <span class="text-surface-600">·</span>
                        <span class="text-surface-500">
                            branch
                            <span class="font-mono text-surface-300">{plan.playback_branch}</span>
                        </span>
                    {/if}
                    {#if plan.hls_audio_mode}
                        <span class="text-surface-600">·</span>
                        <span class="text-surface-500">
                            {m.player_tt_hls_audio()}
                            <span class="font-mono text-surface-300">{plan.hls_audio_mode}</span>
                        </span>
                    {/if}
                    {#if plan.intent && plan.intent !== 'play'}
                        <span class="text-surface-600">·</span>
                        <span class="text-amber-300 font-mono">
                            intent: {plan.intent}
                        </span>
                    {/if}
                </div>

                <!-- Cross-stream / global reasons -->
                {#if globalReasons.length > 0}
                    <div
                        class="bg-surface-800/40 border border-surface-700/50 rounded-lg px-3 py-2 mb-4">
                        <div class="text-[10px] uppercase tracking-wider text-surface-500 mb-1.5">
                            Plan-wide concerns
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                            {#each globalReasons as reason (reason)}
                                <span
                                    class="px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300 border border-amber-700/40 text-[11px]">
                                    {reason}
                                </span>
                            {/each}
                        </div>
                    </div>
                {/if}

                <!-- Lanes -->
                <div class="space-y-3">
                    <!-- Video lane -->
                    <div
                        class="bg-surface-800/40 border border-surface-700/50 rounded-lg px-3 py-3">
                        <div class="text-[10px] uppercase tracking-wider text-surface-500 mb-2">
                            {m.player_tt_video()}
                        </div>
                        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <!-- source -->
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm font-mono">
                                {#if plan.source_video_codec}
                                    <span class="text-surface-200">{plan.source_video_codec}</span>
                                {:else}
                                    <span class="text-surface-500">—</span>
                                {/if}
                                {#if plan.needs_tonemapping}
                                    <span
                                        class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-700/40 text-[10px] uppercase tracking-wide">
                                        HDR
                                    </span>
                                {/if}
                            </div>

                            <!-- arrow + action + GPU badges -->
                            <div class="flex flex-col items-center gap-1">
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium {videoUi.classes}">
                                    {videoUi.label}
                                </span>
                                <Icon src={ArrowRightCircle} class="w-5 h-5 text-surface-500" />
                                {#if plan.video_action === 'transcode' && (plan.gpu_encoder || plan.gpu_decoder)}
                                    <div class="flex flex-wrap justify-center gap-1 max-w-[10rem]">
                                        {#if plan.gpu_decoder}
                                            <span
                                                class="inline-flex items-center px-1.5 py-0.5 rounded bg-cyan-900/30 text-cyan-300 border border-cyan-700/40 text-[10px] font-mono">
                                                dec: {plan.gpu_decoder}
                                            </span>
                                        {/if}
                                        {#if plan.gpu_encoder}
                                            <span
                                                class="inline-flex items-center px-1.5 py-0.5 rounded bg-cyan-900/30 text-cyan-300 border border-cyan-700/40 text-[10px] font-mono">
                                                enc: {plan.gpu_encoder}
                                            </span>
                                        {/if}
                                    </div>
                                {/if}
                            </div>

                            <!-- target -->
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm font-mono">
                                {#if plan.video_action === 'copy'}
                                    <span class="text-surface-200">
                                        {plan.source_video_codec ?? 'unchanged'}
                                    </span>
                                {:else if plan.target_video_codec}
                                    <span class="text-surface-200">{plan.target_video_codec}</span>
                                {:else}
                                    <span class="text-surface-500">—</span>
                                {/if}
                                {#if plan.output_hdr && plan.output_hdr !== 'sdr'}
                                    <span
                                        class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-700/40 text-[10px] uppercase tracking-wide">
                                        {plan.output_hdr}
                                    </span>
                                {:else if plan.needs_tonemapping && plan.video_action === 'transcode'}
                                    <span
                                        class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-surface-700/60 text-surface-300 border border-surface-600 text-[10px] uppercase tracking-wide">
                                        SDR
                                    </span>
                                {/if}
                            </div>
                        </div>
                        {#if videoReasons.length > 0}
                            <div class="flex flex-wrap gap-1.5 mt-2">
                                {#each videoReasons as reason (reason)}
                                    <span
                                        class="px-1.5 py-0.5 rounded bg-red-900/20 text-red-300 border border-red-700/40 text-[10px]">
                                        {reason}
                                    </span>
                                {/each}
                            </div>
                        {/if}
                    </div>

                    <!-- Audio lane -->
                    <div
                        class="bg-surface-800/40 border border-surface-700/50 rounded-lg px-3 py-3">
                        <div class="text-[10px] uppercase tracking-wider text-surface-500 mb-2">
                            {m.player_tt_audio()}
                        </div>
                        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm font-mono">
                                {#if plan.source_audio_codec}
                                    <span class="text-surface-200">{plan.source_audio_codec}</span>
                                {:else}
                                    <span class="text-surface-500">—</span>
                                {/if}
                            </div>
                            <div class="flex flex-col items-center gap-1">
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium {audioUi.classes}">
                                    {audioUi.label}
                                </span>
                                <Icon src={ArrowRightCircle} class="w-5 h-5 text-surface-500" />
                            </div>
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm font-mono">
                                {#if plan.audio_action === 'copy'}
                                    <span class="text-surface-200">
                                        {plan.source_audio_codec ?? 'unchanged'}
                                    </span>
                                {:else if plan.target_audio_codec}
                                    <span class="text-surface-200">{plan.target_audio_codec}</span>
                                {:else}
                                    <span class="text-surface-500">—</span>
                                {/if}
                            </div>
                        </div>
                        {#if audioReasons.length > 0}
                            <div class="flex flex-wrap gap-1.5 mt-2">
                                {#each audioReasons as reason (reason)}
                                    <span
                                        class="px-1.5 py-0.5 rounded bg-amber-900/20 text-amber-300 border border-amber-700/40 text-[10px]">
                                        {reason}
                                    </span>
                                {/each}
                            </div>
                        {/if}
                    </div>

                    <!-- Subtitle lane -->
                    <div
                        class="bg-surface-800/40 border border-surface-700/50 rounded-lg px-3 py-3">
                        <div class="text-[10px] uppercase tracking-wider text-surface-500 mb-2">
                            {m.player_full_subtitles()}
                        </div>
                        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm text-surface-300 font-mono">
                                {#if plan.subtitle_method === 'none'}
                                    <span class="text-surface-500"
                                        >{m.player_forced_disabled()}</span>
                                {:else}
                                    track delivered
                                {/if}
                            </div>
                            <div class="flex flex-col items-center gap-1">
                                <span
                                    class="inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium {subUi.classes}">
                                    {subUi.label}
                                </span>
                                <Icon src={ArrowRightCircle} class="w-5 h-5 text-surface-500" />
                            </div>
                            <div
                                class="bg-surface-900/60 border border-surface-700/50 rounded px-3 py-2 text-sm text-surface-300 font-mono">
                                {#if plan.subtitle_method === 'external_vtt'}
                                    sidecar VTT
                                {:else if plan.subtitle_method === 'burn_in'}
                                    burnt into video
                                {:else if plan.subtitle_method === 'client_render'}
                                    rendered on client
                                {:else}
                                    <span class="text-surface-500">{m.tech_none()}</span>
                                {/if}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer with timestamps -->
                <div
                    class="text-[10px] font-mono text-surface-600 mt-4 pt-3 border-t border-surface-800/60 flex flex-wrap gap-x-4 gap-y-1">
                    <span>created {plan.created_at}</span>
                    <span>expires {plan.expires_at}</span>
                </div>
            {/if}
        </div>
    </div>
{/if}
