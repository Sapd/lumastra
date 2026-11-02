// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/upcoming — upcoming releases/episodes endpoint
// Views: ?view=episodes, ?view=alerts, ?view=calendar
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/recommendations/upcoming.js';

export const { GET } = mount(def, { surface: 'v1' });
