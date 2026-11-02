// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
export const building = false;
export const browser = false;
export const dev = process.env.NODE_ENV !== 'production';
export const version = process.env.APP_VERSION ?? 'unknown';
