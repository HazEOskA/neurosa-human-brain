import { readFile } from "node:fs/promises";

const visibleFiles = [
  "apps/brain-web/app/layout.tsx",
  "apps/brain-web/app/page.tsx",
  "apps/brain-web/components/living-brain-workspace.tsx",
];

describe("polski interfejs Żywego Mózgu", () => {
  it("zawiera polskie nazwy głównych ekranów i działań", async () => {
    const content = (await Promise.all(visibleFiles.map((path) => readFile(path, "utf8")))).join(
      "\n",
    );
    for (const phrase of [
      "Żywy mózg agentów",
      "Adres lokalnego API",
      "Token lokalny",
      "Połącz",
      "Rozłącz",
      "Uruchom test mózgu",
      "Model przestrzenny",
      "Ledger poprawny",
      "Inspektor",
      "Stan runtime’u",
    ]) {
      expect(content).toContain(phrase);
    }
  });

  it("nie zawiera znanych angielskich komunikatów operatora", async () => {
    const content = (await Promise.all(visibleFiles.map((path) => readFile(path, "utf8")))).join(
      "\n",
    );
    expect(content).not.toMatch(
      />\s*(Connect|Disconnect|Run brain test|Brain model|Inspector panel|Runtime status|Loading|Error)\s*</u,
    );
  });
});
