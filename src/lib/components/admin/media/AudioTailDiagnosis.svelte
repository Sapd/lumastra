<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';
    import * as m from '$lib/paraglide/messages.js';
    let { assessment }: { assessment?: AudioTailAssessment } = $props();
</script>

{#if assessment}
    <div class="mt-2 space-y-1 text-xs text-surface-300" data-testid="audio-tail-diagnosis">
        <p>
            {assessment.observation === 'audible'
                ? m.admin_tail_audible()
                : assessment.observation === 'near_silent'
                  ? m.admin_tail_near_silent()
                  : m.admin_tail_inconclusive()}
        </p>
        <p>{m.media_plain_tail_action()}</p>
        <details>
            <summary class="cursor-pointer">{m.media_plain_measurement_scope()}</summary>
            <p>{m.admin_tail_unverified()}</p>
            <p>{m.admin_tail_dated({ time: new Date(assessment.measuredAt).toLocaleString() })}</p>
            {#if assessment.requested}
                <p>
                    {m.admin_tail_scope({
                        start: assessment.requested.start.toFixed(3),
                        end: assessment.requested.end.toFixed(3),
                        streams: String(
                            assessment.streams.filter(
                                (stream) =>
                                    stream.samples > 0 || stream.noPostVideoPackets === true,
                            ).length,
                        ),
                        total: String(
                            assessment.inventory.filter((stream) => stream.codec_type === 'audio')
                                .length,
                        ),
                    })}
                </p>
            {/if}
            {#if assessment.scope !== 'measured'}<p>{m.admin_tail_partial()}</p>{/if}
        </details>
        <details>
            <summary class="cursor-pointer">{m.admin_tail_raw()}</summary>
            <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(
                    assessment,
                    null,
                    2,
                )}</pre>
        </details>
    </div>
{/if}
