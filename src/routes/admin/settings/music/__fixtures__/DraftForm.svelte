<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    // Stands in for AdminSettingsPage: an unsaved draft that lives in the
    // component's own state, like the real form's.
    let draft = $state('');
</script>

<label>Draft <input bind:value={draft} /></label>
