const js = require('@eslint/js');
const parser = require('@typescript-eslint/parser');
const plugin = require('@typescript-eslint/eslint-plugin');
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'src/protocol/therapist.ts'] },
  { ...js.configs.recommended, files: ['scripts/**/*.cjs', '*.cjs'], languageOptions: { globals: {
    require: 'readonly', module: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly',
  } } },
  { files: ['src/**/*.ts'], languageOptions: { parser, globals: { structuredClone: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', console: 'readonly', process: 'readonly' } },
    plugins: { '@typescript-eslint': plugin }, rules: { ...js.configs.recommended.rules, ...plugin.configs.recommended.rules,
      'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
];
