import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const rootDir = new URL("..", import.meta.url).pathname;
const distDir = join(rootDir, "dist");
const declarationDir = join(distDir, "_types");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const dependencies = Object.keys(packageJson.dependencies ?? {});
const external = dependencies.flatMap((name) => [name, `${name}/*`]);

const build = await Bun.build({
  entrypoints: [join(rootDir, "src/index.ts")],
  outdir: distDir,
  target: "node",
  format: "esm",
  sourcemap: "external",
  external
});

if (!build.success) {
  for (const log of build.logs) {
    console.error(log);
  }
  process.exit(1);
}

const tsc = Bun.spawnSync([
  "bunx",
  "tsc",
  "--project",
  "tsconfig.build.json"
], {
  cwd: rootDir,
  stdout: "inherit",
  stderr: "inherit"
});

if (!tsc.success) {
  process.exit(tsc.exitCode ?? 1);
}

const entryTypes = [
  'export * from "./_types/packages/protocol/src/index.js";',
  'export * from "./_types/packages/codec/src/index.js";',
  'export * from "./_types/packages/action-registry/src/index.js";',
  'export * from "./_types/packages/storage/src/index.js";',
  'export * from "./_types/packages/ptb-inspector/src/index.js";',
  'export * from "./_types/packages/policy-engine/src/index.js";',
  'export * from "./_types/packages/trace-guard/src/index.js";',
  'export * from "./_types/packages/transport/src/index.js";',
  'export * from "./_types/packages/sui-stack-adapter/src/index.js";',
  'export * from "./_types/packages/memwal-adapter/src/index.js";',
  'export * from "./_types/packages/sdk/src/index.js";',
  ""
].join("\n");

await writeFile(join(distDir, "index.d.ts"), entryTypes);

await normalizeDeclarationImports(declarationDir);

async function normalizeDeclarationImports(dir: string): Promise<void> {
  for await (const entry of new Bun.Glob("**/*.d.ts").scan({ cwd: dir, absolute: true })) {
    const text = await Bun.file(entry).text();
    const normalized = text.replace(/(\.\.?\/[^"']+)\.ts(["'])/g, "$1.js$2");
    if (normalized !== text) {
      await writeFile(entry, normalized);
    }
  }
}
