// Flat ESLint config for rl-js-client.
//
// This repository ships zero dependencies and has no lockfile, so CI lints with
// `npx --yes eslint@10.8.1 .` and this file must not import anything -- a bare
// `import js from "@eslint/js"` would resolve against the repository, not
// against npx's temporary install, and fail.
//
// The rule list below is therefore ESLint 10.8.1's `js/recommended` set inlined
// verbatim, minus `no-unused-vars`. That one rule is off deliberately: it
// reports 20 intentionally-unused destructured fields and caught-error bindings
// across client.js and test_client.js, and silencing them would mean
// reformatting the codebase, which is out of scope for adding CI. Every rule
// that remains is a genuine-error rule, and the tree is clean under all of them.

const RECOMMENDED_ERROR_RULES = [
  'constructor-super',
  'for-direction',
  'getter-return',
  'no-async-promise-executor',
  'no-case-declarations',
  'no-class-assign',
  'no-compare-neg-zero',
  'no-cond-assign',
  'no-const-assign',
  'no-constant-binary-expression',
  'no-constant-condition',
  'no-control-regex',
  'no-debugger',
  'no-delete-var',
  'no-dupe-args',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-empty',
  'no-empty-character-class',
  'no-empty-pattern',
  'no-empty-static-block',
  'no-ex-assign',
  'no-extra-boolean-cast',
  'no-fallthrough',
  'no-func-assign',
  'no-global-assign',
  'no-import-assign',
  'no-invalid-regexp',
  'no-irregular-whitespace',
  'no-loss-of-precision',
  'no-misleading-character-class',
  'no-new-native-nonconstructor',
  'no-nonoctal-decimal-escape',
  'no-obj-calls',
  'no-octal',
  'no-prototype-builtins',
  'no-redeclare',
  'no-regex-spaces',
  'no-self-assign',
  'no-setter-return',
  'no-shadow-restricted-names',
  'no-sparse-arrays',
  'no-this-before-super',
  'no-unassigned-vars',
  'no-undef',
  'no-unexpected-multiline',
  'no-unreachable',
  'no-unsafe-finally',
  'no-unsafe-negation',
  'no-unsafe-optional-chaining',
  'no-unused-labels',
  'no-unused-private-class-members',
  'no-useless-assignment',
  'no-useless-backreference',
  'no-useless-catch',
  'no-useless-escape',
  'no-with',
  'preserve-caught-error',
  'require-yield',
  'use-isnan',
  'valid-typeof'
];

const rules = Object.fromEntries(RECOMMENDED_ERROR_RULES.map((rule) => [rule, 'error']));

// Node runtime globals. Spelled out rather than pulled from the `globals`
// package, for the same zero-dependency reason as the rule list.
const NODE_GLOBALS = {
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly'
};

const COMMONJS_GLOBALS = {
  __dirname: 'readonly',
  __filename: 'readonly',
  exports: 'writable',
  module: 'writable',
  require: 'readonly'
};

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, ...COMMONJS_GLOBALS }
    },
    rules
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS
    },
    rules
  }
];
