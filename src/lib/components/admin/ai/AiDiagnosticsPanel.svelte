<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { z } from 'zod';
    import { Icon, ArrowPath, CheckCircle, XCircle } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';

    const EmbeddingProbeSchema = z.object({
        ok: z.boolean(),
        provider: z.string(),
        model: z.string().optional(),
        dimension: z.number().optional(),
        expected: z.number().optional(),
        matches: z.boolean().optional(),
        error: z.string().optional(),
    });

    const AssistantProbeSchema = z.object({
        ok: z.boolean(),
        provider: z.string(),
        model: z.string().optional(),
        reply: z.string().optional(),
        error: z.string().optional(),
    });

    type EmbeddingProbe = z.infer<typeof EmbeddingProbeSchema>;
    type AssistantProbe = z.infer<typeof AssistantProbeSchema>;

    let embeddingLoading = $state(false);
    let assistantLoading = $state(false);
    let embeddingResult = $state<EmbeddingProbe | null>(null);
    let assistantResult = $state<AssistantProbe | null>(null);
    let embeddingError = $state<string | null>(null);
    let assistantError = $state<string | null>(null);

    /**
     * The headline for a failed probe. A provider that answers with vectors of
     * the wrong width reports ok:true, matches:false and no error, which left
     * the red box with an empty headline over the real cause.
     */
    function embeddingFailure(result: EmbeddingProbe | null, error: string | null): string {
        if (error) return error;
        if (result?.error) return result.error;
        if (result?.matches === false) {
            return `Dimension mismatch: the provider returned ${result.dimension ?? '?'} dimensions, the database expects ${result.expected ?? '?'}`;
        }
        return 'Embedding probe failed.';
    }

    async function testEmbedding(): Promise<void> {
        embeddingLoading = true;
        embeddingError = null;
        const response = await apiGet('/api/admin/ai/embedding-test', EmbeddingProbeSchema, {
            timeout: 25_000,
        });
        embeddingLoading = false;
        if (response.error || !response.data) {
            embeddingError = response.error ?? 'Embedding probe failed.';
            embeddingResult = null;
            return;
        }
        embeddingResult = response.data;
    }

    async function testAssistant(): Promise<void> {
        assistantLoading = true;
        assistantError = null;
        const response = await apiGet('/api/admin/ai/assistant-test', AssistantProbeSchema, {
            timeout: 30_000,
        });
        assistantLoading = false;
        if (response.error || !response.data) {
            assistantError = response.error ?? 'Assistant probe failed.';
            assistantResult = null;
            return;
        }
        assistantResult = response.data;
    }
</script>

<section class="card-bordered p-4 space-y-4">
    <div>
        <h3 class="text-sm font-semibold text-surface-100">AI diagnostics</h3>
        <p class="mt-1 text-xs text-surface-500">
            Tests the saved embedding and assistant provider configuration.
        </p>
    </div>

    <div class="grid gap-3 lg:grid-cols-2">
        <div class="rounded-lg border border-surface-700/60 bg-surface-900/30 p-3">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <p class="text-sm font-medium text-surface-100">Embedding endpoint</p>
                    <p class="mt-1 text-xs text-surface-500">
                        Sends one short embedding request and checks vector width.
                    </p>
                </div>
                <button
                    type="button"
                    class="btn btn-secondary btn-sm inline-flex items-center gap-1"
                    onclick={testEmbedding}
                    disabled={embeddingLoading}>
                    <Icon
                        src={ArrowPath}
                        class="h-4 w-4 {embeddingLoading ? 'animate-spin' : ''}" />
                    <span>Test</span>
                </button>
            </div>
            {#if embeddingError || embeddingResult}
                {@const ok = embeddingResult?.ok === true && embeddingResult.matches !== false}
                <div
                    class="mt-3 rounded border px-3 py-2 text-sm {ok
                        ? 'border-green-800/60 bg-green-950/30 text-green-200'
                        : 'border-red-800/60 bg-red-950/40 text-red-300'}">
                    <div class="flex items-center gap-2 font-medium">
                        <Icon src={ok ? CheckCircle : XCircle} class="h-4 w-4" />
                        {ok
                            ? 'Embedding provider works'
                            : embeddingFailure(embeddingResult, embeddingError)}
                    </div>
                    {#if embeddingResult}
                        <p class="mt-1 text-xs text-surface-300">
                            {embeddingResult.provider}
                            {#if embeddingResult.model}
                                · {embeddingResult.model}{/if}
                            {#if embeddingResult.dimension && embeddingResult.expected}
                                · {embeddingResult.dimension}/{embeddingResult.expected} dimensions
                            {/if}
                        </p>
                    {/if}
                </div>
            {/if}
        </div>

        <div class="rounded-lg border border-surface-700/60 bg-surface-900/30 p-3">
            <div class="flex items-start justify-between gap-3">
                <div>
                    <p class="text-sm font-medium text-surface-100">Assistant chat</p>
                    <p class="mt-1 text-xs text-surface-500">
                        Sends one tiny completion request to the active chat provider.
                    </p>
                </div>
                <button
                    type="button"
                    class="btn btn-secondary btn-sm inline-flex items-center gap-1"
                    onclick={testAssistant}
                    disabled={assistantLoading}>
                    <Icon
                        src={ArrowPath}
                        class="h-4 w-4 {assistantLoading ? 'animate-spin' : ''}" />
                    <span>Test</span>
                </button>
            </div>
            {#if assistantError || assistantResult}
                {@const ok = assistantResult?.ok === true}
                <div
                    class="mt-3 rounded border px-3 py-2 text-sm {ok
                        ? 'border-green-800/60 bg-green-950/30 text-green-200'
                        : 'border-red-800/60 bg-red-950/40 text-red-300'}">
                    <div class="flex items-center gap-2 font-medium">
                        <Icon src={ok ? CheckCircle : XCircle} class="h-4 w-4" />
                        {ok
                            ? 'Assistant provider works'
                            : (assistantError ??
                              assistantResult?.error ??
                              'Assistant probe failed.')}
                    </div>
                    {#if assistantResult}
                        <p class="mt-1 text-xs text-surface-300">
                            {assistantResult.provider}
                            {#if assistantResult.model}
                                · {assistantResult.model}{/if}
                            {#if assistantResult.reply}
                                · Reply: {assistantResult.reply}{/if}
                        </p>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
</section>
