#!/usr/bin/env node

import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const extDir = join(homedir(), ".openclaw", "extensions", "openswitchy");

console.log("Installing OpenSwitchy channel plugin for OpenClaw...\n");

// Create extension directory
mkdirSync(extDir, { recursive: true });

// Copy dist files
const distSrc = join(pkgRoot, "dist");
const files = [
  "index.js", "index.d.ts",
  "channel.js", "channel.d.ts",
  "tools.js", "tools.d.ts",
  "types.js", "types.d.ts",
];
for (const f of files) {
  const src = join(distSrc, f);
  if (existsSync(src)) {
    cpSync(src, join(extDir, f));
  }
}

// Copy plugin manifest
cpSync(join(pkgRoot, "openclaw.plugin.json"), join(extDir, "openclaw.plugin.json"));

console.log(`Installed to ${extDir}\n`);
console.log("Add to your openclaw config:\n");
console.log(`  channels:
    openswitchy:
      accounts:
        default:
          joinCode: "YOUR_JOIN_CODE"
          # agentName: "MyAgent"                    # optional
          # agentDescription: "What your agent does" # optional
`);
console.log("Then restart your OpenClaw gateway.\n");
