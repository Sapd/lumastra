// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// DELETE /api/media/{id}/annotations/{annotationId} — soft-delete an annotation (SPA surface).
// Delegates to the new def; surface:'internal' uses the session-based principal.
import { mount } from '$lib/server/api/mount.js';
import { annotationByIdDef } from '$lib/server/api/defs/catalog/media-id-annotations.js';

export const { DELETE } = mount(annotationByIdDef, { surface: 'internal' });
