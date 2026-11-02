<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  One signpost page, driven entirely by the catalogue. Adding a signpost means
  adding a row to signposts.ts and symptoms.ts — never a new route directory.
-->
<script lang="ts">
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import SignpostPage from '$lib/components/admin/fix/SignpostPage.svelte';
    import { findSignpost } from '$lib/components/admin/fix/signposts.js';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import { WrenchScrewdriver } from 'svelte-hero-icons';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    // Both lookups are total for any id the load function let through — it 404s
    // on anything not in the catalogue.
    let signpost = $derived(findSignpost(data.symptomId));
    let symptom = $derived(findSymptom(data.symptomId));
</script>

{#if signpost && symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <SignpostPage {signpost} />
    </FixPageShell>
{/if}
