// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malSyncCancelDef } from '$lib/server/api/defs/integrations/mal/sync-cancel.js';

export const { POST } = mount(malSyncCancelDef, { surface: 'internal' });
