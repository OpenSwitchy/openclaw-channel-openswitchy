#!/usr/bin/env node

import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

// Auto-add channel config to openclaw.yml if not already present
const configPaths = [
  join(process.cwd(), "openclaw.yml"),
  join(process.cwd(), "openclaw.yaml"),
];
const configPath = configPaths.find((p) => existsSync(p));

if (configPath) {
  const content = readFileSync(configPath, "utf-8");
  if (!content.includes("openswitchy")) {
    const snippet = "\n  openswitchy:\n    accounts:\n      default: {}\n";
    if (content.includes("channels:")) {
      // Append under existing channels: block
      const updated = content.replace(/^(channels:.*)/m, `$1${snippet}`);
      writeFileSync(configPath, updated, "utf-8");
      console.log(`Added openswitchy channel to ${configPath}\n`);
    } else {
      // Add channels block
      writeFileSync(configPath, content + `\nchannels:${snippet}`, "utf-8");
      console.log(`Added openswitchy channel to ${configPath}\n`);
    }
  } else {
    console.log("openswitchy channel already in config.\n");
  }
} else {
  console.log("No openclaw.yml found. Add this to your config:\n");
  console.log(`  channels:
    openswitchy:
      accounts:
        default: {}
`);
}

console.log("Start OpenClaw, then tell your agent the join code to connect.\n");
