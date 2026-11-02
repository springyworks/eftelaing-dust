import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});

const js = (result.outputFiles[0]?.text ?? "").replace(/<\/script/gi, "<\\/script");
const template = readFileSync("src/index.template.html", "utf8");
const html = template.replace("<!--__SCRIPT__-->", () => `<script>${js}</script>`);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
const kb = (html.length / 1024).toFixed(0);
const sha = createHash("sha256").update(html).digest("hex").slice(0, 12);
console.log(`dist/index.html  ${kb} KB  sha256:${sha}`);
