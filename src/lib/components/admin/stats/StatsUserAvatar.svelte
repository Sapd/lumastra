<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Small round user avatar for the admin stats leaderboards. The avatar URL is
  emitted for every user with a username; the endpoint 404s when no image exists
  (no custom / Jellyfin / Gravatar avatar), so we fall back to the name initial
  on error instead of leaving an empty circle.
-->
<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        name: string;
        images?: ImageSet;
    }

    let { name, images }: Props = $props();

    let imageFailed = $state(false);
    let avatarUrl = $derived(images?.primary?.variants?.thumb ?? images?.primary?.href);
    let showAvatar = $derived(!!avatarUrl && !imageFailed);
</script>

{#if showAvatar}
    <div class="w-10 h-10 bg-surface-600 rounded-full overflow-hidden shrink-0">
        <img
            src={avatarUrl}
            alt={m.ui_avatar_alt({ username: name })}
            class="w-full h-full object-cover"
            loading="lazy"
            onerror={() => (imageFailed = true)} />
    </div>
{:else}
    <div
        class="w-10 h-10 bg-surface-600 rounded-full center shrink-0"
        role="img"
        aria-label={m.ui_avatar_alt({ username: name || m.admin_unknown_user() })}>
        <span class="text-surface-400 text-lg" aria-hidden="true">{name?.charAt(0) || '?'}</span>
    </div>
{/if}
