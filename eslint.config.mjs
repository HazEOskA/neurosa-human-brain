import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "coverage",
      "*.config.*",
      "apps/*/*.config.*",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/neurosa-connect/web/app.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "document",
          "fetch",
          "AbortSignal",
          "setTimeout",
          "setInterval",
          "navigator",
          "Blob",
          "URL",
          "URLSearchParams",
          "crypto",
          "location",
          "history",
          "matchMedia",
          "devicePixelRatio",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "ResizeObserver",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
);
