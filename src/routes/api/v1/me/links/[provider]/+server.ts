// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET + DELETE /api/v1/me/links/{provider}
// {provider} is a closed enum (mal | …).
// Auth: {kind:'user'} — self-scoped.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/links/provider.js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
