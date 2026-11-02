<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    const tips = ['S3E7', 'year:2020-2024', 'rating:>8', 'genre:action', '-horror'];
</script>

<details class="px-4 py-3 text-xs text-surface-300">
    <summary tabindex="0" class="cursor-pointer w-fit py-1">{m.search_tips()}</summary>
    <div class="flex flex-wrap items-center gap-2 pt-3">
        <span>{m.search_tips_try()}:</span>
        {#each tips as tip (tip)}<code class="rounded bg-white/5 px-2 py-1">{tip}</code>{/each}
    </div>
</details>
