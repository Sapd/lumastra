// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET playlists/{id}/suggestions — playlist-aware track recommendations.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/suggestions.js';
export const { GET } = mount(def, { surface: 'v1' });
