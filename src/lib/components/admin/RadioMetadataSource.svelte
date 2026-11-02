<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Now-playing source editor for a radio station. Controlled by the station
  form: every edit reports the current source through `onChange`, and the
  form's own Create/Update button saves it. An empty metadata URL means "no
  source" (ICY fallback). Works before the station exists — detect and
  preview are station-less.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { apiPost } from '$lib/api/client.js';
    import { z } from 'zod';
    import {
        RadioMetadataSourceSchema,
        RadioNowPlayingSchema,
        CANONICAL_FIELD_IDS,
        type RadioMetadataSource,
        type CanonicalFieldId,
    } from '$lib/schemas/radio';
    import { toasts } from '$lib/stores/toast.store';
    import type { RadioMetadataSourceChange } from './radio-metadata-source';
    import * as m from '$lib/paraglide/messages.js';

    type Props = {
        /** The station's stream URL, used for the ICY fallback in the preview. */
        streamUrl: string;
        value: RadioMetadataSource | undefined;
        onChange: (change: RadioMetadataSourceChange) => void;
    };
    let { streamUrl, value, onChange }: Props = $props();

    // Copy prop values into local editable state — intentionally read only the
    // initial value; the parent remounts this component per station.
    let url = $state(untrack(() => value?.url ?? ''));
    let format = $state<RadioMetadataSource['format']>(untrack(() => value?.format ?? 'json'));
    let jsonPaths = $state<Partial<Record<CanonicalFieldId, string>>>(
        untrack(() => ({ ...(value?.jsonPaths ?? {}) })),
    );
    let regexPattern = $state(untrack(() => value?.regexPattern ?? ''));
    // Keep fields the editor does not show (timeoutMs, userAgent) on save.
    const extra = untrack(() => ({
        ...(value?.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
        ...(value?.userAgent !== undefined ? { userAgent: value.userAgent } : {}),
    }));

    let detecting = $state(false);
    let detected = $state<{
        allLeafPaths: string[];
        confidence: Partial<Record<CanonicalFieldId, number>>;
    } | null>(null);
    type Preview = z.infer<typeof RadioNowPlayingSchema>;
    let preview = $state<Preview | null>(null);
    let previewError = $state<string | null>(null);
    /** Only the newest preview request may write the result. */
    let previewSeq = 0;
    let incomplete = $state(false);

    const DetectResponseSchema = z
        .object({
            format: z.enum(['json', 'regex']),
            contentType: z.string(),
            rawResponse: z.unknown().optional(),
            proposedPaths: z.record(z.string(), z.string()).optional(),
            detectionConfidence: z.record(z.string(), z.number()).optional(),
            allLeafPaths: z.array(z.string()).optional(),
        })
        .strict();

    /** Detected paths plus any already-mapped path, so a saved mapping still shows. */
    const pathOptions = $derived.by(() => {
        const all = [
            ...(detected?.allLeafPaths ?? []),
            ...Object.values(jsonPaths).filter((p): p is string => Boolean(p)),
        ];
        return all.filter((p, i) => all.indexOf(p) === i);
    });

    function currentSource(): RadioMetadataSource {
        const paths = Object.fromEntries(
            Object.entries(jsonPaths).filter(([, p]) => Boolean(p)),
        ) as Partial<Record<CanonicalFieldId, string>>;
        return {
            url: url.trim(),
            format,
            ...(format === 'json' ? { jsonPaths: paths } : {}),
            ...(format === 'regex' ? { regexPattern } : {}),
            ...extra,
        };
    }

    async function runDetect(): Promise<void> {
        if (!url.trim()) {
            toasts.error(m.admin_radio_metadata_url_needed());
            return;
        }
        detecting = true;
        const { data, error } = await apiPost(
            '/api/admin/radio/metadata/detect',
            DetectResponseSchema,
            { url: url.trim(), format },
        );
        detecting = false;
        if (error) {
            toasts.error(error);
            return;
        }
        if (data?.format === 'json' && data.proposedPaths) {
            jsonPaths = { ...data.proposedPaths } as Partial<Record<CanonicalFieldId, string>>;
            detected = {
                allLeafPaths: data.allLeafPaths ?? [],
                confidence: (data.detectionConfidence ?? {}) as Partial<
                    Record<CanonicalFieldId, number>
                >,
            };
        } else {
            detected = null;
        }
        await runPreview();
    }

    /** The parsed source when it is complete enough to fetch anything with. */
    function completeSource(source: RadioMetadataSource): RadioMetadataSource | null {
        const parse = RadioMetadataSourceSchema.safeParse(source);
        if (!parse.success) return null;
        const src = parse.data;
        if (src.format === 'regex' && !src.regexPattern?.trim()) return null;
        if (src.format === 'json' && Object.keys(src.jsonPaths ?? {}).length === 0) return null;
        return src;
    }

    async function runPreview(): Promise<void> {
        const seq = ++previewSeq;
        const source = completeSource(currentSource());
        if (!source) {
            preview = null;
            previewError = null;
            return;
        }
        const stream = streamUrl.trim();
        const { data, error } = await apiPost(
            '/api/admin/radio/metadata/preview',
            RadioNowPlayingSchema,
            {
                metadataSource: source,
                ...(URL.canParse(stream) ? { streamUrl: stream } : {}),
            },
        );
        if (seq !== previewSeq) return;
        if (error) {
            previewError = error;
            preview = null;
        } else {
            preview = data ?? null;
            previewError = null;
        }
    }

    const initialSnapshot = untrack(() => JSON.stringify(currentSource()));

    // Report every edit to the form, and refresh the preview (debounced).
    $effect(() => {
        // Read everything deeply so mapping edits (and the stream URL used
        // for the ICY fallback) are tracked.
        void JSON.stringify([url, format, jsonPaths, regexPattern, streamUrl]);
        untrack(() => {
            const source = currentSource();
            const dirty = JSON.stringify(source) !== initialSnapshot;
            const complete = source.url ? completeSource(source) : null;
            incomplete = Boolean(source.url) && !complete;
            onChange({ source: complete, valid: !incomplete, dirty });
        });
        const timer = setTimeout(() => void runPreview(), 400);
        return () => clearTimeout(timer);
    });

    // Detected paths belong to one endpoint and format; drop them on change.
    $effect(() => {
        void url;
        void format;
        untrack(() => {
            if (detected && !detecting) detected = null;
        });
    });
</script>

<div data-radio-metadata-source class="space-y-3">
    <p class="text-xs text-surface-400">{m.admin_radio_now_playing_hint()}</p>

    <div>
        <label class="block text-sm" for="radio-metadata-url">
            <span class="text-surface-300">{m.admin_radio_metadata_url()}</span>
        </label>
        <input
            id="radio-metadata-url"
            type="url"
            class="mt-1 w-full rounded bg-surface-900 px-3 py-2 text-white border border-surface-700 focus:border-primary-500 focus:outline-none"
            bind:value={url}
            placeholder="https://example.com/nowplaying.json" />
    </div>

    <div class="flex items-center gap-3">
        <label class="text-xs">
            <input type="radio" bind:group={format} value="json" /> JSON
        </label>
        <label class="text-xs">
            <input type="radio" bind:group={format} value="regex" /> Regex
        </label>
        <button
            type="button"
            class="ml-auto rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-white hover:bg-surface-600 disabled:opacity-50"
            onclick={runDetect}
            disabled={detecting || !url.trim()}>
            {detecting ? m.admin_radio_detecting() : m.admin_radio_detect_fields()}
        </button>
    </div>

    {#if incomplete}
        <p class="text-xs text-warning-400" data-radio-metadata-incomplete>
            {m.admin_radio_metadata_invalid()}
        </p>
    {/if}

    {#if url.trim()}
        {#if format === 'json'}
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div class="space-y-1">
                    {#each CANONICAL_FIELD_IDS as field (field)}
                        <label class="flex items-center gap-2 text-xs">
                            <span class="w-40 truncate text-surface-300">{field}</span>
                            <select
                                class="flex-1 rounded bg-surface-900 px-2 py-1 text-white border border-surface-700"
                                bind:value={jsonPaths[field]}>
                                <option value={undefined}>{m.admin_radio_field_none()}</option>
                                {#each pathOptions as path (path)}
                                    <option value={path}>{path}</option>
                                {/each}
                            </select>
                            {#if (detected?.confidence[field] ?? 1) < 0.5 && jsonPaths[field]}
                                <span class="text-yellow-500" title={m.admin_radio_low_confidence()}
                                    >⚠</span>
                            {/if}
                        </label>
                    {/each}
                </div>
                {@render previewBlock()}
            </div>
        {:else}
            <div>
                <label class="block text-xs font-medium" for="radio-metadata-regex">
                    {m.admin_radio_regex_label()}
                </label>
                <textarea
                    id="radio-metadata-regex"
                    class="mt-1 w-full rounded bg-surface-900 px-3 py-2 font-mono text-xs text-white border border-surface-700"
                    rows="4"
                    bind:value={regexPattern}
                    placeholder="Artist:\s+(?<artist>.+)\nTitle:\s+(?<title>.+)"></textarea>
                <div class="mt-2">{@render previewBlock()}</div>
            </div>
        {/if}
    {/if}
</div>

{#snippet previewBlock()}
    <div>
        <h4 class="text-xs font-medium text-surface-300">{m.admin_radio_preview()}</h4>
        {#if previewError}
            <p class="text-xs text-red-500">{previewError}</p>
        {:else if preview}
            <pre class="whitespace-pre-wrap break-words text-xs">{JSON.stringify(
                    preview,
                    null,
                    2,
                )}</pre>
        {:else}
            <p class="text-xs text-surface-500">{m.admin_radio_no_preview()}</p>
        {/if}
    </div>
{/snippet}
