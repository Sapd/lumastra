// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    generateRamp,
    generateThemeCss,
    hexToOklch,
    PRIMARY_LADDER,
    SURFACE_LADDER,
    RAMP_STEPS,
} from './theme-css';
import { BUILTIN_THEMES, type ThemeDefinition } from '$lib/shared/theme/theme-model';
import {
    neutralizeCustomCss,
    neutralizeCustomJs,
    buildCustomCssTag,
    buildCustomJsTag,
} from './custom-code';

/** Original app.css indigo (primary) ramp — the round-trip reference. */
const PRIMARY_HEXES: Record<number, string> = {
    50: '#eef2ff',
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
    950: '#1e1b4b',
};

function channels(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
        Number.parseInt(h.slice(0, 2), 16),
        Number.parseInt(h.slice(2, 4), 16),
        Number.parseInt(h.slice(4, 6), 16),
    ];
}

const marquee = BUILTIN_THEMES.find((t) => t.id === 'marquee')!;

describe('generateRamp', () => {
    it('(a) reproduces the original indigo ramp from seed #6366f1 within ±3 per channel', () => {
        const ramp = generateRamp('#6366f1', PRIMARY_LADDER);
        for (const step of RAMP_STEPS) {
            const [gr, gg, gb] = channels(ramp[step]);
            const [er, eg, eb] = channels(PRIMARY_HEXES[step]);
            expect(
                Math.abs(gr - er),
                `${step} R (${ramp[step]} vs ${PRIMARY_HEXES[step]})`,
            ).toBeLessThanOrEqual(3);
            expect(
                Math.abs(gg - eg),
                `${step} G (${ramp[step]} vs ${PRIMARY_HEXES[step]})`,
            ).toBeLessThanOrEqual(3);
            expect(
                Math.abs(gb - eb),
                `${step} B (${ramp[step]} vs ${PRIMARY_HEXES[step]})`,
            ).toBeLessThanOrEqual(3);
        }
    });

    it('(b) a neutral (achromatic) seed yields a near-neutral ramp: every step chroma < 0.01', () => {
        // Pure grey seed → OKLCH chroma 0 → scale 0 → whole ramp collapses to grey.
        const ramp = generateRamp('#808080', SURFACE_LADDER);
        for (const step of RAMP_STEPS) {
            const { C } = hexToOklch(ramp[step]);
            expect(C, `${step} chroma of ${ramp[step]}`).toBeLessThan(0.01);
        }
    });
});

describe('generateThemeCss', () => {
    it('(c) marquee emits 22 --color vars + 21 -rgb triplets plus a starfield-disable rule', () => {
        const css = generateThemeCss([marquee]);

        // 11 surface + 11 primary hex custom properties.
        const surfaceVars = css.match(/--color-surface-\d+:/g) ?? [];
        const primaryVars = css.match(/--color-primary-\d+:/g) ?? [];
        expect(surfaceVars).toHaveLength(11);
        expect(primaryVars).toHaveLength(11);
        expect(surfaceVars.length + primaryVars.length).toBe(22);

        // Tailwind's default gray palette is blue-tinted and used widely for
        // fills (.card-glass etc.) — themes override all 11 gray steps too.
        const grayVars = css.match(/--color-gray-\d+: #[0-9a-f]{6};/g) ?? [];
        expect(grayVars).toHaveLength(11);

        // -rgb triplet twins for the rgb(var(--…-rgb) / α) translucency
        // pattern: all 11 surface steps, primary only up to 900 (matching
        // the base set in app.css). Values are space-separated R G B.
        const surfaceRgbVars = css.match(/--color-surface-\d+-rgb: \d+ \d+ \d+;/g) ?? [];
        const primaryRgbVars = css.match(/--color-primary-\d+-rgb: \d+ \d+ \d+;/g) ?? [];
        expect(surfaceRgbVars).toHaveLength(11);
        expect(primaryRgbVars).toHaveLength(10);
        expect(css).not.toContain('--color-primary-950-rgb');

        // Scoped to the theme id.
        expect(css).toContain("html[data-theme='marquee'] {");
        // starfield === false → hide rule present.
        expect(css).toContain("html[data-theme='marquee'] .app-starfield { display: none; }");
    });

    it('(d) warp emits nothing (app.css :root is warp → zero diff)', () => {
        const warp = BUILTIN_THEMES.find((t) => t.id === 'warp')!;
        expect(generateThemeCss([warp])).toBe('');
    });

    it('(d.2) a starfield:true theme does NOT emit a starfield-disable rule', () => {
        const starryTheme: ThemeDefinition = { ...marquee, id: 'starry', starfield: true };
        const css = generateThemeCss([starryTheme]);
        expect(css).toContain("[data-theme='starry'] {");
        expect(css).not.toContain('.app-starfield');
    });

    it('(e) an entry with an invalid id is skipped', () => {
        const bad: ThemeDefinition = {
            id: 'Bad Id!', // spaces + uppercase + punctuation → invalid
            name: 'Bad',
            accent: '#123456',
            surfaceTint: '#654321',
            starfield: true,
        };
        const css = generateThemeCss([bad, marquee]);
        expect(css).not.toContain('Bad Id');
        // The valid marquee entry still renders.
        expect(css).toContain("html[data-theme='marquee'] {");
    });
});

describe('custom CSS/JS injection hardening', () => {
    it('strips </style breakouts from custom CSS (case-insensitive, splice-resistant)', () => {
        expect(neutralizeCustomCss('body { color: red }</style><script>alert(1)</script>')).toBe(
            'body { color: red }><script>alert(1)</script>',
        );
        // Case-insensitive.
        expect(neutralizeCustomCss('a</STYLE>b</StYlE>c')).toBe('a>b>c');
        // Stripping must not splice a NEW `</style` together.
        expect(neutralizeCustomCss('</sty</stylele')).not.toContain('</sty');
        // Benign CSS passes through verbatim (admin-trust: no other sanitization).
        const benign = '.navbar { background: url("x.png"); content: "</div>"; }';
        expect(neutralizeCustomCss(benign)).toBe(benign);
    });

    it('escapes </script breakouts in custom JS to <\\/script (case-preserving)', () => {
        expect(neutralizeCustomJs('const s = "</script><img src=x>";')).toBe(
            'const s = "<\\/script><img src=x>";',
        );
        // Case-insensitive match, matched case preserved.
        expect(neutralizeCustomJs('x = "</SCRIPT>"')).toBe('x = "<\\/SCRIPT>"');
        // Result never contains a raw </script sequence.
        expect(neutralizeCustomJs('a</script</SCRIPTb').toLowerCase()).not.toContain('</script');
        // Benign JS passes through verbatim.
        const benign = 'document.title = "hi"; // </div> is fine';
        expect(neutralizeCustomJs(benign)).toBe(benign);
    });

    it('builds a hardened <style id="custom-css"> tag; empty/whitespace → no injection', () => {
        expect(buildCustomCssTag('')).toBe('');
        expect(buildCustomCssTag('   \n\t ')).toBe('');
        const tag = buildCustomCssTag('body { color: red }</style>');
        expect(tag).toBe('<style id="custom-css">body { color: red }></style>');
        // Exactly one closing </style> — the one WE emit.
        expect(tag.toLowerCase().match(/<\/style/g)).toHaveLength(1);
    });

    it('builds a hardened <script id="custom-js"> tag; empty/whitespace → no injection', () => {
        expect(buildCustomJsTag('')).toBe('');
        expect(buildCustomJsTag('  \n ')).toBe('');
        const tag = buildCustomJsTag('console.log("</script>")');
        expect(tag).toBe('<script id="custom-js">console.log("<\\/script>")</script>');
        // Exactly one raw closing </script — the one WE emit.
        expect(tag.match(/<\/script/g)).toHaveLength(1);
    });
});
