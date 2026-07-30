import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
mkdirSync("src/generated", { recursive: true });
writeFileSync(
  "src/generated/version.ts",
  `export const VERSION = ${JSON.stringify(pkg.version)};\n`,
);
