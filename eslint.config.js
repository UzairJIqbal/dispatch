import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // load/ is k6 JavaScript: it runs in k6's own runtime, not Node, and is checked with `k6 inspect`.
  { ignores: ["dist", "node_modules", ".cache", ".agents", ".claude", "load"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
);
