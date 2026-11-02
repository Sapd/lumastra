<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Search installed subtitle providers for one file, and install a result as a
  sidecar next to the video.

  This is the surface `defineSubtitleProvider` was missing. The contract, its
  ranking service, its tests and finally `GET|POST /api/admin/subtitles` all
  shipped with nothing calling them, so an operator could install a subtitle
  provider, watch it register cleanly, and never make it do anything.

  Three things it deliberately does NOT do:

  1. It does not re-sort. The host ranks candidates — viewer language first,
     hash match second — and re-sorting here would silently override a decision
     made where the language preferences actually live.
  2. It does not treat "no providers" as "no results". The endpoint returns a
     `providers` count precisely so those two can be told apart: one means
     install a provider plugin, the other means this release genuinely has no
     subtitles. Collapsing them sends operators hunting for a broken plugin
     that was never installed.
  3. It does not hide WHY a candidate ranked where it did. `hashMatch` is the
     difference between subtitles that stay in sync and subtitles that drift,
     so it is labelled rather than folded into an opaque ordering.
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { searchSubtitles, installSubtitle } from '$lib/api/admin.js';
    import type { SubtitleSearchResponse } from '$lib/schemas/api-admin-responses.js';

    interface Props {
        mediaItemId: string;
        /** The file a sidecar would land next to. Absent → nothing to install onto. */
        fileId: string | null;
        /** Re-read the file's stream list after an install lands. */
        onchanged?: () => void;
    }

    let { mediaItemId, fileId, onchanged }: Props = $props();

    let open = $state(false);
    let languages = $state('en');
    let searching = $state(false);
    let result = $state<SubtitleSearchResponse | null>(null);
    let installingId = $state<string | null>(null);

    let canSearch = $derived(languages.trim().length > 0 && !searching);

    async function search(): Promise<void> {
        if (!canSearch) return;
        searching = true;
        result = null;
        const langs = languages
            .split(',')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 10);
        const { data, error } = await searchSubtitles(mediaItemId, langs);
        searching = false;
        if (error || !data) {
            toasts.error(error ?? m.admin_subtitles_search_failed());
            return;
        }
        result = data;
    }

    async function install(c: SubtitleSearchResponse['candidates'][number]): Promise<void> {
        if (!fileId || installingId) return;
        installingId = c.id;
        const { data, error } = await installSubtitle({
            mediaItemId,
            fileId,
            providerId: c.providerId,
            candidateId: c.id,
            language: c.language,
            ...(c.isForced === true ? { isForced: true } : {}),
            ...(c.isSDH === true ? { isSDH: true } : {}),
        });
        installingId = null;
        if (error || !data) {
            // The endpoint returns an operator-readable reason on every failure
            // path on purpose; surfacing it beats a generic failure toast.
            toasts.error(error ?? m.admin_subtitles_install_failed());
            return;
        }
        toasts.success(m.admin_subtitles_installed({ language: data.language }));
        onchanged?.();
    }
</script>

<div class="rounded-lg border border-surface-700/50 p-3 space-y-3">
    <button
        type="button"
        class="btn-secondary text-sm"
        aria-expanded={open}
        onclick={() => (open = !open)}>
        {m.admin_subtitles_toggle()}
    </button>

    {#if open}
        <div class="flex flex-wrap items-end gap-2">
            <label class="block">
                <span class="text-xs text-surface-400">{m.admin_subtitles_languages_label()}</span>
                <input
                    type="text"
                    class="input mt-1 w-48 text-sm"
                    bind:value={languages}
                    placeholder="en, de" />
            </label>
            <button
                type="button"
                class="btn-primary text-sm"
                disabled={!canSearch}
                onclick={() => void search()}>
                {searching ? m.admin_subtitles_searching() : m.admin_subtitles_search()}
            </button>
        </div>

        {#if result}
            {#if result.providers === 0}
                <!-- Nobody to ask. Not the same as asking and finding nothing. -->
                <p class="text-hint">{m.admin_subtitles_no_providers()}</p>
            {:else if result.candidates.length === 0}
                <p class="text-hint">
                    {m.admin_subtitles_no_results({ providers: String(result.providers) })}
                </p>
            {:else}
                <ul class="divide-y divide-surface-700/50">
                    {#each result.candidates as c (c.providerId + ':' + c.id)}
                        <li class="flex items-center justify-between gap-3 py-2">
                            <div class="min-w-0">
                                <p class="truncate text-sm text-surface-100">
                                    {c.releaseName ?? m.admin_subtitles_untitled_release()}
                                </p>
                                <p class="text-xs text-surface-400">
                                    {c.language.toUpperCase()} · {c.format.toUpperCase()} · {c.providerId}
                                    {#if c.hashMatch}
                                        · <span class="text-emerald-300"
                                            >{m.admin_subtitles_hash_match()}</span>
                                    {/if}
                                    {#if c.isForced}· {m.admin_subtitles_forced()}{/if}
                                    {#if c.isSDH}· {m.admin_subtitles_sdh()}{/if}
                                </p>
                            </div>
                            <button
                                type="button"
                                class="btn-secondary text-xs shrink-0"
                                disabled={!fileId || installingId !== null}
                                title={fileId ? undefined : m.admin_subtitles_needs_file()}
                                onclick={() => void install(c)}>
                                {installingId === c.id
                                    ? m.admin_subtitles_installing()
                                    : m.admin_subtitles_install()}
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        {/if}
    {/if}
</div>
