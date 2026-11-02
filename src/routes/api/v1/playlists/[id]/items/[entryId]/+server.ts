// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// DELETE /api/v1/playlists/{id}/items/{itemId} — public/native surface. Mounts the
// SAME shared def as the internal route. OpenAPI docs live in the def's `docs`.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/items/[entryId].js';

export const { DELETE } = mount(def, { surface: 'v1' });
