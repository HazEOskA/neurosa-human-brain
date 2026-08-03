import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@neurosa/ast": `${root}packages/neurosa-ast/src/index.ts`,
      "@neurosa/lexer": `${root}packages/neurosa-lexer/src/index.ts`,
      "@neurosa/parser": `${root}packages/neurosa-parser/src/index.ts`,
      "@neurosa/semantic-analysis": `${root}packages/neurosa-semantic-analysis/src/index.ts`,
      "@neurosa/type-checker": `${root}packages/neurosa-type-checker/src/index.ts`,
      "@neurosa/ir": `${root}packages/neurosa-ir/src/index.ts`,
      "@neurosa/compiler": `${root}packages/neurosa-compiler/src/index.ts`,
      "@neurosa/cli": `${root}packages/neurosa-cli/src/index.ts`,
      "@neurosa/runtime-domain": `${root}packages/neurosa-runtime-domain/src/index.ts`,
      "@neurosa/event-ledger": `${root}packages/neurosa-event-ledger/src/index.ts`,
      "@neurosa/storage/obsidian-import": `${root}packages/neurosa-storage/src/obsidian-import.ts`,
      "@neurosa/storage": `${root}packages/neurosa-storage/src/index.ts`,
      "@neurosa/activation": `${root}packages/neurosa-activation/src/index.ts`,
      "@neurosa/neural-runtime": `${root}packages/neurosa-runtime/src/index.ts`,
      "@neurosa/document-domain": `${root}packages/neurosa-document-domain/src/index.ts`,
      "@neurosa/workspace": `${root}packages/neurosa-workspace/src/index.ts`,
      "@neurosa/domain": `${root}packages/brain-domain/src/index.ts`,
      "@neurosa/ledger": `${root}packages/event-ledger/src/index.ts`,
      "@neurosa/runtime": `${root}packages/neural-runtime/src/index.ts`,
      "@neurosa/obsidian": `${root}packages/obsidian-adapter/src/index.ts`,
      "@neurosa/api-contracts": `${root}packages/brain-api-contracts/src/index.ts`,
      "@neurosa/api": `${root}packages/brain-api/src/index.ts`,
    },
  },
  test: { globals: true, include: ["tests/**/*.test.ts"] },
});
