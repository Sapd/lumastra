<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type {
        CompatibilityResponse,
        FileCompatibility,
        BrowserCompatibility,
    } from '$lib/schemas/admin-types.js';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';

    interface Props {
        data: CompatibilityResponse;
        onBrowserClick?: (browser: BrowserCompatibility, file: FileCompatibility) => void;
    }

    let { data, onBrowserClick }: Props = $props();

    function getFilename(path: string): string {
        return path.split('/').pop() ?? path;
    }

    function formatBitrate(bps: number | undefined): string {
        if (!bps) return '';
        return ` · ${Math.round(bps / 1_000_000)} Mbps`;
    }

    function formatHdr(hdr: string): string {
        if (!hdr || hdr === 'none' || hdr === 'SDR') return '';
        return ` · ${hdr}`;
    }

    function formatAudio(codecs: string[], channels: number | undefined): string {
        if (!codecs.length) return '';
        const ch = channels
            ? ` ${channels >= 6 ? '5.1' : channels >= 8 ? '7.1' : `${channels}.0`}`
            : '';
        return ` · ${codecs[0].toUpperCase()}${ch}`;
    }

    function getMediaSummary(file: FileCompatibility): string {
        const { video_codec, audio_codecs, container, hdr, bitrate, audio_channels } =
            file.media_info;
        return [
            video_codec.toUpperCase(),
            audio_codecs.length
                ? `${audio_codecs[0].toUpperCase()}${audio_channels ? ` ${formatChannels(audio_channels)}` : ''}`
                : null,
            container.toUpperCase(),
            hdr && hdr !== 'none' && hdr !== 'SDR' ? hdr : null,
            bitrate ? `${Math.round(bitrate / 1_000_000)} Mbps` : null,
        ]
            .filter(Boolean)
            .join(' · ');
    }

    function formatChannels(ch: number): string {
        if (ch >= 8) return '7.1';
        if (ch >= 6) return '5.1';
        if (ch >= 2) return '2.0';
        return `${ch}.0`;
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

    function formatVideoActionForFile(
        browser: BrowserCompatibility,
        file: FileCompatibility,
    ): string {
        if (browser.video_action === 'copy') return m.media_plain_direct();
        const from = file.media_info.video_codec.toUpperCase();
        const to = (browser.target_video_codec ?? '?').toUpperCase();
        return `${from} → ${to}`;
    }

    function formatAudioActionForFile(
        browser: BrowserCompatibility,
        file: FileCompatibility,
    ): string {
        if (browser.audio_action === 'copy') return m.media_plain_direct();
        const from = (file.media_info.audio_codecs[0] ?? '?').toUpperCase();
        const to = (browser.target_audio_codec ?? '?').toUpperCase();
        return `${from} → ${to}`;
    }
</script>

<div class="space-y-6">
    {#each data.files as file (file.file_id)}
        <div class="rounded-lg border border-surface-700/50 bg-surface-800/80 overflow-hidden">
            <!-- File header -->
            <div class="px-4 py-3 border-b border-surface-700/50 bg-surface-700/30">
                <p class="text-sm font-medium text-white truncate">
                    {getFilename(file.file_path)}
                </p>
                <p class="text-xs text-surface-400 mt-0.5">
                    {getMediaSummary(file)}
                </p>
            </div>

            <!-- Browser compatibility table -->
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead>
                        <tr class="border-b border-surface-700/50">
                            <th
                                class="px-3 py-2 text-left text-surface-500 font-medium w-24 min-w-[6rem]"
                                >&nbsp;</th>
                            {#each file.browsers as browser (browser.browser_id)}
                                <th class="px-3 py-2 text-center">
                                    <button
                                        class="font-medium transition-colors hover:text-white {browser.is_own_browser
                                            ? 'text-primary-400'
                                            : 'text-surface-300'}"
                                        onclick={() => onBrowserClick?.(browser, file)}>
                                        {#if browser.is_own_browser}
                                            <span class="mr-1">🖥</span>
                                        {/if}
                                        {browser.browser_label}
                                    </button>
                                </th>
                            {/each}
                        </tr>
                    </thead>
                    <tbody>
                        <!-- Method row -->
                        <tr class="border-b border-surface-700/30">
                            <td class="px-3 py-2 text-surface-500 font-medium"
                                >{m.media_plain_method()}</td>
                            {#each file.browsers as browser (browser.browser_id)}
                                <td class="px-3 py-2 text-center">
                                    {#if browser.transcode_reasons.length > 0}
                                        <Tooltip
                                            text={browser.transcode_reasons.join(' · ')}
                                            position="top">
                                            <span
                                                class="px-2 py-0.5 rounded text-[11px] font-medium {getMethodColor(
                                                    browser.method,
                                                )}">
                                                {getMethodLabel(browser.method)}
                                            </span>
                                        </Tooltip>
                                    {:else}
                                        <span
                                            class="px-2 py-0.5 rounded text-[11px] font-medium {getMethodColor(
                                                browser.method,
                                            )}">
                                            {getMethodLabel(browser.method)}
                                        </span>
                                    {/if}
                                </td>
                            {/each}
                        </tr>

                        <!-- Video row -->
                        <tr class="border-b border-surface-700/30">
                            <td class="px-3 py-2 text-surface-500 font-medium"
                                >{m.media_plain_video()}</td>
                            {#each file.browsers as browser (browser.browser_id)}
                                <td class="px-3 py-2 text-center">
                                    {#if browser.video_action === 'copy'}
                                        <span class="text-green-400">{m.media_plain_direct()}</span>
                                    {:else}
                                        <span class="text-surface-300">
                                            {formatVideoActionForFile(browser, file)}
                                        </span>
                                    {/if}
                                </td>
                            {/each}
                        </tr>

                        <!-- Audio row -->
                        <tr>
                            <td class="px-3 py-2 text-surface-500 font-medium"
                                >{m.media_plain_audio()}</td>
                            {#each file.browsers as browser (browser.browser_id)}
                                <td class="px-3 py-2 text-center">
                                    {#if browser.audio_action === 'copy'}
                                        <span class="text-green-400">{m.media_plain_direct()}</span>
                                    {:else}
                                        <span class="text-surface-300">
                                            {formatAudioActionForFile(browser, file)}
                                        </span>
                                    {/if}
                                </td>
                            {/each}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    {/each}

    <p class="text-xs text-surface-400">{m.media_plain_compat_action()}</p>
    <details class="text-xs text-surface-500">
        <summary>{m.media_plain_technical_details()}</summary>
        <p>{m.media_plain_compat_profiles()}</p>
    </details>
</div>
