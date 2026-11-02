// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/series/downloads/rescore — statuses and ordinal ranks for a
// bounded cohort of series download-pool members.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/series/downloads/rescore.js';

export const { POST } = mount(def, { surface: 'v1' });
