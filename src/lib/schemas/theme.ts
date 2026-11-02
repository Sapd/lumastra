// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Theme Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for VALIDATING admin-supplied theme definitions
 * (the `APPEARANCE_CUSTOM_THEMES` config array). The ambient TypeScript
 * contract (interfaces + constants) lives in `$lib/shared/theme/theme-model`;
 * this module adds runtime validation with hex-color + id checks.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { THEME_ID_REGEX, type ThemeDefinition } from '$lib/shared/theme/theme-model';

/** A 6-digit CSS hex color, e.g. `#6366f1`. */
export const HexColorSchema = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color like #6366f1')
    .describe('6-digit hex color (e.g. #6366f1)');

/** The three admin-tunable theme knobs (accent, surface tint, starfield). */
export const ThemeKnobsSchema = z.object({
    accent: HexColorSchema.describe('Accent seed color — generates the primary-50..950 ramp'),
    surfaceTint: HexColorSchema.describe(
        'Surface tint seed — sets hue/chroma of the surface-50..950 ramp',
    ),
    starfield: z
        .boolean()
        .describe('Per-theme starfield intent (composes with FEATURE_STARS_BACKGROUND)'),
});

/** A complete theme definition: knobs plus id/name/builtin metadata. */
export const ThemeDefinitionSchema = ThemeKnobsSchema.extend({
    id: z
        .string()
        .regex(THEME_ID_REGEX, 'Must be kebab-case, [a-z0-9-], 1–32 chars')
        .describe('Theme id — used as the data-theme attribute value'),
    name: z.string().min(1).max(64).describe('Display name shown in theme pickers'),
    builtin: z.boolean().optional().describe('True for shipped built-in themes'),
});

export type ThemeKnobsParsed = z.infer<typeof ThemeKnobsSchema>;
export type ThemeDefinitionParsed = z.infer<typeof ThemeDefinitionSchema>;

// Compile-time guarantee that the Zod-inferred shape and the ambient interface
// stay structurally identical in both directions (drift-guard). Purely a type
// assertion — erased at build time, emits no runtime code.
type _AssertSchemaMatchesInterface = ThemeDefinitionParsed extends ThemeDefinition
    ? ThemeDefinition extends ThemeDefinitionParsed
        ? true
        : never
    : never;
const _themeSchemaMatchesInterface: _AssertSchemaMatchesInterface = true;
void _themeSchemaMatchesInterface;

// Re-export the canonical ambient type so consumers can grab schema + type from
// one import site.
export type { ThemeDefinition } from '$lib/shared/theme/theme-model';
