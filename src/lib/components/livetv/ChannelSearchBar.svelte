<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import SearchInput from '$lib/components/ui/SearchInput.svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        value?: string;
        onquery: (query: string) => void;
    }

    let { value = $bindable(''), onquery }: Props = $props();
</script>

<SearchInput
    bind:value
    placeholder={m.livetv_search_placeholder()}
    aria-label={m.viewer_livetv_search_scope()}
    debounce={300}
    size="md"
    oninput={({ value: v }) => onquery(v)}
    onclear={() => onquery('')} />
