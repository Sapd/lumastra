// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/watched/series/[seriesId]/set-progress — bulk progress correction (SPA surface).
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watched/series-set-progress.js';

export const { POST } = mount(def, { surface: 'internal' });
