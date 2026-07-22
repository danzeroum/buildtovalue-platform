// Base herdada do repo `bpmn` (plano v1.2 §4): mesmo rigor, mesmos padrões.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/src/api/generated/**',
      // documentos e artefatos de handoff do dono (viewers .js enviados pela
      // UI) não são código da plataforma — fora do lint.
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
