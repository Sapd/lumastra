// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malSyncDef } from '$lib/server/api/defs/integrations/mal/sync.js';

export const { POST } = mount(malSyncDef, { surface: 'internal' });
