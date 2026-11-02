<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The /settings root renders no page content of its own: +layout.svelte owns the
  root display — it shows the mobile section LIST at narrow viewports and redirects
  desktop viewports to the first enabled section (see the $effect there). The page
  body is only ever rendered through the layout's {@render children?.()} slot.

  This component must still exist, though: a leaf route that has a +page.ts (which
  this one does — it returns { isSettingsRoot: true }) requires a +page.svelte for
  server-side rendering. Without it, SvelteKit throws "Missing +page.svelte component
  for route /settings" during SSR (render.js, guarded by page_config.ssr), producing
  intermittent 500s on direct loads / hard refreshes of the bare /settings URL while
  in-app client navigation silently redirects away. Keep this file even though empty.
-->
