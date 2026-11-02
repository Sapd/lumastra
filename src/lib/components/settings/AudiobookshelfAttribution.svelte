<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import audiobookshelfLogo from '$lib/assets/providers/audiobookshelf-full.svg';
    import * as m from '$lib/paraglide/messages';
</script>

<a
    href="https://www.audiobookshelf.org/"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex flex-col items-start gap-1 text-xs text-surface-300 underline decoration-surface-500 underline-offset-2 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-400">
    <span>{m.settings_about_audiobookshelf_attribution()}</span>
    <img src={audiobookshelfLogo} alt="" width="288" height="48" class="h-auto w-72 max-w-full" />
</a>
