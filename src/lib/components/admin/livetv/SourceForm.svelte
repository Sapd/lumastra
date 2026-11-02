<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        createLiveTvSource,
        updateLiveTvSource,
        validateXtreamCredentialsApi,
        validateHdHomeRunApi,
    } from '$lib/api/livetv';
    import type { LiveTvSourceWithCount } from '$lib/schemas/livetv';
    import { toasts } from '$lib/stores/toast.store';

    interface Props {
        source?: LiveTvSourceWithCount;
        /**
         * Called after a successful save, with the import run when one was started.
         */
        onSaved: (importInfo?: { sourceId: string; runId: string }) => void;
        onCancel: () => void;
    }

    let { source, onSaved, onCancel }: Props = $props();

    type SourceType = 'm3u' | 'xtream' | 'hdhomerun';

    // svelte-ignore state_referenced_locally
    let sourceType = $state<SourceType>(source?.sourceType ?? 'm3u');
    // svelte-ignore state_referenced_locally
    let name = $state(source?.name ?? '');
    let m3uUrl = $state('');
    // Xtream-style links (get.php) without type=m3u_plus return a bare playlist:
    // no tvg-id, tvg-name or group-title. Every channel then has to be matched
    // to the guide by name (slow on a large provider, and less reliable) and no
    // categories come through.
    const suggestM3uPlus = $derived.by(() => {
        try {
            const url = new URL(m3uUrl.trim());
            return /\/get\.php$/i.test(url.pathname) && url.searchParams.get('type') !== 'm3u_plus';
        } catch {
            return false;
        }
    });
    let xmltvUrl = $state('');
    let removeXmltv = $state(false);
    let streamLimitEdited = $state(false);
    let xtreamServer = $state('');
    let xtreamUsername = $state('');
    let xtreamPassword = $state('');
    let hdHomeRunDeviceIp = $state('');
    // svelte-ignore state_referenced_locally
    let maxStreams = $state(source?.maxStreams ?? 1);
    let saving = $state(false);
    let testingCredentials = $state(false);
    let credentialTestResult = $state<{
        valid: boolean;
        message: string;
    } | null>(null);
    let errors = $state<Record<string, string>>({});

    const isEditing = $derived(source !== undefined);

    function showError(message: string): void {
        toasts.error(redactLiveTvUrlsInText(message));
    }

    function validate(): boolean {
        const next: Record<string, string> = {};

        if (!name.trim()) {
            next['name'] = 'Name is required';
        }

        if (!isEditing) {
            if (sourceType === 'm3u') {
                if (!m3uUrl.trim()) {
                    next['m3uUrl'] = 'M3U URL is required';
                } else {
                    try {
                        new URL(m3uUrl);
                    } catch {
                        next['m3uUrl'] = 'Must be a valid URL';
                    }
                }
                if (xmltvUrl.trim()) {
                    try {
                        new URL(xmltvUrl);
                    } catch {
                        next['xmltvUrl'] = 'Must be a valid URL';
                    }
                }
            } else if (sourceType === 'xtream') {
                if (!xtreamServer.trim()) {
                    next['xtreamServer'] = 'Server URL is required';
                } else {
                    try {
                        new URL(xtreamServer);
                    } catch {
                        next['xtreamServer'] = 'Must be a valid URL';
                    }
                }
                if (!xtreamUsername.trim()) {
                    next['xtreamUsername'] = 'Username is required';
                }
                if (!xtreamPassword.trim()) {
                    next['xtreamPassword'] = 'Password is required';
                }
            } else if (sourceType === 'hdhomerun') {
                if (!hdHomeRunDeviceIp.trim()) {
                    next['hdHomeRunDeviceIp'] = 'Device IP is required';
                }
            }
        }

        if (maxStreams < 1) {
            next['maxStreams'] = 'Must be at least 1';
        }

        errors = next;
        return Object.keys(next).length === 0;
    }

    async function handleTestCredentials(): Promise<void> {
        if (!xtreamServer.trim() || !xtreamUsername.trim() || !xtreamPassword.trim()) {
            credentialTestResult = {
                valid: false,
                message: 'All Xtream fields are required',
            };
            return;
        }
        testingCredentials = true;
        credentialTestResult = null;
        try {
            const apiResult = await validateXtreamCredentialsApi({
                serverUrl: xtreamServer.trim(),
                username: xtreamUsername.trim(),
                password: xtreamPassword.trim(),
            });
            if (apiResult.data) {
                if (apiResult.data.valid) {
                    const providerLimit = apiResult.data.serverInfo?.maxConnections;
                    if (
                        providerLimit !== undefined &&
                        Number.isSafeInteger(providerLimit) &&
                        providerLimit > 0
                    ) {
                        maxStreams = providerLimit;
                    }
                    credentialTestResult = {
                        valid: true,
                        message: `Connected successfully${apiResult.data.serverInfo?.serverName ? ` — ${apiResult.data.serverInfo.serverName}` : ''}`,
                    };
                } else {
                    credentialTestResult = {
                        valid: false,
                        message: apiResult.data.reason ?? 'Validation failed',
                    };
                }
            } else {
                credentialTestResult = {
                    valid: false,
                    message: apiResult.error ?? 'Connection test failed',
                };
            }
        } catch {
            credentialTestResult = {
                valid: false,
                message: 'Connection test failed',
            };
        } finally {
            testingCredentials = false;
        }
    }

    async function handleTestHdHomeRun(): Promise<void> {
        if (!hdHomeRunDeviceIp.trim()) {
            credentialTestResult = {
                valid: false,
                message: 'Device IP is required',
            };
            return;
        }
        testingCredentials = true;
        credentialTestResult = null;
        try {
            const apiResult = await validateHdHomeRunApi({
                deviceIp: hdHomeRunDeviceIp.trim(),
            });
            if (apiResult.data) {
                if (apiResult.data.valid) {
                    const info = apiResult.data.deviceInfo;
                    credentialTestResult = {
                        valid: true,
                        message: `Found ${info?.friendlyName ?? 'HDHomeRun'}${info?.tunerCount ? ` — ${info.tunerCount} tuner${info.tunerCount > 1 ? 's' : ''}` : ''}`,
                    };
                    // Auto-fill max streams from tuner count
                    if (info?.tunerCount && info.tunerCount > 0) {
                        maxStreams = info.tunerCount;
                    }
                } else {
                    credentialTestResult = {
                        valid: false,
                        message: apiResult.data.reason ?? 'Device not found',
                    };
                }
            } else {
                credentialTestResult = {
                    valid: false,
                    message: apiResult.error ?? 'Connection test failed',
                };
            }
        } catch {
            credentialTestResult = {
                valid: false,
                message: 'Connection test failed',
            };
        } finally {
            testingCredentials = false;
        }
    }

    async function handleSubmit(e: SubmitEvent): Promise<void> {
        e.preventDefault();
        if (!validate()) return;

        saving = true;

        try {
            if (isEditing && source) {
                const result = await updateLiveTvSource(source.id, {
                    name: name.trim(),
                    m3uUrl: m3uUrl.trim() || undefined,
                    xmltvUrl: removeXmltv ? '' : xmltvUrl.trim() || undefined,
                    hdHomeRunDeviceIp: hdHomeRunDeviceIp.trim() || undefined,
                    xtreamServer: xtreamServer.trim() || undefined,
                    xtreamUsername: xtreamUsername.trim() || undefined,
                    xtreamPassword: xtreamPassword.trim() || undefined,
                    maxStreams,
                });
                if (result.data) {
                    if (result.data.importError) showError(result.data.importError);
                    else toasts.success(m.livetv_admin_update_success());
                    const runId = result.data.taskIds?.m3u ?? result.data.taskIds?.epg;
                    onSaved(runId ? { sourceId: source.id, runId } : undefined);
                } else {
                    showError(result.error ?? m.livetv_admin_update_failed());
                }
            } else {
                const baseFields = {
                    name: name.trim(),
                    sourceType,
                    maxStreams: sourceType === 'm3u' || streamLimitEdited ? maxStreams : undefined,
                };

                const createData =
                    sourceType === 'm3u'
                        ? {
                              ...baseFields,
                              m3uUrl: m3uUrl.trim(),
                              xmltvUrl: xmltvUrl.trim() || undefined,
                          }
                        : sourceType === 'xtream'
                          ? {
                                ...baseFields,
                                xtreamServer: xtreamServer.trim(),
                                xtreamUsername: xtreamUsername.trim(),
                                xtreamPassword: xtreamPassword.trim(),
                            }
                          : {
                                ...baseFields,
                                hdHomeRunDeviceIp: hdHomeRunDeviceIp.trim(),
                            };
                const result = await createLiveTvSource(createData);
                if (result.data) {
                    if (result.data.importError) showError(result.data.importError);
                    else toasts.success(m.livetv_admin_create_success());
                    const runId = result.data.taskIds?.m3u;
                    onSaved(runId ? { sourceId: result.data.source.id, runId } : undefined);
                } else {
                    showError(result.error ?? m.livetv_admin_create_failed());
                }
            }
        } catch {
            showError(isEditing ? m.livetv_admin_update_failed() : m.livetv_admin_create_failed());
        } finally {
            saving = false;
        }
    }
</script>

<form method="post" onsubmit={handleSubmit} class="space-y-5">
    <!-- Source type toggle (create only) -->
    {#if !isEditing}
        <div>
            <p id="source-type-label" class="block text-sm font-medium text-surface-300 mb-2">
                {m.livetv_admin_source_type()}
            </p>
            <div class="flex gap-2" role="group" aria-labelledby="source-type-label">
                <button
                    type="button"
                    class="px-4 py-2 rounded text-sm font-medium transition-colors {sourceType ===
                    'm3u'
                        ? 'bg-yellow-500 text-surface-900'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => {
                        sourceType = 'm3u';
                        credentialTestResult = null;
                    }}>
                    {m.livetv_admin_source_type_m3u()}
                </button>
                <button
                    type="button"
                    class="px-4 py-2 rounded text-sm font-medium transition-colors {sourceType ===
                    'xtream'
                        ? 'bg-yellow-500 text-surface-900'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => {
                        sourceType = 'xtream';
                        credentialTestResult = null;
                    }}>
                    {m.livetv_admin_source_type_xtream()}
                    <span
                        class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-900/50 text-orange-300"
                        >UNTESTED</span>
                </button>
                <button
                    type="button"
                    class="px-4 py-2 rounded text-sm font-medium transition-colors {sourceType ===
                    'hdhomerun'
                        ? 'bg-yellow-500 text-surface-900'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => {
                        sourceType = 'hdhomerun';
                        credentialTestResult = null;
                    }}>
                    HDHomeRun
                    <span
                        class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-900/50 text-orange-300"
                        >UNTESTED</span>
                </button>
            </div>
        </div>
    {/if}

    <!-- Name -->
    <div>
        <label for="source-name" class="block text-sm font-medium text-surface-300 mb-1">
            {m.livetv_admin_source_name()} <span class="text-red-400">*</span>
        </label>
        <input
            id="source-name"
            type="text"
            class="w-full bg-surface-700 border {errors['name']
                ? 'border-red-500'
                : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
            placeholder="My IPTV Provider"
            bind:value={name} />
        {#if errors['name']}
            <p class="mt-1 text-xs text-red-400">{errors['name']}</p>
        {/if}
    </div>

    <!-- M3U fields -->
    {#if sourceType === 'm3u'}
        <div>
            <label for="m3u-url" class="block text-sm font-medium text-surface-300 mb-1">
                {m.livetv_admin_source_m3u_url()}
                {#if !isEditing}<span class="text-red-400">*</span>{/if}
            </label>
            <input
                id="m3u-url"
                type="url"
                class="w-full bg-surface-700 border {errors['m3uUrl']
                    ? 'border-red-500'
                    : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                placeholder={isEditing
                    ? 'Leave blank to keep existing URL'
                    : 'http://provider.example.com/get.php?username=...&type=m3u_plus'}
                bind:value={m3uUrl} />
            {#if isEditing && !m3uUrl.trim()}
                <p class="mt-1 text-xs text-surface-500">Leave blank to keep the current URL</p>
            {/if}
            {#if suggestM3uPlus}
                <p class="mt-1 text-xs text-yellow-400">{m.livetv_admin_m3u_plus_hint()}</p>
            {/if}
            {#if errors['m3uUrl']}
                <p class="mt-1 text-xs text-red-400">{errors['m3uUrl']}</p>
            {/if}
        </div>

        <div>
            <label for="xmltv-url" class="block text-sm font-medium text-surface-300 mb-1">
                {m.livetv_admin_source_xmltv_url()}
                <span class="text-surface-500 font-normal"
                    >({m.livetv_admin_source_xmltv_optional()})</span>
            </label>
            <input
                id="xmltv-url"
                disabled={removeXmltv}
                type="url"
                class="w-full bg-surface-700 border {errors['xmltvUrl']
                    ? 'border-red-500'
                    : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                placeholder={isEditing
                    ? 'Leave blank to keep existing URL'
                    : 'http://provider.example.com/epg.xml'}
                bind:value={xmltvUrl} />
            {#if isEditing && !xmltvUrl.trim()}
                <p class="mt-1 text-xs text-surface-500">Leave blank to keep the current URL</p>
            {/if}
            {#if errors['xmltvUrl']}
                <p class="mt-1 text-xs text-red-400">{errors['xmltvUrl']}</p>
            {/if}
        </div>
    {:else if sourceType === 'xtream'}
        <div>
            <label for="xtream-server" class="block text-sm font-medium text-surface-300 mb-1">
                {m.livetv_admin_source_xtream_server()}
                {#if !isEditing}<span class="text-red-400">*</span>{/if}
            </label>
            <input
                id="xtream-server"
                type="url"
                class="w-full bg-surface-700 border {errors['xtreamServer']
                    ? 'border-red-500'
                    : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                placeholder={isEditing
                    ? 'Leave blank to keep existing'
                    : 'http://provider.example.com'}
                bind:value={xtreamServer} />
            {#if isEditing && !xtreamServer.trim()}
                <p class="mt-1 text-xs text-surface-500">Leave blank to keep the current server</p>
            {/if}
            {#if errors['xtreamServer']}
                <p class="mt-1 text-xs text-red-400">
                    {errors['xtreamServer']}
                </p>
            {/if}
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
                <label
                    for="xtream-username"
                    class="block text-sm font-medium text-surface-300 mb-1">
                    {m.livetv_admin_source_xtream_username()}
                    {#if !isEditing}<span class="text-red-400">*</span>{/if}
                </label>
                <input
                    id="xtream-username"
                    type="text"
                    autocomplete="username"
                    class="w-full bg-surface-700 border {errors['xtreamUsername']
                        ? 'border-red-500'
                        : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                    placeholder={isEditing ? 'Leave blank to keep existing' : 'username'}
                    bind:value={xtreamUsername} />
                {#if errors['xtreamUsername']}
                    <p class="mt-1 text-xs text-red-400">
                        {errors['xtreamUsername']}
                    </p>
                {/if}
            </div>

            <div>
                <label
                    for="xtream-password"
                    class="block text-sm font-medium text-surface-300 mb-1">
                    {m.livetv_admin_source_xtream_password()}
                    {#if !isEditing}<span class="text-red-400">*</span>{/if}
                </label>
                <input
                    id="xtream-password"
                    type="password"
                    autocomplete="current-password"
                    class="w-full bg-surface-700 border {errors['xtreamPassword']
                        ? 'border-red-500'
                        : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                    placeholder={isEditing ? 'Leave blank to keep existing' : 'password'}
                    bind:value={xtreamPassword} />
                {#if errors['xtreamPassword']}
                    <p class="mt-1 text-xs text-red-400">
                        {errors['xtreamPassword']}
                    </p>
                {/if}
            </div>
        </div>

        <!-- Test Credentials button -->
        <div>
            <button
                type="button"
                class="btn btn-sm bg-surface-700 hover:bg-surface-600 text-surface-300 font-medium"
                disabled={testingCredentials ||
                    !xtreamServer.trim() ||
                    !xtreamUsername.trim() ||
                    !xtreamPassword.trim()}
                onclick={() => void handleTestCredentials()}>
                {testingCredentials ? 'Testing...' : 'Test Credentials'}
            </button>
            {#if credentialTestResult}
                <p
                    class="mt-2 text-sm {credentialTestResult.valid
                        ? 'text-green-400'
                        : 'text-red-400'}">
                    {redactLiveTvUrlsInText(credentialTestResult.message)}
                </p>
            {/if}
        </div>

        <!-- HDHomeRun fields -->
    {:else if sourceType === 'hdhomerun'}
        <div>
            <label for="hdhomerun-ip" class="block text-sm font-medium text-surface-300 mb-1">
                Device IP Address
                {#if !isEditing}<span class="text-red-400">*</span>{/if}
            </label>
            <input
                id="hdhomerun-ip"
                type="text"
                class="w-full bg-surface-700 border {errors['hdHomeRunDeviceIp']
                    ? 'border-red-500'
                    : 'border-surface-600'} rounded px-3 py-2 text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500"
                placeholder={isEditing ? 'Leave blank to keep existing' : '192.168.1.50'}
                bind:value={hdHomeRunDeviceIp} />
            {#if isEditing && !hdHomeRunDeviceIp.trim()}
                <p class="mt-1 text-xs text-surface-500">
                    Leave blank to keep the current device IP
                </p>
            {/if}
            {#if errors['hdHomeRunDeviceIp']}
                <p class="mt-1 text-xs text-red-400">
                    {errors['hdHomeRunDeviceIp']}
                </p>
            {/if}
        </div>

        <div>
            <button
                type="button"
                class="btn btn-sm bg-surface-700 hover:bg-surface-600 text-surface-300 font-medium"
                disabled={testingCredentials || !hdHomeRunDeviceIp.trim()}
                onclick={() => void handleTestHdHomeRun()}>
                {testingCredentials ? 'Discovering...' : 'Test Connection'}
            </button>
            {#if credentialTestResult}
                <p
                    class="mt-2 text-sm {credentialTestResult.valid
                        ? 'text-green-400'
                        : 'text-red-400'}">
                    {redactLiveTvUrlsInText(credentialTestResult.message)}
                </p>
            {/if}
        </div>
    {/if}

    {#if isEditing}
        <label class="flex items-center gap-2 text-sm text-surface-300">
            <input type="checkbox" bind:checked={removeXmltv} />
            {m.livetv_admin_remove_xmltv()}
        </label>
    {/if}

    <!-- Max Streams -->
    <div>
        <label for="max-streams" class="block text-sm font-medium text-surface-300 mb-1">
            {m.livetv_admin_source_max_streams()}
        </label>
        <input
            id="max-streams"
            oninput={() => {
                streamLimitEdited = true;
            }}
            type="number"
            min="1"
            class="w-32 bg-surface-700 border {errors['maxStreams']
                ? 'border-red-500'
                : 'border-surface-600'} rounded px-3 py-2 text-white focus:outline-none focus:border-yellow-500"
            bind:value={maxStreams} />
        <p class="mt-1 text-xs text-surface-500">
            {m.livetv_admin_source_max_streams_hint()}
        </p>
        {#if errors['maxStreams']}
            <p class="mt-1 text-xs text-red-400">{errors['maxStreams']}</p>
        {/if}
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-3 pt-2">
        <button
            type="submit"
            class="btn bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium"
            disabled={saving}>
            {saving
                ? m.livetv_admin_saving()
                : isEditing
                  ? m.livetv_admin_save_changes()
                  : m.livetv_admin_create_source()}
        </button>
        <button type="button" class="btn btn-ghost" disabled={saving} onclick={onCancel}>
            Cancel
        </button>
    </div>
</form>
