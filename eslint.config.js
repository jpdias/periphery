import js from "@eslint/js";
import globals from "globals";

// Node is the default env for everything; files in web/public are browser code.
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.pio/**",
      "**/.netlify/**",
      "server/netlify/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-prototype-builtins": "off",
    },
  },
  {
    files: ["server/functions/**/*.js", "server/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["web/public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
        window: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        document: "readonly",
        fetch: "readonly",
        MINIDASH_CONFIG: "readonly",
      },
    },
  },
];
