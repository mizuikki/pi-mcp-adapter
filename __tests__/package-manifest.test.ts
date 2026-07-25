import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
};

describe("package.json files", () => {
  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
  });

  it("uses host-provided Pi peers and sibling-only development dependencies", () => {
    const packages = {
      "@earendil-works/pi-ai": "ai",
      "@earendil-works/pi-coding-agent": "coding-agent",
      "@earendil-works/pi-tui": "tui",
    };
    for (const [name, workspace] of Object.entries(packages)) {
      expect(packageJson.peerDependencies?.[name]).toBe("*");
      expect(packageJson.devDependencies?.[name]).toBe(`file:../pi/packages/${workspace}`);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
    }
  });
});
