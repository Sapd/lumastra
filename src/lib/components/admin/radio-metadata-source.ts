// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RadioMetadataSource } from '$lib/schemas/radio';

/**
 * What RadioMetadataSource.svelte reports to the station form on every edit.
 * `source` is null when the URL is empty; `valid` is false when a URL is set
 * but the source is incomplete (bad URL, no mapped field, empty regex).
 * `dirty` is false until the admin changes something, so an untouched editor
 * never blocks or rewrites the station's stored source.
 */
export type RadioMetadataSourceChange = {
    source: RadioMetadataSource | null;
    valid: boolean;
    dirty: boolean;
};
