// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Bare /j/web — re-exports the catch-all handler so /j/web (no path) and
// /j/web/index.html, /j/web/anything-else all serve the same redirect HTML.
export { GET } from './[...path]/+server';
