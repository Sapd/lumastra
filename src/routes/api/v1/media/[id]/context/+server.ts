// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/media/{id}/context — public/native (Bearer) surface. Mounts the
// SAME def as the internal route, so both run identical auth/validation/handler
// logic. Sections run in-process (no internal sub-requests), which is what makes
// this safe for bearer clients.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-context.js';

export const { GET } = mount(def, { surface: 'v1' });
