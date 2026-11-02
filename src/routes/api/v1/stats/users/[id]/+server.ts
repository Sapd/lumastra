// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/stats/users/{id} — social stats for a specific user.
// {id} is the stable users.id UUID.
// Requires FEATURE_SOCIAL. Subject to social visibility (hide_streams gate).
// ?include=<metric>[,<metric>]  — partial fetch; omit for full bundle
// ?period=7d|30d|90d|all|year:YYYY  — time window (default: all)
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/stats/users-id.js';

export const { GET } = mount(def, { surface: 'v1' });
