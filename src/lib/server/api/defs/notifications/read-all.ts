// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Per-route alias so route files can `import { def }` — the OpenAPI generator's
// def-discovery keys off the `def` binding name (import { def } + mount(def)),
// and index.ts already exports two other named defs, so it cannot also name
// this one `def`. The alias makes readAllDef.docs discoverable from the route.
export { readAllDef as def } from './index.js';
