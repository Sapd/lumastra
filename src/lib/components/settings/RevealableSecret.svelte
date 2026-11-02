<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Masked display of a stored credential with an explicit reveal + copy.

  The secret is NOT fetched when the surrounding panel opens — `load()` runs
  only on the first reveal, so simply visiting settings never pulls the value
  over the wire. `load()` resolving null means "exists but cannot be shown"
  (e.g. a Jellyfin PIN stored before the encrypted display copy existed); that
  is rendered as `unavailableText`, not as an error.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { Icon, ClipboardDocument, Check, Eye, EyeSlash } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';

    interface Props {
        /**
         * Plaintext already in hand — set right after generating, so the value
         * shows immediately without a round-trip. Read ONCE at mount: callers
         * that can hand over a *new* secret while this is on screen (a reset)
         * must wrap the component in `{#key}` so it remounts, rather than
         * expecting a prop change to propagate.
         */
        initial?: string;
        /** Fetch the secret on demand. Resolve null when it cannot be shown. */
        load: () => Promise<string | null>;
        /** Shown when `load()` resolves null. */
        unavailableText: string;
        /** Width of the masked placeholder, in dots. */
        maskLength?: number;
    }

    let { initial = '', load, unavailableText, maskLength = 9 }: Props = $props();

    // Seeded from `initial` at mount: a just-generated secret is already
    // revealed, since the user explicitly asked for it and hiding it behind
    // another click would be pure friction.
    let value = $state(untrack(() => initial));
    let shown = $state(untrack(() => initial !== ''));
    let loading = $state(false);
    let unavailable = $state(false);
    // Set when a fetch already failed and reported it, so the copy fallback
    // doesn't retry and toast a second time for what was one click.
    let loadFailed = $state(false);
    let copied = $state(false);

    // In-flight fetch, so a rapid double-click joins the existing request rather
    // than firing a second one. `disabled={loading}` alone does not cover this:
    // the second click can land before Svelte's next reactive flush.
    let inFlight: Promise<string | null> | null = null;

    /** Fetch the secret if we don't hold it yet. Null = it cannot be shown. */
    async function ensureValue(): Promise<string | null> {
        if (value) return value;
        if (inFlight) return inFlight;
        inFlight = doLoad();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    }

    async function doLoad(): Promise<string | null> {
        loading = true;
        try {
            const loaded = await load();
            if (!loaded) {
                unavailable = true;
                return null;
            }
            value = loaded;
            return loaded;
        } catch {
            loadFailed = true;
            toasts.error(m.reveal_secret_load_failed());
            return null;
        } finally {
            loading = false;
        }
    }

    async function toggle(): Promise<void> {
        if (shown) {
            shown = false;
            return;
        }
        if (await ensureValue()) shown = true;
    }

    /** Drop the display grouping so the clipboard gets what a client expects. */
    function forClipboard(v: string): string {
        return v.replace(/\s/g, '');
    }

    let copiedTimer: ReturnType<typeof setTimeout> | null = null;

    function markCopied(): void {
        copied = true;
        toasts.success(m.reveal_secret_copied());
        // Revert the checkmark. Without this it stuck for the lifetime of the
        // component, so a later copy gave no feedback that anything happened.
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
            copied = false;
            copiedTimer = null;
        }, 2000);
    }

    /**
     * Copy WITHOUT revealing. This deliberately works while the value is still
     * masked — copying a secret you never put on screen is the safer flow
     * (nothing to shoulder-surf, nothing captured in a screen share), so gating
     * the button on "shown" would remove the better option, not protect anyone.
     */
    async function copy(): Promise<void> {
        if (value) {
            try {
                await navigator.clipboard.writeText(forClipboard(value));
                markCopied();
            } catch {
                toasts.error(m.reveal_secret_copy_failed());
            }
            return;
        }

        // First copy, value not fetched yet. Safari drops clipboard permission
        // across an `await`, so hand the clipboard a PROMISE instead: the write
        // starts synchronously inside the click gesture and settles once the
        // fetch lands. Browsers without promise-valued ClipboardItem fall
        // through to the plain await path below.
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': ensureValue().then((v) => {
                            if (!v) throw new Error('secret unavailable');
                            return new Blob([forClipboard(v)], { type: 'text/plain' });
                        }),
                    }),
                ]);
                markCopied();
                return;
            } catch {
                // The write rejects for two different reasons: the clipboard
                // API refused (retry below on the plain path), or the inner
                // ensureValue() resolved null / threw. In that second case the
                // outcome is already recorded — falling through would refetch
                // and fire a second toast for a single click.
                if (unavailable || loadFailed) return;
            }
        }

        const loaded = await ensureValue();
        if (!loaded) return;
        try {
            await navigator.clipboard.writeText(forClipboard(loaded));
            markCopied();
        } catch {
            toasts.error(m.reveal_secret_copy_failed());
        }
    }
</script>

<div class="bg-surface-900 rounded-lg p-3 mb-3">
    {#if unavailable}
        <p class="text-sm text-surface-400">{unavailableText}</p>
    {:else}
        <div class="flex items-center justify-between gap-2">
            <code
                class="text-lg font-mono tracking-widest text-primary-200 break-all"
                aria-live="polite">
                {#if shown}
                    {value}
                {:else}
                    <span aria-label={m.reveal_secret_hidden()}>{'•'.repeat(maskLength)}</span>
                {/if}
            </code>
            <div class="flex items-center gap-1 shrink-0">
                <button
                    class="btn btn-sm variant-ghost-surface"
                    onclick={toggle}
                    disabled={loading}
                    aria-pressed={shown}
                    title={shown ? m.reveal_secret_hide() : m.reveal_secret_show()}>
                    {#if loading}
                        <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                        ></span>
                    {:else}
                        <Icon src={shown ? EyeSlash : Eye} class="w-4 h-4" />
                    {/if}
                    <span class="sr-only"
                        >{shown ? m.reveal_secret_hide() : m.reveal_secret_show()}</span>
                </button>
                <!-- Always available: copying while masked is the safer flow. -->
                <button
                    class="btn btn-sm {copied ? 'variant-ghost-success' : 'variant-ghost-surface'}"
                    onclick={copy}
                    disabled={loading}
                    title={m.reveal_secret_copy()}>
                    <Icon src={copied ? Check : ClipboardDocument} class="w-4 h-4" />
                    <span class="sr-only">{m.reveal_secret_copy()}</span>
                </button>
            </div>
        </div>
    {/if}
</div>
