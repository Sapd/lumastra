<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Test fixture for AsyncSection.svelte.test.ts.
-->
<script lang="ts">
    import AsyncSection from './AsyncSection.svelte';
    import type { ClassifiedError } from '$lib/utils/admin/error-contract.js';

    interface Props {
        loading: boolean;
        error: ClassifiedError | null;
        empty?: boolean;
        timeoutMs?: number;
        onretry?: () => void;
    }

    let { loading, error, empty = false, timeoutMs, onretry }: Props = $props();
</script>

<AsyncSection {loading} {error} {empty} {timeoutMs} {onretry}>
    <div>the content</div>
</AsyncSection>
