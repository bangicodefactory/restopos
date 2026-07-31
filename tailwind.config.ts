import type { Config } from 'tailwindcss';

/**
 * RestoPOS design tokens.
 *
 * Three very different surfaces share this theme:
 *   - the register: bright room, gloved/greasy fingers, 10" tablets → huge targets, high contrast;
 *   - the kitchen display: dark room, viewed from 2 m, often through steam → the `kitchen` palette;
 *   - self-order: a customer's phone, one-handed, brand-coloured.
 *
 * Rules encoded here rather than left to each app:
 *   - `spacing.touch` (44px) is the WCAG 2.5.5 minimum; `touch-lg` (56px) is the register default.
 *   - Text never goes below `text-sm`; the base scale is one step larger than a normal web app.
 *   - Colours are declared as CSS variables in resources/css/app.css so the self-order app can
 *     re-theme at runtime from the venue's branding without a rebuild.
 */
export default {
    darkMode: 'class',

    content: [
        './resources/**/*.{tsx,ts,jsx,js,blade.php}',
        './packages/domain/src/**/*.{ts,tsx}',
        './resources/views/**/*.blade.php',
    ],

    theme: {
        extend: {
            colors: {
                // Brand / interactive. Runtime-overridable via CSS vars (see app.css).
                brand: {
                    50: 'rgb(var(--rp-brand-50) / <alpha-value>)',
                    100: 'rgb(var(--rp-brand-100) / <alpha-value>)',
                    200: 'rgb(var(--rp-brand-200) / <alpha-value>)',
                    300: 'rgb(var(--rp-brand-300) / <alpha-value>)',
                    400: 'rgb(var(--rp-brand-400) / <alpha-value>)',
                    500: 'rgb(var(--rp-brand-500) / <alpha-value>)',
                    600: 'rgb(var(--rp-brand-600) / <alpha-value>)',
                    700: 'rgb(var(--rp-brand-700) / <alpha-value>)',
                    800: 'rgb(var(--rp-brand-800) / <alpha-value>)',
                    900: 'rgb(var(--rp-brand-900) / <alpha-value>)',
                },

                // Semantic state colours — used by StatusBar, Toast, sync badges.
                ok: { DEFAULT: '#15803d', soft: '#dcfce7', fg: '#052e16' },
                warn: { DEFAULT: '#b45309', soft: '#fef3c7', fg: '#451a03' },
                danger: { DEFAULT: '#b91c1c', soft: '#fee2e2', fg: '#450a0a' },
                info: { DEFAULT: '#1d4ed8', soft: '#dbeafe', fg: '#172554' },
                offline: { DEFAULT: '#57534e', soft: '#e7e5e4', fg: '#1c1917' },

                // Kitchen display: dark, saturated, readable across a hot line at 2 m.
                kitchen: {
                    bg: '#0a0f14',
                    surface: '#111a22',
                    raised: '#1a2733',
                    border: '#2b3d4d',
                    text: '#e8f1f8',
                    muted: '#93a7b8',
                    new: '#38bdf8',
                    cooking: '#fbbf24',
                    ready: '#4ade80',
                    late: '#f87171',
                    served: '#64748b',
                },
            },

            spacing: {
                // Touch targets. Never build an interactive control smaller than `touch`.
                touch: '2.75rem', // 44px — absolute minimum
                'touch-lg': '3.5rem', // 56px — register default
                'touch-xl': '4.5rem', // 72px — numpad / payment keys
                safe: 'env(safe-area-inset-bottom, 0px)',
            },

            minWidth: { touch: '2.75rem', 'touch-lg': '3.5rem' },
            minHeight: { touch: '2.75rem', 'touch-lg': '3.5rem', 'touch-xl': '4.5rem' },

            fontFamily: {
                sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
                // Receipt preview must look like a 42-column thermal print.
                receipt: ['ui-monospace', 'Courier New', 'monospace'],
            },

            fontSize: {
                // One step larger than web defaults across the board.
                xs: ['0.8125rem', { lineHeight: '1.125rem' }],
                sm: ['0.9375rem', { lineHeight: '1.375rem' }],
                base: ['1.0625rem', { lineHeight: '1.5rem' }],
                lg: ['1.1875rem', { lineHeight: '1.75rem' }],
                xl: ['1.375rem', { lineHeight: '1.875rem' }],
                '2xl': ['1.75rem', { lineHeight: '2.125rem' }],
                '3xl': ['2.25rem', { lineHeight: '2.5rem' }],
                // Money on the payment screen and the KDS ticket timer.
                total: ['3rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '700' }],
            },

            borderRadius: { pos: '0.75rem', 'pos-lg': '1rem' },

            boxShadow: {
                pos: '0 1px 2px rgb(0 0 0 / 0.06), 0 4px 12px rgb(0 0 0 / 0.08)',
                'pos-lg': '0 8px 32px rgb(0 0 0 / 0.18)',
                'press-inset': 'inset 0 2px 6px rgb(0 0 0 / 0.22)',
            },

            transitionDuration: { press: '80ms' },

            keyframes: {
                'toast-in': {
                    from: { opacity: '0', transform: 'translateY(0.75rem) scale(0.98)' },
                    to: { opacity: '1', transform: 'translateY(0) scale(1)' },
                },
                'pulse-sync': {
                    '0%, 100%': { opacity: '1' },
                    '50%': { opacity: '0.35' },
                },
            },
            animation: {
                'toast-in': 'toast-in 140ms ease-out',
                'pulse-sync': 'pulse-sync 1.4s ease-in-out infinite',
            },

            screens: {
                // Register terminals are landscape tablets; KDS is a TV.
                till: { raw: '(min-width: 1024px) and (orientation: landscape)' },
                kds: '1600px',
            },
        },
    },

    plugins: [],
} satisfies Config;
