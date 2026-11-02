// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malStatusDef } from '$lib/server/api/defs/integrations/mal/status.js';

export const { GET } = mount(malStatusDef, { surface: 'internal' });
