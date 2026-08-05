import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalForkFixture, createManifestConsumer } from "../../pi/scripts/local-fork-fixture.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const excludedPaths = new Set([".git", ".worktrees", ".pi", ".trellis", "dist", "node_modules"]);

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function parseArguments(args) {
  let piDir = resolve(projectDir, "../pi");
  let piRef = "HEAD";
  let keepTemp = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--pi-dir" || argument === "--pi-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--pi-dir") piDir = resolve(value);
      else piRef = value;
      index += 1;
      continue;
    }
    if (argument === "--keep-temp") {
      keepTemp = true;
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: npm run test:pi-fork -- [--pi-dir <pi-checkout>] [--pi-ref <git-ref>] [--keep-temp]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!existsSync(join(piDir, ".git"))) throw new Error(`--pi-dir is not a git checkout: ${piDir}`);
  return { piDir, piRef, keepTemp };
}

function installPoisonPackage(projectCopy, packageName) {
  const packageDir = join(projectCopy, "node_modules", packageName);
  rmSync(packageDir, { force: true, recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, type: "module" }));
  writeFileSync(join(packageDir, "index.js"), `throw new Error(${JSON.stringify(`poison package imported: ${packageName}`)});\n`);
}

function verifyManifestConsumer(consumerDirectory, manifest) {
	mkdirSync(consumerDirectory, { recursive: true });
	const adapterTarball = execFileSync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", consumerDirectory],
    { cwd: projectDir, encoding: "utf8" },
  );
	const packResult = JSON.parse(adapterTarball);
	const filename = (Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0])?.filename;
	if (typeof filename !== "string") throw new Error("npm pack returned no adapter tarball");
	createManifestConsumer(consumerDirectory, manifest, {
		"pi-mcp-adapter": `file:${join(consumerDirectory, filename)}`,
	});

  const lockfile = JSON.parse(readFileSync(join(consumerDirectory, "package-lock.json"), "utf8"));
  for (const { name, tarball } of manifest.packages) {
    const entry = lockfile.packages?.[`node_modules/${name}`];
    if (typeof entry?.resolved !== "string" || !entry.resolved.startsWith("file:")) {
      throw new Error(`Pi package did not resolve from a manifest tarball: ${name}`);
    }
	const resolvedTarball = fileURLToPath(
		new URL(entry.resolved, pathToFileURL(`${resolve(consumerDirectory)}/`)),
	);
	if (resolvedTarball !== tarball) {
      throw new Error(`Pi package resolved from the wrong manifest tarball: ${name}`);
    }
  }
  const probePath = join(consumerDirectory, "verify-sdk.mjs");
  writeFileSync(
    probePath,
    [
      'import { ModelRegistry } from "@earendil-works/pi-coding-agent";',
      'import { completeSimple } from "@earendil-works/pi-ai/compat";',
      'import { Text } from "@earendil-works/pi-tui";',
      'if (typeof ModelRegistry !== "function" || typeof completeSimple !== "function" || typeof Text !== "function") {',
      '  throw new Error("private Pi SDK capability probe failed");',
      "}",
    ].join("\n"),
  );
  run(process.execPath, [probePath], { cwd: consumerDirectory });
}

const { piDir, piRef, keepTemp } = parseArguments(process.argv.slice(2));
const fixture = createLocalForkFixture({ ref: piRef, piDirectory: piDir, prefix: "pi-local-fork-" });
const tempRoot = fixture.root;
const projectCopy = fixture.projectDirectory;
let passed = false;

try {
	const manifest = fixture.manifest;
  if (manifest.capabilities?.extensionSdkApiVersion !== 1) {
    throw new Error("Pi SDK manifest requires extension SDK API version 1");
  }
  cpSync(projectDir, projectCopy, {
    recursive: true,
    filter: (source) => !excludedPaths.has(basename(source)),
  });

  // The project sits beside the archived checkout before npm resolves its file: dev dependencies.
  run(npm, ["ci", "--ignore-scripts", "--prefix", projectCopy]);
  verifyManifestConsumer(join(tempRoot, "consumer"), manifest);
  run(npm, ["test", "--prefix", projectCopy]);

  for (const packageName of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    installPoisonPackage(projectCopy, packageName);
  }
  const loaderProbe = join(tempRoot, "verify-loader.mjs");
  const hostEntry = pathToFileURL(join(tempRoot, "pi/packages/coding-agent/dist/index.js")).href;
  writeFileSync(
    loaderProbe,
    [
      `import { discoverAndLoadExtensions } from ${JSON.stringify(hostEntry)};`,
      `const result = await discoverAndLoadExtensions([${JSON.stringify(join(projectCopy, "index.ts"))}], ${JSON.stringify(projectCopy)}, ${JSON.stringify(join(tempRoot, "agent"))});`,
      'if (result.errors.length > 0 || result.extensions.length !== 1) throw new Error(result.errors.map((entry) => entry.error).join("; "));',
    ].join("\n"),
  );
  run(process.execPath, [loaderProbe], { cwd: projectCopy });
  passed = true;
  console.log(`Pi fork compatibility passed at ${manifest.forkCommit}.`);
} finally {
  if (passed || !keepTemp) {
    rmSync(tempRoot, { force: true, recursive: true });
  } else {
    console.error(`Pi fork compatibility failed; temporary directory retained at ${tempRoot}`);
  }
}
