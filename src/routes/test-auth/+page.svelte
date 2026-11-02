<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { apiGet } from '$lib/api/client';
    import * as playbackApi from '$lib/api/playback';
    import { z } from 'zod';

    const TestAuthResponseSchema = z.unknown();

    let testResult = $state('');
    let loading = $state(false);

    async function testAuthScenario(mode: string) {
        loading = true;
        testResult = `Testing ${mode}...`;

        try {
            const { data, error, status } = await apiGet('/api/test-auth', TestAuthResponseSchema, {
                params: { mode },
            });

            if (!error) {
                testResult = `✅ Success: ${JSON.stringify(data)}`;
            } else {
                testResult = `❌ Failed: ${status} ${error}`;
            }
        } catch (error) {
            testResult = `💥 Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            loading = false;
        }
    }

    async function testNormalCall() {
        loading = true;
        testResult = 'Testing normal API call...';

        try {
            const { data, error, status } = await playbackApi.getActiveSessions('mine');

            if (!error && data) {
                const sessions = (data as { sessions?: unknown[] }).sessions;
                const count = Array.isArray(sessions) ? sessions.length : 0;
                testResult = `✅ Sessions loaded: ${count} sessions`;
            } else {
                testResult = `❌ Sessions failed: ${status} ${error}`;
            }
        } catch (error) {
            testResult = `💥 Sessions error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            loading = false;
        }
    }
</script>

<div class="container mx-auto p-8">
    <h1 class="h1 mb-8">Authentication Test Page</h1>

    <div class="card p-6 mb-6">
        <h2 class="h2 mb-4">Test Authentication Scenarios</h2>

        <div class="grid grid-cols-2 gap-4 mb-6">
            <button
                class="btn variant-filled-primary"
                onclick={() => testAuthScenario('success')}
                disabled={loading}>
                Test Normal Success
            </button>

            <button
                class="btn variant-filled-error"
                onclick={() => testAuthScenario('401')}
                disabled={loading}>
                Test 401 Unauthorized
            </button>

            <button
                class="btn variant-filled-error"
                onclick={() => testAuthScenario('403')}
                disabled={loading}>
                Test 403 Forbidden
            </button>

            <button
                class="btn variant-filled-warning"
                onclick={() => testAuthScenario('auth-message')}
                disabled={loading}>
                Test Auth Error Message
            </button>
        </div>

        <button
            class="btn variant-filled-secondary mb-4"
            onclick={testNormalCall}
            disabled={loading}>
            Test Real API Call (/api/sessions)
        </button>

        {#if testResult}
            <div class="card p-4 bg-surface-200 dark:bg-surface-700">
                <h3 class="h3 mb-2">Result:</h3>
                <pre class="whitespace-pre-wrap">{testResult}</pre>
            </div>
        {/if}

        {#if loading}
            <div class="flex items-center gap-2 mt-4">
                <span class="loading-spinner loading-spinner-primary w-4 h-4"></span>
                <span>Loading...</span>
            </div>
        {/if}
    </div>

    <div class="card p-6">
        <h2 class="h2 mb-4">About This Test</h2>
        <p class="mb-4">
            This page tests the authentication handling system. When you click the auth failure
            buttons:
        </p>
        <ol class="list-decimal ml-6 space-y-2">
            <li>
                <strong>401/403 buttons:</strong> Should trigger page reload (simulating redirect to login)
            </li>
            <li>
                <strong>Auth message button:</strong> Should detect auth error in response data
            </li>
            <li>
                <strong>Real API call:</strong> Should work normally in development
            </li>
        </ol>
        <p class="mt-4 text-sm text-surface-500">
            <strong>Note:</strong> The reload behavior will clear this page, simulating what happens when
            auth expires.
        </p>
    </div>
</div>
