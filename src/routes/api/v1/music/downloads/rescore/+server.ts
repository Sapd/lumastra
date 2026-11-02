// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/music/downloads/rescore — ordinal ranks for a bounded pool cohort.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/downloads/rescore.js';

export const { POST } = mount(def, { surface: 'v1' });
