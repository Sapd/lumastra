<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import AvatarUploadPopover from '$lib/components/ui/AvatarUploadPopover.svelte';

    interface Props {
        username: string;
        onUpdated?: () => void;
    }
    let { username, onUpdated }: Props = $props();
</script>

<!--
  Re-homed inline (spec: "avatar upload re-homed as an inline Account panel" —
  today an absolute popover in Footer.svelte:1020). AvatarUploadPopover already
  renders just a card body, so we render it directly with no absolute wrapper.
-->
<div class="p-4">
    <AvatarUploadPopover variant="inline" {username} onSuccess={() => onUpdated?.()} />
</div>
