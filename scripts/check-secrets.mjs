import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", ".wrangler", "coverage", "dist"]);
const textExtensions = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".txt",
  ".env",
  ".example",
  ".yml",
  ".yaml",
]);

const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    const extension = entry.name.includes(".") ? `.${entry.name.split(".").pop()}` : "";
    if (!textExtensions.has(extension) && entry.name !== ".gitignore") continue;
    const content = await readFile(path, "utf8");
    const relativePath = relative(root, path);

    if (/\b(?:xai|grok)-[^\s/]+\.json$/i.test(entry.name)) {
      findings.push(`${relativePath}: credential-like filename`);
    }
    const tokenPattern = /\b(?:access_token|refresh_token|id_token)\b\s*[:=]\s*["']([A-Za-z0-9._~+/=-]{32,})["']/gi;
    if (tokenPattern.test(content)) {
      findings.push(`${relativePath}: long OAuth token-like value`);
    }
    if (/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/.test(content)) {
      findings.push(`${relativePath}: JWT-like value`);
    }
  }
}

await walk(root);
if (findings.length) {
  console.error("Credential leak check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log("Credential leak check passed.");

