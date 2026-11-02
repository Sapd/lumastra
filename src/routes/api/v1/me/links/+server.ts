// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/me/links — list all provider link statuses.
// Auth: {kind:'user'} — self-scoped.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/links/index.js';

export const { GET } = mount(def, { surface: 'v1' });
