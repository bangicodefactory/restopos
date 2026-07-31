import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/** Architectural boundaries from docs/CONVENTIONS.md "Layering (client)". */
const boundaries = {
    'no-restricted-imports': [
        'error',
        {
            patterns: [
                {
                    group: ['@register/*', '@kitchen/*', '@selforder/*', '@backoffice/*'],
                    message:
                        'Apps must not import from each other. Put shared code in @shared or @domain.',
                },
            ],
        },
    ],
};

const base = [
    {
        ignores: [
            'node_modules/**',
            'vendor/**',
            'public/**',
            'storage/**',
            'bootstrap/cache/**',
            'tools/**',
            'packages/*/dist/**',
        ],
    },
    js.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            // The `globals` package is not a dependency; this is the subset our JS actually uses.
            globals: {
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                process: 'readonly',
                globalThis: 'readonly',
            },
        },
    },
    {
        // packages/domain is the crown jewel: zero runtime deps, no framework, no browser globals.
        files: ['packages/domain/src/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['react', 'react-dom', 'dexie', 'zustand', '@shared/*', '@inertiajs/*'],
                            message:
                                'packages/domain must stay framework-free and dependency-free (CONVENTIONS.md).',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['resources/js/**/*.{ts,tsx}'],
        rules: boundaries,
    },
];

export default [
    ...base,
    ...tseslint.configs.recommended.map((c) => ({
        ...c,
        files: ['resources/js/**/*.{ts,tsx}', 'packages/domain/**/*.ts'],
    })),
    {
        files: ['resources/js/**/*.{ts,tsx}', 'packages/domain/**/*.ts'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            // The two classic rules only. The plugin's newer `recommended` set also ships the
            // React Compiler diagnostics (`react-hooks/refs`, `set-state-in-effect`, …), which
            // flag deliberate patterns in the register — a ref written during render is how the
            // numpad and the reachability probe avoid re-rendering a 5000-product grid on every
            // keystroke. Enable those separately if the codebase ever adopts the compiler.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            // Only flag a destructuring `let` when *every* binding could be const — otherwise
            // splitting one aggregate destructure into a const half and a let half reads worse
            // than the `let` it replaces.
            'prefer-const': ['error', { destructuring: 'all' }],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
];
