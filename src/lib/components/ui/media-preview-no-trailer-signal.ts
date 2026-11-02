// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown from inside the `acquirePreviewSession` `create` callback in
 * `MediaPreviewPlayer.svelte` when the server answers `mode: 'none'` (no
 * local trailer). Letting it propagate as a rejection — rather than
 * returning a sentinel value — means `acquirePreviewSession` never reaches
 * the point where it stores an entry: there is no server session behind a
 * 'none' answer, so nothing should be memoized for this key.
 *
 * Extracted to its own module (same pattern as `preview-hls-config.ts` /
 * `media-preview-network-readiness.ts` / `media-preview-hover-cap.ts`)
 * rather than declared inside the component's instance `<script>`. A class
 * declared in an instance script is a FRESH object every time the component
 * mounts, so two different `MediaPreviewPlayer` instances sharing a
 * single-flighted `acquirePreviewSession` create() (e.g. a hero slot and a
 * hover popup on the same item) would each own a distinct `NoTrailerSignal`
 * class — the second holder's `instanceof` check against ITS OWN class would
 * fail against the rejection thrown by the creator's class, fall through to
 * `throw error`, and log at error level on a path specified to produce none.
 * A module-level class is the SAME object for every importer, so `instanceof`
 * is stable across instances and across the single-flight boundary.
 */
export class NoTrailerSignal extends Error {}
