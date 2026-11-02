<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { formatIssue } from '$lib/utils/admin/playback-formatters';

    interface Props {
        issue: string;
    }

    let { issue }: Props = $props();

    let formatted = $derived(formatIssue(issue));
    let badgeClasses = $derived(
        formatted.isRootCause
            ? 'bg-red-500/20 border-red-500/30 text-red-400'
            : 'bg-orange-500/20 border-orange-500/30 text-orange-400',
    );
</script>

<span class="px-2 py-1 rounded-full text-xs border {badgeClasses}">
    {formatted.label}
</span>
