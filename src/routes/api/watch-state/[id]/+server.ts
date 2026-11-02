// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PATCH /api/watch-state/{id} — shared self-scoped watch state.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-state/[id].js';

export const { GET, PATCH } = mount(def, { surface: 'internal' });
