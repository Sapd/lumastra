// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { traktStatusDef } from '$lib/server/api/defs/integrations/trakt/status.js';

export const { GET } = mount(traktStatusDef, { surface: 'internal' });
