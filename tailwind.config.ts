import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS v4 Configuration
 *
 * Most configuration has been migrated to CSS:
 * - Colors: @theme directive in src/app.css
 * - Custom components: @layer components in src/app.css
 *
 * This file only contains settings that can't be expressed in CSS.
 */
const config = {
    darkMode: 'class',
    content: ['./src/**/*.{html,js,svelte,ts}'],
} satisfies Config;

export default config;
