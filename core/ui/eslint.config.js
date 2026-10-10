import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import babelParser from "@babel/eslint-parser";

function tsBase(jsx) {
  return {
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: jsx
            ? [["@babel/preset-react", { runtime: "automatic" }], "@babel/preset-typescript"]
            : ["@babel/preset-typescript"],
        },
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  };
}

export default [
  { ignores: ["dist/**", "node_modules/**", "ui-react/**"] },
  { files: ["**/*.{ts,tsx}"], ...js.configs.recommended },
  { files: ["**/*.ts"], ...tsBase(false) },
  { files: ["**/*.tsx"], ...tsBase(true) },
];
