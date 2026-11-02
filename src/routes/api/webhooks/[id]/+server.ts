// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PUT    /api/webhooks/{id} — update hook; returns 200 + resource + Location
// DELETE /api/webhooks/{id} — delete hook; returns 204
//
// Internal (cookie/forward-auth) mirror of /api/v1/webhooks/{id}.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/webhooks/[id].js';

export const { PUT, DELETE } = mount(def, { surface: 'internal' });
