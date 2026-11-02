<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';

    // Shell text, not translated: the exact command for the Docker image.
    const unlockCommand =
        'docker exec -it <container> sh -c \'NODE_OPTIONS="--import ./scripts/register-lua.mjs" node_modules/.bin/tsx --tsconfig tsconfig.scripts.json scripts/setup-unlock.ts\'';
</script>

<svelte:head>
    <title>{m.setup_locked_page_title()}</title>
</svelte:head>

<main class="locked-shell">
    <section class="locked-card card" aria-labelledby="setup-locked-heading">
        <h1 id="setup-locked-heading" class="locked-title">{m.setup_locked_heading()}</h1>
        <p>{m.setup_locked_intro()}</p>
        <p>{m.setup_locked_cause()}</p>

        <h2 class="locked-subtitle">{m.setup_locked_idp_title()}</h2>
        <p>{m.setup_locked_idp_text()}</p>

        <h2 class="locked-subtitle">{m.setup_locked_unlock_title()}</h2>
        <p>{m.setup_locked_unlock_text()}</p>
        <pre class="locked-code"><code>{unlockCommand}</code></pre>
        <p>{m.setup_locked_unlock_after()}</p>
    </section>
</main>

<style>
    .locked-shell {
        display: flex;
        min-height: 100dvh;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: rgb(var(--color-surface-900-rgb));
    }

    .locked-card {
        display: flex;
        width: 100%;
        max-width: 40rem;
        flex-direction: column;
        gap: 0.75rem;
        padding: 2rem;
        border-radius: 1.25rem;
        background: rgb(var(--color-surface-800-rgb) / 0.95);
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.45);
        line-height: 1.55;
    }

    .locked-title {
        font-size: 1.5rem;
        font-weight: 600;
    }

    .locked-subtitle {
        margin-top: 0.75rem;
        font-size: 1.1rem;
        font-weight: 600;
    }

    .locked-code {
        overflow-x: auto;
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        background: rgb(0 0 0 / 0.4);
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-break: break-all;
    }
</style>
