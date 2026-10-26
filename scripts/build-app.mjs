// Empacota um app (apps/*) em dist/index.js com esbuild.
// Regra: o pacote final só contém o nosso código (apps/* e packages/*).
// Toda biblioteca de terceiros fica de fora e precisa estar em "dependencies" do app,
// para o `pnpm deploy --prod` instalar exatamente o que roda em produção.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const dependencies = Object.keys(pkg.dependencies ?? {});

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
  external: dependencies.flatMap((name) => [name, `${name}/*`]),
});

const bundledThirdParty = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (match?.[1]) bundledThirdParty.add(match[1]);
}

if (bundledThirdParty.size > 0) {
  console.error(
    `\n${pkg.name}: adicione em "dependencies" do package.json (com "catalog:" se já existir no catálogo):\n` +
      [...bundledThirdParty].map((name) => `  - ${name}`).join("\n"),
  );
  process.exit(1);
}

const bytes = result.metafile.outputs["dist/index.js"]?.bytes ?? 0;
console.log(`${pkg.name}: dist/index.js (${(bytes / 1024).toFixed(1)} KB)`);
