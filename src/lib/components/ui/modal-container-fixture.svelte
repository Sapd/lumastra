<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Minimal modal body used by ModalContainer.svelte.test.ts — just needs a
focusable element inside the dialog content so keydown events originate
from within the modal (the regression the test guards against).
-->
<script lang="ts">
    let { modalId = '' }: { modalId?: string } = $props();
</script>

<div data-testid="fixture-modal" data-modal-id={modalId}>
    <button type="button" data-testid="inner-button">inner</button>
</div>
