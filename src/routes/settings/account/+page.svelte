<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import AccountSection from '$lib/components/settings/AccountSection.svelte';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();
</script>

<AccountSection initialTokens={data.tokens} patsEnabled={data.patsEnabled} signIn={data.signIn} />
