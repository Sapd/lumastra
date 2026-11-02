<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Z } from '$lib/utils/z-index';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import type { BrowserCompatibility, FileCompatibility } from '$lib/schemas/admin-types.js';

    interface Props {
        browser: BrowserCompatibility;
        file: FileCompatibility;
        onClose: () => void;
    }

    let { browser, file, onClose }: Props = $props();

    // ── Helpers ──────────────────────────────────────────────────────────────

    function getFilename(path: string): string {
        return path.split('/').pop() ?? path;
    }

    function getMediaSummary(f: FileCompatibility): string {
        const { video_codec, audio_codecs, container, hdr, bitrate } = f.media_info;
        return [
            video_codec.toUpperCase(),
            audio_codecs[0]?.toUpperCase() ?? null,
            container.toUpperCase(),
            hdr && hdr !== 'none' && hdr !== 'SDR' ? hdr : null,
            bitrate ? `${Math.round(bitrate / 1_000_000)} Mbps` : null,
        ]
            .filter(Boolean)
            .join(' · ');
    }

    function getMethodColor(method: string): string {
        switch (method) {
            case 'direct':
                return 'bg-green-900/60 text-green-300 border border-green-700/50';
            case 'remux':
                return 'bg-blue-900/60 text-blue-300 border border-blue-700/50';
            case 'audio_transcode':
                return 'bg-yellow-900/60 text-yellow-300 border border-yellow-700/50';
            case 'full_transcode':
                return 'bg-red-900/60 text-red-300 border border-red-700/50';
            default:
                return 'bg-surface-700/60 text-surface-300 border border-surface-600/50';
        }
    }

    function getMethodLabel(method: string): string {
        switch (method) {
            case 'direct':
                return m.media_plain_direct();
            case 'remux':
                return m.media_plain_remux();
            case 'audio_transcode':
                return m.media_plain_audio_convert();
            case 'full_transcode':
                return m.media_plain_video_convert();
            default:
                return method;
        }
    }

    function getDeliveryLabel(delivery: string): string {
        switch (delivery) {
            case 'direct_file':
                return m.media_plain_direct_file();
            case 'native_hls':
                return m.media_plain_native_hls();
            case 'mse_hls':
                return m.media_plain_mse_hls();
            default:
                return delivery;
        }
    }

    function yesNoLabel(val: boolean): string {
        return val ? m.media_plain_yes() : m.media_plain_no();
    }

    function yesNoCls(val: boolean): string {
        return val ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300';
    }

    // ── Video codec support table ─────────────────────────────────────────────
    const VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1'];

    function videoCodecRow(codec: string): {
        codec: string;
        directFile: boolean;
        nativeHls: boolean | null;
        mseHls: boolean;
        isFile: boolean;
    } {
        const profile = browser.profile.path_scoped;
        const hasNativeHls = profile.nativeHls.videoCodecs.length > 0;
        return {
            codec,
            directFile: profile.directFile.videoCodecs.includes(codec),
            nativeHls: hasNativeHls ? profile.nativeHls.videoCodecs.includes(codec) : null,
            mseHls: profile.mseHls.videoCodecs.includes(codec),
            isFile: file.media_info.video_codec === codec,
        };
    }

    const videoRows = $derived(VIDEO_CODECS.map(videoCodecRow));

    // ── Audio codec support table ─────────────────────────────────────────────
    const AUDIO_CODECS = ['aac', 'ac3', 'eac3', 'dts', 'opus', 'flac'];

    function audioCodecRow(codec: string): {
        codec: string;
        directPlay: boolean;
        hls: boolean;
        isFile: boolean;
    } {
        const profile = browser.profile.path_scoped;
        const hlsAudio = [...profile.nativeHls.audioCodecs, ...profile.mseHls.audioCodecs];
        return {
            codec,
            directPlay: profile.directFile.audioCodecs.includes(codec),
            hls: hlsAudio.includes(codec),
            isFile: file.media_info.audio_codecs.includes(codec),
        };
    }

    const audioRows = $derived(AUDIO_CODECS.map(audioCodecRow));

    // ── Container support ─────────────────────────────────────────────────────
    const CONTAINERS = ['mp4', 'mkv', 'webm'];

    function containerRow(container: string): {
        container: string;
        supported: boolean;
        isFile: boolean;
    } {
        return {
            container,
            supported: browser.profile.path_scoped.directFile.containers.includes(container),
            isFile: file.media_info.container === container,
        };
    }

    const containerRows = $derived(CONTAINERS.map(containerRow));

    // ── Decision trace ────────────────────────────────────────────────────────
    interface TraceStep {
        number: number;
        title: string;
        result: 'selected' | 'skipped' | 'fallback';
        checks: Array<{ label: string; pass: boolean }>;
    }

    const traceSteps = $derived((): TraceStep[] => {
        const profile = browser.profile.path_scoped;
        const info = file.media_info;
        const compat = browser.compatibility;
        const steps: TraceStep[] = [];

        // Step 1: Direct file
        const videoInDirect = profile.directFile.videoCodecs.includes(info.video_codec);
        const primaryAudio = info.audio_codecs[0] ?? '';
        const audioInDirect = profile.directFile.audioCodecs.includes(primaryAudio);
        const containerOk = profile.directFile.containers.includes(info.container);
        const switchingOk = !browser.profile.audio_switching || info.audio_codecs.length <= 1;
        const directSelected = browser.delivery_path === 'direct_file';

        steps.push({
            number: 1,
            title: m.media_plain_try_direct(),
            result: directSelected ? 'selected' : 'skipped',
            checks: [
                {
                    label: m.media_plain_format_supported({ format: info.video_codec }),
                    pass: videoInDirect,
                },
                {
                    label: m.media_plain_format_supported({
                        format: primaryAudio || m.media_plain_not_available(),
                    }),
                    pass: audioInDirect,
                },
                {
                    label: m.media_plain_format_supported({ format: info.container }),
                    pass: containerOk,
                },
            ],
        });

        if (!directSelected) {
            // Step 2: Native HLS
            const hasNativeHls = profile.nativeHls.videoCodecs.length > 0;
            if (hasNativeHls) {
                const videoInNative = profile.nativeHls.videoCodecs.includes(info.video_codec);
                const anyAudioInNative = info.audio_codecs.some((c) =>
                    profile.nativeHls.audioCodecs.includes(c),
                );
                const nativeSelected = browser.delivery_path === 'native_hls';
                steps.push({
                    number: 2,
                    title: m.media_plain_try_native(),
                    result: nativeSelected ? 'selected' : 'skipped',
                    checks: [
                        {
                            label: m.media_plain_hls_supported({ format: info.video_codec }),
                            pass: videoInNative,
                        },
                        {
                            label: m.media_plain_one_audio(),
                            pass: anyAudioInNative,
                        },
                    ],
                });
            }

            // Step 3: MSE HLS fallback
            const mseSelected = browser.delivery_path === 'mse_hls';
            steps.push({
                number: hasNativeHls ? 3 : 2,
                title: m.media_plain_try_mse(),
                result: 'fallback',
                checks: [{ label: m.media_plain_via_mse(), pass: true }],
            });
        }

        // Final step: Method determination
        steps.push({
            number: steps.length + 1,
            title: m.media_plain_determine(),
            result: 'selected',
            checks: [
                {
                    label:
                        m.media_plain_video() +
                        ': ' +
                        (browser.video_action === 'copy'
                            ? m.media_plain_direct()
                            : `→ ${browser.target_video_codec ?? '?'}`),
                    pass: browser.video_action === 'copy',
                },
                {
                    label:
                        m.media_plain_audio() +
                        ': ' +
                        (browser.audio_action === 'copy'
                            ? m.media_plain_direct()
                            : `→ ${browser.target_audio_codec ?? '?'}`),
                    pass: browser.audio_action === 'copy',
                },
            ],
        });

        return steps;
    });

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') onClose();
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    class="fixed inset-0 flex items-center justify-center bg-black/60"
    style="z-index: {Z.MODAL}"
    role="dialog"
    aria-modal="true"
    aria-label={m.media_plain_compat_details()}
    tabindex="-1"
    onclick={() => onClose()}
    onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="bg-surface-900 rounded-xl border border-surface-700 shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto m-4"
        role="document"
        onclick={stopPropagation()}
        onkeydown={stopPropagation()}>
        <!-- Header -->
        <div class="flex items-start justify-between px-5 py-4 border-b border-surface-700/60">
            <div>
                <h2 class="text-base font-semibold text-white flex items-center gap-2">
                    {#if browser.is_own_browser}<span>🖥</span>{/if}
                    {browser.browser_label}
                </h2>
                <p class="text-xs text-surface-400 mt-0.5">
                    {getFilename(file.file_path)}
                    <span class="text-surface-600 mx-1">·</span>
                    {getMediaSummary(file)}
                </p>
            </div>
            <button
                class="text-surface-400 hover:text-white transition-colors ml-4 text-lg leading-none"
                onclick={() => onClose()}
                aria-label={m.media_plain_close()}>
                ×
            </button>
        </div>

        <div class="px-5 py-4 space-y-5">
            <!-- Decision summary bar -->
            <div
                class="bg-surface-800 rounded-lg p-3 border-l-4 border-yellow-500/70 flex flex-wrap gap-3 items-center text-xs">
                <span
                    class="px-2 py-0.5 rounded text-[11px] font-medium {getMethodColor(
                        browser.method,
                    )}">
                    {getMethodLabel(browser.method)}
                </span>
                <span class="text-surface-400">
                    {m.media_plain_delivery()}:
                    <span class="text-surface-200">{getDeliveryLabel(browser.delivery_path)}</span>
                </span>
                <span class="text-surface-400">
                    {m.media_plain_video()}:
                    <span
                        class={browser.video_action === 'copy'
                            ? 'text-green-400'
                            : 'text-yellow-300'}>
                        {browser.video_action === 'copy'
                            ? m.media_plain_direct()
                            : `→ ${browser.target_video_codec?.toUpperCase() ?? '?'}`}
                    </span>
                </span>
                <span class="text-surface-400">
                    {m.media_plain_audio()}:
                    <span
                        class={browser.audio_action === 'copy'
                            ? 'text-green-400'
                            : 'text-yellow-300'}>
                        {browser.audio_action === 'copy'
                            ? m.media_plain_direct()
                            : `→ ${browser.target_audio_codec?.toUpperCase() ?? '?'}`}
                    </span>
                </span>
            </div>

            <details>
                <summary class="cursor-pointer text-sm text-surface-300"
                    >{m.media_plain_technical_details()}</summary
                >
                <div class="space-y-4 mt-3">
                    <!-- Video Codecs table -->
                    <div>
                        <h3
                            class="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                            {m.media_plain_video_codecs()}
                        </h3>
                        <table class="w-full text-xs">
                            <thead>
                                <tr class="border-b border-surface-700/50">
                                    <th class="text-left py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.player_tt_codec()}</th>
                                    <th class="text-center py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.player_tt_direct_file()}</th>
                                    <th class="text-center py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.player_tt_hls_native()}</th>
                                    <th class="text-center py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.media_plain_mse_hls()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each videoRows as row (row.codec)}
                                    <tr class="border-b border-surface-700/20">
                                        <td class="py-1.5 px-2 text-surface-300 font-mono">
                                            {row.codec.toUpperCase()}
                                            {#if row.isFile}
                                                <span class="text-green-400 text-[10px] ml-1"
                                                    >{m.media_plain_this_file()}</span>
                                            {/if}
                                        </td>
                                        <td class="py-1.5 px-2 text-center">
                                            <span
                                                class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                    row.directFile,
                                                )}">{yesNoLabel(row.directFile)}</span>
                                        </td>
                                        <td class="py-1.5 px-2 text-center">
                                            {#if row.nativeHls === null}
                                                <span class="text-surface-600 text-[10px]"
                                                    >{m.media_plain_not_available()}</span>
                                            {:else}
                                                <span
                                                    class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                        row.nativeHls,
                                                    )}">{yesNoLabel(row.nativeHls)}</span>
                                            {/if}
                                        </td>
                                        <td class="py-1.5 px-2 text-center">
                                            <span
                                                class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                    row.mseHls,
                                                )}">{yesNoLabel(row.mseHls)}</span>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>

                    <!-- Audio Codecs table -->
                    <div>
                        <h3
                            class="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                            {m.media_plain_audio_codecs()}
                        </h3>
                        <table class="w-full text-xs">
                            <thead>
                                <tr class="border-b border-surface-700/50">
                                    <th class="text-left py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.player_tt_codec()}</th>
                                    <th class="text-center py-1.5 px-2 text-surface-500 font-medium"
                                        >{m.stream_direct_play()}</th>
                                    <th class="text-center py-1.5 px-2 text-surface-500 font-medium"
                                        >HLS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each audioRows as row (row.codec)}
                                    <tr class="border-b border-surface-700/20">
                                        <td class="py-1.5 px-2 text-surface-300 font-mono">
                                            {row.codec.toUpperCase()}
                                            {#if row.isFile}
                                                <span class="text-green-400 text-[10px] ml-1"
                                                    >{m.media_plain_this_file()}</span>
                                            {/if}
                                        </td>
                                        <td class="py-1.5 px-2 text-center">
                                            <span
                                                class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                    row.directPlay,
                                                )}">{yesNoLabel(row.directPlay)}</span>
                                        </td>
                                        <td class="py-1.5 px-2 text-center">
                                            <span
                                                class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                    row.hls,
                                                )}">{yesNoLabel(row.hls)}</span>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>

                    <!-- Containers & Features -->
                    <div class="grid grid-cols-2 gap-4">
                        <!-- Containers -->
                        <div>
                            <h3
                                class="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                                {m.media_plain_containers()}
                            </h3>
                            <div class="space-y-1">
                                {#each containerRows as row (row.container)}
                                    <div class="flex items-center justify-between text-xs">
                                        <span class="text-surface-300 font-mono">
                                            {row.container.toUpperCase()}
                                            {#if row.isFile}
                                                <span class="text-green-400 text-[10px] ml-1"
                                                    >{m.media_plain_this_file()}</span>
                                            {/if}
                                        </span>
                                        <span
                                            class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                row.supported,
                                            )}">{yesNoLabel(row.supported)}</span>
                                    </div>
                                {/each}
                            </div>
                        </div>

                        <!-- HDR & Features -->
                        <div>
                            <h3
                                class="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                                {m.media_plain_hdr_features()}
                            </h3>
                            <div class="space-y-1 text-xs">
                                {#each [{ key: 'hdr10', label: 'HDR10' }, { key: 'hlg', label: 'HLG' }, { key: 'dovi', label: 'Dolby Vision' }] as hdrFormat (hdrFormat.key)}
                                    <div class="flex items-center justify-between">
                                        <span class="text-surface-300">{hdrFormat.label}</span>
                                        <span
                                            class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                                browser.profile.hdr_formats.includes(hdrFormat.key),
                                            )}"
                                            >{yesNoLabel(
                                                browser.profile.hdr_formats.includes(hdrFormat.key),
                                            )}</span>
                                    </div>
                                {/each}
                                <div class="flex items-center justify-between">
                                    <span class="text-surface-300"
                                        >{m.media_plain_audio_switching()}</span>
                                    <span
                                        class="px-1.5 py-0.5 rounded text-[10px] {yesNoCls(
                                            browser.profile.audio_switching,
                                        )}">{yesNoLabel(browser.profile.audio_switching)}</span>
                                </div>
                                <div class="flex items-center justify-between">
                                    <span class="text-surface-300"
                                        >{m.media_plain_max_channels()}</span>
                                    <span class="text-surface-200"
                                        >{browser.profile.max_channels}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Decision Trace -->
                    <div>
                        <h3
                            class="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-3">
                            {m.media_plain_trace()}
                        </h3>
                        <div class="space-y-3">
                            {#each traceSteps() as step (step.number)}
                                <div class="flex gap-3">
                                    <!-- Step circle -->
                                    <div
                                        class="flex-none w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5
                                {step.result === 'selected'
                                            ? 'bg-green-800/60 text-green-300 border border-green-600/50'
                                            : step.result === 'fallback'
                                              ? 'bg-blue-800/60 text-blue-300 border border-blue-600/50'
                                              : 'bg-surface-700/60 text-surface-400 border border-surface-600/50'}">
                                        {step.number}
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 mb-1">
                                            <span class="text-xs font-medium text-surface-200"
                                                >{step.title}</span>
                                            {#if step.result === 'selected'}
                                                <span class="text-[10px] text-green-400 font-medium"
                                                    >{m.media_plain_selected()}</span>
                                            {:else if step.result === 'fallback'}
                                                <span class="text-[10px] text-blue-400 font-medium"
                                                    >{m.media_plain_fallback()}</span>
                                            {:else}
                                                <span class="text-[10px] text-surface-500"
                                                    >{m.media_plain_skipped()}</span>
                                            {/if}
                                        </div>
                                        <div class="space-y-0.5">
                                            {#each step.checks as check, i (i)}
                                                <div class="text-[11px] flex items-center gap-1.5">
                                                    <span
                                                        class={check.pass
                                                            ? 'text-green-400'
                                                            : 'text-red-400'}>
                                                        {check.pass ? '✓' : '✗'}
                                                    </span>
                                                    <span
                                                        class={check.pass
                                                            ? 'text-surface-300'
                                                            : 'text-surface-400'}>
                                                        {check.label}
                                                    </span>
                                                </div>
                                            {/each}
                                        </div>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    </div>
                </div>
            </details>
            <!-- Disclaimer for non-own-browser profiles -->
            {#if !browser.is_own_browser}
                <div
                    class="flex gap-2 text-xs text-surface-400 bg-surface-800/50 rounded-lg px-3 py-2.5 border border-surface-700/40">
                    <span class="flex-none">ℹ</span>
                    <span>{m.media_plain_profile_limits({ browser: browser.browser_label })}</span>
                </div>
            {/if}
        </div>
    </div>
</div>
