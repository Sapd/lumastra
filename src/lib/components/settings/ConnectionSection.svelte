<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  "Connection" settings group: a test profile and one button that downloads a
  sample from this server and reports what actually arrived.

  The measurement is taken in the browser (see speed-test-client.ts) because the
  only side of the wire that can answer "is it my line or the server?" is the
  receiving one. The displayed numbers come from the 201 body, not from local
  maths — the server derives throughput, slowest bucket and stall time from the
  raw counters so every stored row and every shown row agree.

  Three profiles, because one bulk download does not answer every question:
  `cadence` is the one that catches a link which passes a straight 16 MB pull and
  still stutters during playback, because HLS asks for a segment, waits, and asks
  again. Its result line is a different sentence — there is no "slowest quarter
  second" when no buckets were recorded — so the mode chooses the message key.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { getDeviceId } from '$lib/components/player/device-id';
    import { postSpeedTestResult } from '$lib/api/playback';
    import { runSpeedTest } from '$lib/utils/network/speed-test-client';
    import {
        SPEED_TEST_CADENCE_CHUNK_BYTES,
        SPEED_TEST_CADENCE_REQUESTS,
        SPEED_TEST_DEFAULT_BYTES,
        SPEED_TEST_LONG_BYTES,
        speedTestModeSchema,
        type SpeedTestMode,
    } from '$lib/schemas/playback';
    import SettingsGroup from './SettingsGroup.svelte';
    import SettingRow from './SettingRow.svelte';
    import { Icon, ChevronDown } from 'svelte-hero-icons';

    /**
     * Remembered locally rather than in the account preferences: which profile
     * someone reaches for is a property of the machine and the line they are
     * debugging, not of their account, and it must survive a reload without a
     * round trip.
     */
    const MODE_STORAGE_KEY = 'dashboard_speed_test_mode';

    /**
     * Every read and write is guarded: `localStorage` is undefined during SSR and
     * THROWS on access in a browser configured to block site data.
     */
    function readStoredMode(): SpeedTestMode {
        try {
            const parsed = speedTestModeSchema.safeParse(
                globalThis.localStorage?.getItem(MODE_STORAGE_KEY),
            );
            if (parsed.success) return parsed.data;
        } catch {
            // Storage unavailable — the default is a perfectly good answer.
        }
        return 'single';
    }

    let mode = $state<SpeedTestMode>(readStoredMode());
    let running = $state(false);
    let bytesSoFar = $state(0);
    let resultText = $state('');
    let verdict = $state<{ text: string; good: boolean } | null>(null);
    let failed = $state(false);

    /** What a full run of the selected profile will pull, for the progress bar. */
    const expectedBytes = $derived(
        mode === 'long'
            ? SPEED_TEST_LONG_BYTES
            : mode === 'cadence'
              ? SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES
              : SPEED_TEST_DEFAULT_BYTES,
    );

    function modeLabel(value: SpeedTestMode): string {
        switch (value) {
            case 'long':
                return m.settings_connection_mode_long();
            case 'cadence':
                return m.settings_connection_mode_cadence();
            default:
                return m.settings_connection_mode_single();
        }
    }

    function selectMode(raw: string): void {
        const parsed = speedTestModeSchema.safeParse(raw);
        if (!parsed.success) return;
        mode = parsed.data;
        // A stale result describes the previous profile — showing it next to a
        // different selection would misattribute it.
        resultText = '';
        verdict = null;
        failed = false;
        try {
            globalThis.localStorage?.setItem(MODE_STORAGE_KEY, parsed.data);
        } catch {
            // Not persisting a preference is not worth failing a click over.
        }
    }

    /** Bits per second → Mbit/s with one decimal, as the result message expects. */
    function mbit(bps: number): string {
        return (bps / 1_000_000).toFixed(1);
    }

    /**
     * The plain answer to "why does it buffer?". The raw numbers stay underneath
     * for anyone reporting a problem, but on their own ("200.0 Mbit/s · first
     * byte 67 ms · slowest ¼ s …") they answered nothing for most people. The
     * thresholds are the usual streaming rules of thumb, with headroom.
     */
    function connectionVerdict(bps: number, stallMs: number): { text: string; good: boolean } {
        const mbps = bps / 1_000_000;
        if (stallMs >= 500) return { text: m.settings_connection_verdict_stalled(), good: false };
        if (mbps >= 40) return { text: m.settings_connection_verdict_4k(), good: true };
        if (mbps >= 15) return { text: m.settings_connection_verdict_1080p(), good: true };
        if (mbps >= 6) return { text: m.settings_connection_verdict_720p(), good: true };
        return { text: m.settings_connection_verdict_slow(), good: false };
    }

    function ms(value: number): string {
        return String(Math.round(value));
    }

    async function test(): Promise<void> {
        if (running) return;
        running = true;
        failed = false;
        resultText = '';
        verdict = null;
        bytesSoFar = 0;
        try {
            // An aborted run (the 20 s cap) still resolves and is still worth
            // posting: "could not finish in 20 seconds" is a measurement.
            const requested = mode;
            const measurement = await runSpeedTest({
                mode: requested,
                onProgress: (p) => {
                    bytesSoFar = p.bytesReceived;
                },
            });
            const { data, error } = await postSpeedTestResult({
                ...measurement,
                mode: requested,
                deviceId: getDeviceId(),
                clientInfo: { engine: 'web', ua: navigator.userAgent.slice(0, 120) },
            });
            if (error || !data) throw new Error(error ?? 'speed-test result was not stored');
            verdict = connectionVerdict(data.throughputBps, data.stallMs);
            resultText =
                requested === 'cadence'
                    ? m.settings_connection_result_cadence({
                          mbps: mbit(data.throughputBps),
                          n: String(data.requestCount ?? measurement.requests?.length ?? 0),
                          // The worst SEGMENT, not the worst quarter-second: a
                          // cadence run records no buckets at all.
                          min: data.minRequestBps === null ? '—' : mbit(data.minRequestBps),
                          ttfb: data.maxTtfbMs === null ? '—' : ms(data.maxTtfbMs),
                      })
                    : m.settings_connection_result({
                          mbps: mbit(data.throughputBps),
                          ttfb: ms(data.ttfbMs),
                          // Fewer than two buckets — nothing to compare, so there is no
                          // slowest quarter-second to name.
                          min: data.minBucketBps === null ? '—' : mbit(data.minBucketBps),
                          stall: ms(data.stallMs),
                      });
        } catch {
            failed = true;
            toasts.error(m.settings_connection_failed());
        } finally {
            running = false;
        }
    }
</script>

<SettingsGroup label={m.settings_connection_group()}>
    <SettingRow
        label={m.settings_connection_test_label()}
        hint={m.settings_connection_test_hint()}
        anchorId="connection-speed-test">
        {#snippet control()}
            <div class="flex flex-col items-end gap-1">
                <button
                    type="button"
                    class="btn btn-sm variant-filled-surface"
                    disabled={running}
                    onclick={() => void test()}>
                    {running ? m.settings_connection_running() : m.settings_connection_test_label()}
                </button>
                {#if running}
                    <div
                        class="h-1 w-40 overflow-hidden rounded bg-surface-700"
                        role="progressbar"
                        aria-label={m.settings_connection_running()}
                        aria-valuemin={0}
                        aria-valuemax={expectedBytes}
                        aria-valuenow={bytesSoFar}>
                        <div
                            class="h-full bg-primary-500"
                            style="width: {Math.min(100, (bytesSoFar / expectedBytes) * 100)}%">
                        </div>
                    </div>
                    <p class="text-xs text-surface-400 tabular-nums">
                        {formatFileSize(bytesSoFar)}
                    </p>
                {/if}
            </div>
        {/snippet}
    </SettingRow>
    {#if resultText || failed}
        <div class="px-4 py-3" aria-live="polite">
            {#if failed}
                <p class="text-sm text-error-400">{m.settings_connection_failed()}</p>
            {:else}
                {#if verdict}
                    <p class="text-sm {verdict.good ? 'text-success-400' : 'text-warning-300'}">
                        {verdict.text}
                    </p>
                {/if}
                <p class="text-xs text-surface-400 tabular-nums mt-1">{resultText}</p>
            {/if}
        </div>
    {/if}
    <!-- Test profiles are for chasing a specific problem; the quick one is the
         right default, so the choice sits behind a disclosure. -->
    <details class="group" open={mode !== 'single'}>
        <summary
            class="flex items-center justify-between gap-2 py-3 px-4 cursor-pointer list-none text-sm text-surface-300">
            <span>{m.settings_connection_advanced()}</span>
            <Icon
                src={ChevronDown}
                class="w-4 h-4 text-surface-400 transition-transform group-open:rotate-180" />
        </summary>
        <SettingRow
            label={m.settings_connection_mode_label()}
            hint={m.settings_connection_mode_hint()}
            anchorId="connection-speed-test-mode">
            {#snippet control()}
                <select
                    class="select select-sm w-auto max-w-full"
                    aria-label={m.settings_connection_mode_label()}
                    disabled={running}
                    value={mode}
                    onchange={(e) => selectMode(e.currentTarget.value)}>
                    {#each speedTestModeSchema.options as option (option)}
                        <option value={option}>{modeLabel(option)}</option>
                    {/each}
                </select>
            {/snippet}
        </SettingRow>
    </details>
</SettingsGroup>
