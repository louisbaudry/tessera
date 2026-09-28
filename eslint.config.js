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
    // `core/model` is the base layer: nothing from another `core` module,
    // nothing from Node, nothing from a package (CLAUDE.md) — only its
    // own `./` siblings. It is also `@cat-tool/core/model`, the one
    // runtime entry the SPA may import, so this is what keeps a browser
    // bundle free of `node:crypto` and the DOCX filter.
    files: ['packages/core/src/model/**/*.ts'],
    ignores: ['packages/core/src/model/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./)',
              message:
                'model/ is the base layer: it imports its own ./ siblings, nothing else.',
            },
          ],
        },
      ],
    },
  },
  {
    // The SPA takes types from `core`, never its runtime: `core`'s index
    // reaches `node:crypto`, the DOCX filter and the segmenter, none of
    // which belongs in a browser bundle (v1-spec.md §7.1). The token
    // model and tag rules are the exception, through the browser-safe
    // `@cat-tool/core/model` entry (§7.2), which this rule leaves open.
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
  {
    // A migration's DDL is a historical snapshot and never reads a live
    // list (`db/migrate.ts`, backlog #64). A CHECK built from one of
    // these constants means one thing in a fresh file and another in
    // every existing one; the guard test only checks the newest list,
    // so this is what keeps the older ones frozen.
    files: ['packages/db/src/**/schema.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@cat-tool/core',
              importNames: [
                'QA_RULES',
                'QA_SEVERITIES',
                'SEGMENT_STATUSES',
                'DECISION_KINDS',
                'PROJECT_AUDIT_ACTIONS',
                'PLATFORM_AUDIT_ACTIONS',
                'PORTAL_AUDIT_ACTIONS',
              ],
              message:
                'A migration writes its closed set as a literal snapshot, never the live list (db/migrate.ts).',
              allowTypeImports: true,
            },
            {
              name: '@cat-tool/portal-core',
              importNames: ['ORDER_STATUSES'],
              message:
                'A migration writes its closed set as a literal snapshot, never the live list (db/migrate.ts).',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
