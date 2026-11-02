<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';
    import { isEpisode } from '$lib/shared/media-types';
    import { onMount, onDestroy } from 'svelte';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import * as userApi from '$lib/api/user';
    import * as watchTogetherApi from '$lib/api/watch-together';
    import {
        commandFailureMessage,
        commandFailureOf,
        deviceSupports,
    } from '$lib/utils/device-remote';
    import type { PageData } from './$types';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    /**
     * The devices endpoint is schema-typed now, so this is the response row
     * rather than a hand-rolled shape. The old local interface declared only
     * five fields and was therefore NOT a subtype of the response row (no `id`,
     * `deviceId`, `createdAt`…), which made `.filter(isOnlineDevice)` reject the
     * predicate outright — the guard has been dropped with it.
     */
    type OnlineDevice = UserDeviceInfo;

    // State
    let isJoining = $state(false);
    let error = $state<string | null>(null);
    let devices: OnlineDevice[] = $state([]);
    let loadingDevices = $state(true);
    let sentToDevice = $state<string | null>(null);
    let sendingToDevice = $state<string | null>(null);
    let devicePollInterval: ReturnType<typeof setInterval> | null = null;

    // Don't auto-join anymore - let user choose device
    const autoJoin = false;

    async function fetchDevices() {
        try {
            const { data, error } = await userApi.getDevices({ onlineOnly: true });
            if (!error && data) {
                // Only devices that announce `party.join` can take the invite
                devices = data.items.filter((d) => deviceSupports(d.capabilities, 'party.join'));
            }
        } catch (err) {
            console.error('[Party] Failed to fetch devices:', err);
        } finally {
            loadingDevices = false;
        }
    }

    async function joinHere() {
        if (isJoining) return;
        isJoining = true;
        error = null;

        try {
            const session = await watchTogether.joinSession(data.party.code, data.userId);

            if (!session) {
                error = m.party_join_failed();
                return;
            }

            // Navigate to the video with fileId if present
            const watchUrl = session.fileId
                ? `/watch/${session.itemId}?fileId=${session.fileId}`
                : `/watch/${session.itemId}`;

            await goto(resolve(watchUrl));
        } catch (err) {
            console.error('[Party] Join error:', err);
            error = err instanceof Error ? err.message : m.party_join_failed();
        } finally {
            isJoining = false;
        }
    }

    async function sendToDevice(device: OnlineDevice) {
        if (sendingToDevice) return;
        sendingToDevice = device.deviceSessionId;
        error = null;

        try {
            const result = await watchTogetherApi.sendToDevice(
                data.party.code,
                device.deviceSessionId,
            );

            if (result.error) {
                error = commandFailureMessage(
                    commandFailureOf(result),
                    device.deviceName || m.party_unknown_tv(),
                );
                return;
            }

            sentToDevice = device.deviceName || m.party_unknown_tv();
        } catch (err) {
            console.error('[Party] Send to device error:', err);
            error = m.device_command_failed();
        } finally {
            sendingToDevice = null;
        }
    }

    onMount(() => {
        // Fetch devices immediately
        fetchDevices();

        // Poll for new devices every 5 seconds
        devicePollInterval = setInterval(fetchDevices, 5000);

        if (autoJoin) {
            joinHere();
        }
    });

    onDestroy(() => {
        if (devicePollInterval) {
            clearInterval(devicePollInterval);
        }
    });
</script>

<svelte:head>
    <title>{m.party_join_title({ title: data.party.title })}</title>
</svelte:head>

<div class="party-join-page">
    <div class="party-card">
        <div class="party-header">
            <span class="party-badge">
                <span class="live-dot"></span>
                {m.party_watch_party()}
            </span>
        </div>

        <div class="party-info">
            <h1 class="party-title">{data.party.title}</h1>
            <p class="party-meta">
                <span class="media-type"
                    >{isEpisode(data.party.mediaType) ? m.media_series() : m.media_movie()}</span>
                <span class="separator">•</span>
                <span
                    >{m.party_hosted_by({
                        host: data.party.host.displayName ?? '',
                    })}</span>
                <span class="separator">•</span>
                <span
                    >{m.party_watching({
                        count: data.party.participantCount.toString(),
                    })}</span>
            </p>
        </div>

        {#if sentToDevice}
            <!-- Success: Sent to device -->
            <div class="success-message">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="2"
                    stroke="currentColor"
                    width="24"
                    height="24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                <div class="success-text">
                    <span class="success-title">{m.party_sent_to_device()}</span>
                    <span class="success-subtitle"
                        >{m.party_check_your_tv({
                            device: sentToDevice,
                        })}</span>
                </div>
            </div>
            <button
                class="join-here-btn secondary"
                onclick={() => {
                    sentToDevice = null;
                }}>
                {m.party_send_to_another_device()}
            </button>
            <button class="join-here-btn" onclick={joinHere} disabled={isJoining}>
                {m.party_join_here_instead()}
            </button>
        {:else if error}
            <!-- Error state -->
            <div class="error-message">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="2"
                    stroke="currentColor"
                    width="20"
                    height="20">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                </svg>
                <span>{error}</span>
            </div>
            <button class="retry-btn" onclick={joinHere} disabled={isJoining}>
                {m.party_try_again()}
            </button>
            <a href={resolve('/')} class="home-link">{m.party_go_to_homepage()}</a>
        {:else if isJoining}
            <!-- Joining state -->
            <div class="joining-status">
                <div class="spinner"></div>
                <span>{m.party_joining()}</span>
            </div>
        {:else}
            <!-- Device selection -->
            <div class="device-selection">
                <h2 class="device-selection-title">
                    {m.party_where_to_watch()}
                </h2>

                <div class="device-list">
                    <!-- This device option -->
                    <button class="device-option this-device" onclick={joinHere}>
                        <div class="device-icon">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke-width="1.5"
                                stroke="currentColor"
                                width="28"
                                height="28">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                            </svg>
                        </div>
                        <div class="device-info">
                            <span class="device-name">{m.party_this_device()}</span>
                            <span class="device-type">{m.party_watch_in_browser()}</span>
                        </div>
                    </button>

                    <!-- Online TV devices -->
                    {#if loadingDevices}
                        <div class="devices-loading">
                            <div class="spinner small"></div>
                            <span>{m.party_looking_for_devices()}</span>
                        </div>
                    {:else if devices.length > 0}
                        {#each devices as device (device.deviceSessionId)}
                            <button
                                class="device-option tv-device"
                                onclick={() => sendToDevice(device)}
                                disabled={sendingToDevice === device.deviceSessionId}>
                                <div class="device-icon tv">
                                    {#if sendingToDevice === device.deviceSessionId}
                                        <div class="spinner small"></div>
                                    {:else}
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke-width="1.5"
                                            stroke="currentColor"
                                            width="28"
                                            height="28">
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z" />
                                        </svg>
                                    {/if}
                                </div>
                                <div class="device-info">
                                    <span class="device-name"
                                        >{device.deviceName || m.party_unknown_tv()}</span>
                                    <span class="device-status online">
                                        <span class="online-dot"></span>
                                        {m.party_device_online()}
                                    </span>
                                </div>
                            </button>
                        {/each}
                    {/if}
                </div>

                <!-- Hint for no devices -->
                {#if !loadingDevices && devices.length === 0}
                    <div class="no-devices-hint">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke-width="1.5"
                            stroke="currentColor"
                            width="20"
                            height="20">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                        </svg>
                        <span>{m.party_turn_on_tv_hint()}</span>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .party-join-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 5rem 1rem 1rem;
        background: linear-gradient(180deg, #0f0f1a 0%, #1a1a2e 100%);
    }

    .party-card {
        width: 100%;
        max-width: 440px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 2rem;
        text-align: center;
    }

    .party-header {
        margin-bottom: 1.5rem;
    }

    .party-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        background: rgba(239, 68, 68, 0.2);
        border: 1px solid rgba(239, 68, 68, 0.4);
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 600;
        color: #ef4444;
        text-transform: uppercase;
        letter-spacing: 0.1em;
    }

    .live-dot {
        width: 8px;
        height: 8px;
        background: #ef4444;
        border-radius: 50%;
        animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    .party-info {
        margin-bottom: 2rem;
    }

    .party-title {
        font-size: 1.5rem;
        font-weight: 600;
        color: white;
        margin: 0 0 0.75rem;
    }

    .party-meta {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 0.5rem;
        font-size: 0.875rem;
        color: rgba(255, 255, 255, 0.6);
        margin: 0;
    }

    .separator {
        opacity: 0.4;
    }

    .media-type {
        color: #8b5cf6;
    }

    /* Device Selection */
    .device-selection {
        text-align: left;
    }

    .device-selection-title {
        font-size: 1rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.7);
        margin: 0 0 1rem;
        text-align: center;
    }

    .device-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .device-option {
        display: flex;
        align-items: center;
        gap: 1rem;
        width: 100%;
        padding: 1rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
    }

    .device-option:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(139, 92, 246, 0.5);
    }

    .device-option:disabled {
        opacity: 0.7;
        cursor: wait;
    }

    .device-option.this-device {
        border-color: rgba(139, 92, 246, 0.3);
        background: rgba(139, 92, 246, 0.1);
    }

    .device-option.this-device:hover {
        background: rgba(139, 92, 246, 0.2);
        border-color: rgba(139, 92, 246, 0.5);
    }

    .device-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 48px;
        height: 48px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        color: rgba(255, 255, 255, 0.8);
    }

    .device-icon.tv {
        background: rgba(34, 197, 94, 0.2);
        color: #22c55e;
    }

    .device-info {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .device-name {
        font-size: 1rem;
        font-weight: 500;
        color: white;
    }

    .device-type {
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.5);
    }

    .device-status {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.8rem;
    }

    .device-status.online {
        color: #22c55e;
    }

    .online-dot {
        width: 6px;
        height: 6px;
        background: #22c55e;
        border-radius: 50%;
    }

    .devices-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 1rem;
        color: rgba(255, 255, 255, 0.5);
        font-size: 0.875rem;
    }

    .no-devices-hint {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1rem;
        margin-top: 0.5rem;
        background: rgba(234, 179, 8, 0.1);
        border: 1px solid rgba(234, 179, 8, 0.2);
        border-radius: 8px;
        color: #fbbf24;
        font-size: 0.8rem;
    }

    /* Success state */
    .success-message {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1.25rem;
        background: rgba(34, 197, 94, 0.1);
        border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 12px;
        margin-bottom: 1rem;
        text-align: left;
        color: #22c55e;
    }

    .success-text {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .success-title {
        font-weight: 600;
        color: #22c55e;
    }

    .success-subtitle {
        font-size: 0.875rem;
        color: rgba(34, 197, 94, 0.8);
    }

    .join-here-btn {
        width: 100%;
        padding: 0.875rem 2rem;
        background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
        border: none;
        border-radius: 12px;
        font-size: 1rem;
        font-weight: 600;
        color: white;
        cursor: pointer;
        transition: all 0.2s;
        margin-top: 0.5rem;
    }

    .join-here-btn.secondary {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .join-here-btn:hover:not(:disabled) {
        transform: translateY(-1px);
    }

    .join-here-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    /* Error/Joining states */
    .error-message {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 1rem;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 8px;
        color: #fca5a5;
        font-size: 0.875rem;
        margin-bottom: 1rem;
    }

    .joining-status {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        color: rgba(255, 255, 255, 0.7);
    }

    .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(139, 92, 246, 0.2);
        border-top-color: #8b5cf6;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    .spinner.small {
        width: 20px;
        height: 20px;
        border-width: 2px;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .retry-btn {
        width: 100%;
        padding: 0.875rem 2rem;
        background: rgba(139, 92, 246, 0.2);
        border: 1px solid rgba(139, 92, 246, 0.4);
        border-radius: 12px;
        font-size: 1rem;
        font-weight: 500;
        color: #c4b5fd;
        cursor: pointer;
        transition: all 0.2s;
        margin-bottom: 1rem;
    }

    .retry-btn:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.3);
    }

    .retry-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .home-link {
        display: inline-block;
        color: rgba(255, 255, 255, 0.5);
        text-decoration: none;
        font-size: 0.875rem;
        transition: color 0.2s;
    }

    .home-link:hover {
        color: white;
    }
</style>
