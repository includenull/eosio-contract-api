import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ['build/**', 'node_modules/**'],
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'none',
                    ignoreRestSiblings: true,
                },
            ],
            'no-constant-binary-expression': 'off',
            'no-useless-assignment': 'off',
            '@typescript-eslint/explicit-function-return-type': 'error',
            'no-async-promise-executor': 'off',
            'no-console': 'error',
            'no-unused-vars': 'off',
            quotes: ['error', 'single', { allowTemplateLiterals: true }],
            semi: ['error', 'always'],
        },
    }
);
