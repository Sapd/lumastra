<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix — the symptom router.

  Admin gating comes from the parent /admin layout, so there is no
  +page.server.ts (same as /admin/system/diagnostics). The page holds no state
  of its own: everything it shows comes from the catalogue in symptoms.ts.

  The single biggest gap for a self-hoster is not missing functionality, it is
  that going from "no poster on this movie" to the page that owns posters
  requires already knowing how the system is put together. This page is the
  translation layer, and nothing else on it should accumulate.

  The one exception is the ingest funnel above the list. It is not a symptom and
  does not belong in the catalogue: it exists to surface problems the operator
  did NOT arrive with, which is the one thing a symptom router structurally
  cannot do. It stays a single collapsed line when the library is healthy.
-->
<script lang="ts">
    import { WrenchScrewdriver } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import IngestFunnel from '$lib/components/admin/fix/IngestFunnel.svelte';
    import SymptomList from '$lib/components/admin/fix/SymptomList.svelte';
    import EscapeHatch from '$lib/components/admin/fix/EscapeHatch.svelte';
    import * as m from '$lib/paraglide/messages.js';
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={WrenchScrewdriver}
        title={m.route_admin_fix_title()}
        description={m.route_admin_fix_description()} />

    <p class="max-w-3xl text-sm leading-relaxed text-surface-300">{m.admin_fix_intro()}</p>

    <!--
      Above the list on purpose. Every entry below answers a question the
      operator arrived with; this asks the question for them, so it belongs
      before the point where they must already know what is wrong.
    -->
    <IngestFunnel />

    <SymptomList />

    <EscapeHatch />
</div>
