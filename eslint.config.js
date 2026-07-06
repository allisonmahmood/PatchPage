import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".turbo/**"]
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-control-regex": "off",
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
