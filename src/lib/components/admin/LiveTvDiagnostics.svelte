<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { onMount } from 'svelte';
    import type { ProxyChannelInfo } from '$lib/schemas/livetv';
    import * as m from '$lib/paraglide/messages';

    let { channel }: { channel: ProxyChannelInfo } = $props();
    let now = $state(Date.now());
    onMount(() => {
        const timer = setInterval(() => (now = Date.now()), 1000);
        return () => clearInterval(timer);
    });
    const diagnostics = $derived(channel.outputDiagnostics);
    const outputAge = $derived(
        channel.lastSegmentAt
            ? Math.max(0, (now - Date.parse(channel.lastSegmentAt)) / 1000)
            : undefined,
    );
    const ageText = $derived(
        outputAge !== undefined && Number.isFinite(outputAge)
            ? m.admin_sessions_seconds_ago({ seconds: Math.floor(outputAge) })
            : m.admin_livetv_unavailable(),
    );
</script>

<details class="rounded-lg border border-surface-700/60 bg-surface-900/30 text-xs text-surface-300">
    <summary
        class="cursor-pointer px-3 py-2 focus-visible:outline focus-visible:outline-primary-400">
        {m.admin_livetv_diagnostics()} · {m.admin_livetv_last_output()}: {ageText}
    </summary>
    <div class="grid gap-4 border-t border-surface-700/60 p-3 sm:grid-cols-3">
        <section>
            <h4 class="mb-2 font-medium text-surface-100">{m.admin_livetv_source()}</h4>
            <dl class="space-y-1">
                <div>
                    <dt class="inline">{m.admin_livetv_video()}:</dt>
                    <dd class="inline">
                        {channel.probeResult?.videoCodec ??
                            '—'}{#if channel.probeResult?.width && channel.probeResult?.height}
                            · {channel.probeResult.width}×{channel.probeResult.height}{/if}
                    </dd>
                </div>
                <div>
                    <dt class="inline">{m.admin_livetv_audio()}:</dt>
                    <dd class="inline">{channel.probeResult?.audioCodec ?? '—'}</dd>
                </div>
                <div>
                    <dt class="inline">{m.admin_livetv_processing()}:</dt>
                    <dd class="inline">
                        {#if channel.transcodeDecision}{m.admin_livetv_video()}: {channel
                                .transcodeDecision.videoAction === 'copy'
                                ? m.admin_livetv_copy()
                                : m.admin_livetv_transcode()} · {m.admin_livetv_audio()}: {channel
                                .transcodeDecision.audioAction === 'copy'
                                ? m.admin_livetv_copy()
                                : m.admin_livetv_transcode()}{:else}—{/if}
                    </dd>
                </div>
                <div>
                    <dt class="inline">{m.admin_livetv_failovers()}:</dt>
                    <dd class="inline">{channel.failoverCount ?? '—'}</dd>
                </div>
            </dl>
        </section>
        <section>
            <h4 class="mb-2 font-medium text-surface-100">{m.admin_livetv_relay()}</h4>
            <dl class="space-y-1">
                <div>
                    <dt class="inline">{m.admin_livetv_last_output()}:</dt>
                    <dd class="inline">{ageText}</dd>
                </div>
                <div>
                    <dt class="inline">{m.admin_livetv_retained()}:</dt>
                    <dd class="inline">
                        {diagnostics
                            ? m.admin_livetv_seconds({
                                  seconds: diagnostics.bufferedSeconds.toFixed(1),
                              })
                            : '—'} · {m.admin_livetv_segments({
                            count: channel.segmentCount ?? '—',
                        })}
                    </dd>
                </div>
                <div>
                    <dt class="inline">{m.admin_livetv_memory()}:</dt>
                    <dd class="inline">
                        {channel.memoryBytes !== undefined
                            ? `${(channel.memoryBytes / 1048576).toFixed(1)} MiB`
                            : '—'}
                    </dd>
                </div>
            </dl>
            <p class="mt-2 text-surface-400">{m.admin_livetv_retained_hint()}</p>
        </section>
        <section>
            <h4 class="mb-2 font-medium text-surface-100">{m.admin_livetv_continuity()}</h4>
            {#if diagnostics && diagnostics.timestampSamples > 1}
                <dl class="space-y-1">
                    <div>
                        <dt class="inline">{m.admin_livetv_gaps()}:</dt>
                        <dd class={['inline', { 'text-amber-300': diagnostics.gapCount > 0 }]}>
                            {diagnostics.gapCount}
                        </dd>
                    </div>
                    <div>
                        <dt class="inline">{m.admin_livetv_largest_gap()}:</dt>
                        <dd class="inline">
                            {m.admin_livetv_seconds({
                                seconds: diagnostics.largestGapSeconds.toFixed(2),
                            })}
                        </dd>
                    </div>
                    {#if diagnostics.lastGapAt}<div>
                            <dt class="inline">{m.admin_livetv_last_gap()}:</dt>
                            <dd class="inline">
                                {new Date(diagnostics.lastGapAt).toLocaleTimeString()}
                            </dd>
                        </div>{/if}
                    <div>
                        <dt class="inline">{m.admin_livetv_resets()}:</dt>
                        <dd class="inline">{diagnostics.resetCount}</dd>
                    </div>
                </dl>
            {:else}
                <p>{m.admin_livetv_unavailable()}</p>
            {/if}
            <p class="mt-2 text-surface-400">{m.admin_livetv_continuity_hint()}</p>
        </section>
    </div>
</details>
