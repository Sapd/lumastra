// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malSyncStatusDef } from '$lib/server/api/defs/integrations/mal/sync-status.js';

export const { GET } = mount(malSyncStatusDef, { surface: 'internal' });
