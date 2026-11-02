<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    /**
     * DeviceRemote - a small web remote for one of the account's devices.
     *
     * Shows what the device plays (GET state, live `device.state` frames,
     * position extrapolated between reports) and sends commands to it
     * (POST /api/user/devices/{id}/commands). A control is offered only when
     * the device lists its command in `nowPlaying.availableCommands`; an idle
     * device gets just the message box.
     *
     * Design: docs/superpowers/specs/2026-10-16-device-remote-control-design.md
     */
    import { onMount } from 'svelte';
    import {
        Icon,
        Play,
        Pause,
        Stop,
        Backward,
        Forward,
        ChevronUp,
        ChevronDown,
        XMark,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import * as deviceApi from '$lib/api/device-commands';
    import { onDeviceState } from '$lib/stores/device-events';
    import { trackDeviceCommand } from '$lib/utils/device-command-tracker';
    import {
        commandFailureMessage,
        commandFailureOf,
        deviceSupports,
        extrapolatePosition,
        isSuccessful,
    } from '$lib/utils/device-remote';
    import { formatDuration } from '$lib/utils/time-formatting';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import type { DeviceCommandRequest, DeviceState } from '$lib/schemas/device-commands';

    interface Props {
        deviceSessionId: string;
        deviceName: string;
        onClose: () => void;
        /** The device or the right to control it is gone (a 404): the host closes the remote. */
        onGone?: () => void;
    }

    let { deviceSessionId, deviceName, onClose, onGone }: Props = $props();

    const DEFAULT_MESSAGE_MAX = 280;
    const STATE_REFRESH_MS = 10_000;

    let deviceState = $state<DeviceState | null>(null);
    let loading = $state(true);
    let loadFailed = $state(false);
    let pendingType = $state<string | null>(null);
    let notice = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
    let messageText = $state('');
    let nowMs = $state(Date.now());

    const abort = new AbortController();

    function applyState(next: DeviceState): void {
        if (next.deviceSessionId !== deviceSessionId) return;
        // Frames can arrive out of order; a lower revision is older news.
        if (deviceState && next.revision < deviceState.revision) return;
        deviceState = next;
        loadFailed = false;
    }

    async function loadState(): Promise<void> {
        try {
            const { data, error, status } = await deviceApi.getDeviceState(deviceSessionId);
            if (data && !error) applyState(data);
            else if (status === 404 && onGone) onGone();
            else if (!deviceState) loadFailed = true;
        } catch {
            if (!deviceState) loadFailed = true;
        } finally {
            loading = false;
        }
    }

    onMount(() => {
        void loadState();
        const unsubscribe = onDeviceState((next) => applyState(next));
        const tick = setInterval(() => (nowMs = Date.now()), 500);
        const refresh = setInterval(() => void loadState(), STATE_REFRESH_MS);
        return () => {
            abort.abort();
            unsubscribe();
            clearInterval(tick);
            clearInterval(refresh);
        };
    });

    let nowPlaying = $derived(deviceState?.nowPlaying ?? null);
    let available = $derived(new Set(nowPlaying?.availableCommands ?? []));
    let unreachable = $derived(deviceState !== null && deviceState.reachable === false);
    let canMessage = $derived(
        deviceState !== null &&
            !unreachable &&
            deviceSupports(deviceState.capabilities, 'ui.message'),
    );
    let messageMax = $derived.by(() => {
        const options = deviceState?.capabilities.commands['ui.message'];
        const max = options && typeof options.maxLength === 'number' ? options.maxLength : null;
        return max && max > 0 ? max : DEFAULT_MESSAGE_MAX;
    });

    let position = $derived(nowPlaying ? extrapolatePosition(nowPlaying, nowMs) : null);
    let duration = $derived(
        nowPlaying?.durationMs == null ? null : nowPlaying.durationMs / 1000,
    );
    let progressPct = $derived(
        position !== null && duration && duration > 0
            ? Math.min(100, Math.max(0, (position / duration) * 100))
            : null,
    );

    let seekSeconds = $derived(nowPlaying?.kind === 'audiobook' ? 30 : 10);
    let isLiveTv = $derived(nowPlaying?.kind === 'livetv');
    let skipNoun = $derived(
        nowPlaying?.kind === 'music'
            ? 'track'
            : nowPlaying?.kind === 'audiobook'
              ? 'chapter'
              : 'episode',
    );

    function has(type: string): boolean {
        return !unreachable && available.has(type);
    }

    function failureText(reason: string | undefined): string {
        return reason === 'stale_target' ? m.device_command_stale() : m.device_command_failed();
    }

    /** Send one command and follow it; resolves true when the device applied it. */
    async function run(request: DeviceCommandRequest): Promise<boolean> {
        if (pendingType) return false;
        pendingType = request.type;
        notice = null;
        try {
            const expect =
                request.type !== 'ui.message' && nowPlaying
                    ? { sessionId: nowPlaying.sessionId }
                    : undefined;
            const result = await deviceApi.sendDeviceCommand(deviceSessionId, {
                ...request,
                ...(expect ? { expect } : {}),
            });
            if (result.error || !result.data) {
                if (result.status === 404 && onGone) {
                    onGone();
                    return false;
                }
                const failure = commandFailureOf(result);
                notice = { tone: 'error', text: commandFailureMessage(failure, deviceName) };
                if (failure === 'stale_target') void loadState();
                return false;
            }
            const command = result.data.command;
            const settled = await trackDeviceCommand(command, {
                poll: async () =>
                    (await deviceApi.getDeviceCommand(deviceSessionId, command.id)).data,
                signal: abort.signal,
            });
            if (abort.signal.aborted) return false;
            if (settled && !isSuccessful(settled)) {
                notice = { tone: 'error', text: failureText(settled.reason) };
                if (settled.reason === 'stale_target') void loadState();
                return false;
            }
            return true;
        } catch {
            notice = { tone: 'error', text: m.device_command_failed() };
            return false;
        } finally {
            pendingType = null;
        }
    }

    async function sendMessage(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const text = messageText.trim();
        if (!text || pendingType) return;
        const ok = await run({ type: 'ui.message', args: { text } });
        if (ok) {
            messageText = '';
            notice = { tone: 'ok', text: m.device_remote_message_sent() };
        }
    }

    function handleKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        if (event.target instanceof HTMLInputElement) return;
        onClose();
    }

    function prevLabel(): string {
        return skipNoun === 'track'
            ? m.device_remote_previous_track()
            : skipNoun === 'chapter'
              ? m.device_remote_previous_chapter()
              : m.device_remote_previous_episode();
    }
    function nextLabel(): string {
        return skipNoun === 'track'
            ? m.device_remote_next_track()
            : skipNoun === 'chapter'
              ? m.device_remote_next_chapter()
              : m.device_remote_next_episode();
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    class="modal-overlay modal-overlay-50"
    style="z-index: {Z.MODAL}"
    role="dialog"
    aria-modal="true"
    aria-label={m.device_remote_title({ device: deviceName })}
    tabindex="-1"
    onclick={() => onClose()}
    onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="card-bordered p-6 max-w-md w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain"
        role="document"
        use:trapFocus
        onclick={stopPropagation()}>
        <div class="flex items-center justify-between gap-2 mb-4">
            <h3 class="text-xl font-semibold truncate">
                {m.device_remote_title({ device: deviceName })}
            </h3>
            <button
                type="button"
                class="btn variant-ghost-surface w-8 h-8 !p-0 rounded-full shrink-0"
                aria-label={m.device_remote_close()}
                title={m.device_remote_close()}
                data-autofocus
                onclick={() => onClose()}>
                <Icon src={XMark} class="w-4 h-4" aria-hidden="true" />
            </button>
        </div>

        {#if loading && !deviceState}
            <p class="text-sm text-surface-400">{m.device_remote_loading()}</p>
        {:else if loadFailed && !deviceState}
            <p class="text-sm text-surface-400" role="status">{m.device_remote_load_failed()}</p>
        {:else if deviceState}
            {#if unreachable}
                <p class="text-sm text-surface-400 mb-4" role="status">
                    {m.device_remote_offline({ device: deviceName })}
                </p>
            {/if}

            <!-- Now playing -->
            <div class="mb-4" data-testid="remote-now-playing">
                {#if nowPlaying}
                    <p class="font-medium truncate">{nowPlaying.title}</p>
                    {#if isLiveTv && nowPlaying.livetv}
                        <p class="text-sm text-surface-400 truncate">
                            {[
                                nowPlaying.livetv.number !== undefined
                                    ? m.device_remote_channel({ number: nowPlaying.livetv.number })
                                    : '',
                                nowPlaying.livetv.name,
                                nowPlaying.livetv.programme ?? '',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </p>
                    {:else if nowPlaying.subtitle}
                        <p class="text-sm text-surface-400 truncate">{nowPlaying.subtitle}</p>
                    {/if}
                    {#if !isLiveTv && position !== null}
                        <div class="mt-2">
                            {#if progressPct !== null}
                                <div
                                    class="h-1 w-full rounded-full bg-surface-700 overflow-hidden"
                                    aria-hidden="true">
                                    <div
                                        class="h-full bg-primary-500"
                                        style="width: {progressPct}%">
                                    </div>
                                </div>
                            {/if}
                            <p class="mt-1 text-xs text-surface-400 tabular-nums">
                                {formatDuration(position)}{duration
                                    ? ` / ${formatDuration(duration)}`
                                    : ''}
                            </p>
                        </div>
                    {/if}
                {:else}
                    <p class="text-sm text-surface-400">{m.device_remote_idle()}</p>
                {/if}
            </div>

            <!-- Transport: only what the device says works right now -->
            {#if nowPlaying}
                <div class="flex flex-wrap items-center justify-center gap-2 mb-4">
                    {#if has('playback.previous') && !isLiveTv}
                        <button
                            type="button"
                            class="btn variant-soft-surface"
                            disabled={pendingType !== null}
                            aria-label={prevLabel()}
                            title={prevLabel()}
                            onclick={() => run({ type: 'playback.previous' })}>
                            <Icon src={Backward} class="w-5 h-5" aria-hidden="true" />
                        </button>
                    {/if}
                    {#if has('playback.seekBy') && !isLiveTv}
                        <button
                            type="button"
                            class="btn variant-soft-surface tabular-nums"
                            disabled={pendingType !== null}
                            aria-label={m.device_remote_back_seconds({ seconds: seekSeconds })}
                            title={m.device_remote_back_seconds({ seconds: seekSeconds })}
                            onclick={() =>
                                run({ type: 'playback.seekBy', args: { seconds: -seekSeconds } })}>
                            −{seekSeconds}
                        </button>
                    {/if}
                    {#if has('playback.togglePause')}
                        <button
                            type="button"
                            class="btn variant-filled-primary"
                            disabled={pendingType !== null}
                            aria-label={nowPlaying.paused
                                ? m.device_remote_play()
                                : m.device_remote_pause()}
                            title={nowPlaying.paused
                                ? m.device_remote_play()
                                : m.device_remote_pause()}
                            onclick={() => run({ type: 'playback.togglePause' })}>
                            <Icon
                                src={nowPlaying.paused ? Play : Pause}
                                class="w-5 h-5"
                                aria-hidden="true" />
                        </button>
                    {/if}
                    {#if has('playback.seekBy') && !isLiveTv}
                        <button
                            type="button"
                            class="btn variant-soft-surface tabular-nums"
                            disabled={pendingType !== null}
                            aria-label={m.device_remote_forward_seconds({ seconds: seekSeconds })}
                            title={m.device_remote_forward_seconds({ seconds: seekSeconds })}
                            onclick={() =>
                                run({ type: 'playback.seekBy', args: { seconds: seekSeconds } })}>
                            +{seekSeconds}
                        </button>
                    {/if}
                    {#if has('playback.next') && !isLiveTv}
                        <button
                            type="button"
                            class="btn variant-soft-surface"
                            disabled={pendingType !== null}
                            aria-label={nextLabel()}
                            title={nextLabel()}
                            onclick={() => run({ type: 'playback.next' })}>
                            <Icon src={Forward} class="w-5 h-5" aria-hidden="true" />
                        </button>
                    {/if}
                </div>

                {#if isLiveTv && (has('livetv.channelDown') || has('livetv.channelUp'))}
                    <div class="flex flex-wrap items-center justify-center gap-2 mb-4">
                        {#if has('livetv.channelDown')}
                            <button
                                type="button"
                                class="btn variant-soft-surface"
                                disabled={pendingType !== null}
                                onclick={() => run({ type: 'livetv.channelDown' })}>
                                <Icon src={ChevronDown} class="w-4 h-4" aria-hidden="true" />
                                <span>{m.device_remote_channel_down()}</span>
                            </button>
                        {/if}
                        {#if has('livetv.channelUp')}
                            <button
                                type="button"
                                class="btn variant-soft-surface"
                                disabled={pendingType !== null}
                                onclick={() => run({ type: 'livetv.channelUp' })}>
                                <Icon src={ChevronUp} class="w-4 h-4" aria-hidden="true" />
                                <span>{m.device_remote_channel_up()}</span>
                            </button>
                        {/if}
                    </div>
                {/if}

                {#if has('playback.stop')}
                    <div class="flex justify-center mb-4">
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            disabled={pendingType !== null}
                            onclick={() => run({ type: 'playback.stop' })}>
                            <Icon src={Stop} class="w-4 h-4" aria-hidden="true" />
                            <span>{m.device_remote_stop()}</span>
                        </button>
                    </div>
                {/if}
            {/if}

            <!-- Message to the screen -->
            {#if canMessage}
                <form class="flex items-end gap-2" onsubmit={sendMessage}>
                    <label class="flex-1 min-w-0 text-sm">
                        <span class="block mb-1 text-surface-300"
                            >{m.device_remote_message_label()}</span>
                        <input
                            type="text"
                            class="input w-full"
                            maxlength={messageMax}
                            placeholder={m.device_remote_message_placeholder()}
                            bind:value={messageText} />
                    </label>
                    <button
                        type="submit"
                        class="btn variant-filled-primary"
                        disabled={pendingType !== null || messageText.trim().length === 0}>
                        {m.device_remote_message_send()}
                    </button>
                </form>
            {/if}

            <div aria-live="polite" role="status" class="mt-3 min-h-5 text-sm">
                {#if notice}
                    <p class={notice.tone === 'error' ? 'text-warning-400' : 'text-success-400'}>
                        {notice.text}
                    </p>
                {/if}
            </div>
        {/if}
    </div>
</div>
