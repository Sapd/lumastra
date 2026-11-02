// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { traktSyncDef } from '$lib/server/api/defs/integrations/trakt/sync.js';

export const { POST } = mount(traktSyncDef, { surface: 'internal' });
