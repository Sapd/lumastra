// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/index.js';
export const { GET, PATCH, DELETE } = mount(def, { surface: 'internal' });
