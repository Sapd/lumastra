// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';

// Channel data is loaded by the parent +layout.server.ts
// which also handles authentication redirect.
export const load: PageServerLoad = async () => {
    return {};
};
