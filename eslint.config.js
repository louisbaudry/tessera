import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'code/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // The SPA takes types from `core`, never its runtime: `core`'s index
    // reaches `node:crypto`, the DOCX filter and the segmenter, none of
    // which belongs in a browser bundle (v1-spec.md §7.1).
    files: ['packages/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@cat-tool/core',
              message: 'Type imports only: core is not a browser dependency.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
