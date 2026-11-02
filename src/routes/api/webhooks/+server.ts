// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET  /api/webhooks — list hooks ({items,page})
// POST /api/webhooks — create hook; returns 201 + resource + Location
//
// Internal (cookie/forward-auth) mirror of /api/v1/webhooks.
// Auth delegates to the same AuthSpec (scope: webhooks:write) via mount(),
// which accepts locals.principal set by the session/forward-auth middleware.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/webhooks/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
