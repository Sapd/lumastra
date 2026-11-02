// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/me/stats — personal viewing statistics for the authenticated user.
// ?include=<metric>[,<metric>]  — partial fetch; omit for full bundle
// ?period=7d|30d|90d|all|year:YYYY  — time window (default: all)
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/stats/me.js';

export const { GET } = mount(def, { surface: 'v1' });
