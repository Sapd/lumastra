<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * A-Z Browse Page
     * This page renders the same content as /browse but with A-Z mode enabled by default.
     * The parent browse page will detect the /az path and enable A-Z mode automatically.
     */
    import BrowsePage from '../+page.svelte';
    import type { PageData } from './$types';

    // Explicitly typed: an untyped `$props()` infers an index-signature type.
    // The route-local loader contributes the watching suppression policy, while
    // BrowsePage still treats the optional SSR watching seed consistently.
    let { data }: { data: PageData } = $props();
</script>

<!-- Re-render the browse page - it will detect /browse/az path and enable A-Z mode -->
<BrowsePage {data} />
