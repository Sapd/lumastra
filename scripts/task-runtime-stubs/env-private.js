// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Match SvelteKit's default public prefix. This bundle never serves client code.
export const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PUBLIC_')),
);
