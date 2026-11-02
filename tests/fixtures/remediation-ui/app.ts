// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { writable } from 'svelte/store';
export const browser = true;
export const dev = true;
export const building = false;
export const version = 'controlled-fixture';
export const base = '';
export const assets = '';
export const resolve = (path: string): string => path;
export const goto = async (): Promise<void> => {};
export const page = writable({ url: new URL('http://127.0.0.1:5199'), data: {} });
export const pushState = (): void => {};
export const replaceState = (): void => {};
