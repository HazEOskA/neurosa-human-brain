import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL(".", import.meta.url));
await mkdir(join(directory, "dist"), { recursive: true });
await build({
  entryPoints: [join(directory, "src/index.ts")],
  outfile: join(directory, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  tsconfig: join(directory, "../../tsconfig.json"),
  minify: true,
  legalComments: "eof",
});
const typesDirectory = await mkdtemp(join(tmpdir(), "neurosa-memory-types-"));
try {
  execFileSync(
    process.execPath,
    [
      join(directory, "../../node_modules/typescript/bin/tsc"),
      "-p",
      join(directory, "tsconfig.build.json"),
      "--outDir",
      typesDirectory,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  for (const file of ["index.d.ts", "types.d.ts"])
    await cp(
      join(typesDirectory, "packages/neurosa-memory/src", file),
      join(directory, "dist", file),
    );
  await cp(join(directory, "../../LICENSE"), join(directory, "LICENSE"));
} finally {
  await rm(typesDirectory, { recursive: true, force: true });
}
