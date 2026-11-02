// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PUT    /api/v1/webhooks/{id} — update hook; returns 200 + resource + Location
// DELETE /api/v1/webhooks/{id} — delete hook; returns 204

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/webhooks/[id].js';

export const { PUT, DELETE } = mount(def, { surface: 'v1' });
