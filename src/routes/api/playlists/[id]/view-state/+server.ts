// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/view-state.js';
export const { PUT } = mount(def, { surface: 'internal' });
