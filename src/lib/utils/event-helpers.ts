// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const preventDefault =
    <T extends Event>(handler?: (event: T) => void) =>
    (event: T) => {
        event.preventDefault();
        handler?.(event);
    };

export const stopPropagation =
    <T extends Event>(handler?: (event: T) => void) =>
    (event: T) => {
        event.stopPropagation();
        handler?.(event);
    };

export const self =
    <T extends Event>(handler?: (event: T) => void) =>
    (event: T) => {
        if (event.target === event.currentTarget) {
            handler?.(event);
        }
    };
