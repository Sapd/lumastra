// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/downloads/candidates — budget-cut download candidates for
// the series-next-up lane.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/series/downloads/candidates.js';

export const { GET } = mount(def, { surface: 'v1' });
