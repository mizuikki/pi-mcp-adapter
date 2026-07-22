import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const excludedPaths = new Set([".git", ".worktrees", "dist", "node_modules", "package-lock.json"]);

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function parseArguments(args) {
  let piDir;
  let piRef;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--pi-dir" || argument === "--pi-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--pi-dir") piDir = resolve(value);
      if (argument === "--pi-ref") piRef = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: npm run test:pi-fork -- --pi-dir <pi-checkout> --pi-ref <git-ref>");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!piDir || !piRef) {
    throw new Error("Both --pi-dir and --pi-ref are required");
  }
  if (!existsSync(join(piDir, ".git"))) {
    throw new Error(`--pi-dir is not a git checkout: ${piDir}`);
  }

  return { piDir, piRef };
}

function writeCapabilityProbe(probePath) {
  writeFileSync(
    probePath,
    [
      'import { fileURLToPath } from "node:url";',
      'import { resolve, sep } from "node:path";',
      "",
      "const projectDir = resolve(process.env.PROJECT_COPY_DIR);",
      "const packageRoot = `${projectDir}${sep}node_modules${sep}`;",
      "const packages = [",
      '  "@earendil-works/pi-ai",',
      '  "@earendil-works/pi-agent-core",',
      '  "@earendil-works/pi-coding-agent",',
      '  "@earendil-works/pi-tui",',
      "];",
      "",
      "for (const specifier of packages) {",
      "  const resolved = await import.meta.resolve(specifier);",
      "  const resolvedPath = fileURLToPath(resolved);",
      "  console.log(`resolved ${specifier}: ${resolved}`);",
      "  if (!resolvedPath.startsWith(packageRoot)) {",
      "    throw new Error(`module resolved outside isolated project: ${specifier} -> ${resolvedPath}`);",
      "  }",
      "}",
      "",
      'const codingAgent = await import("@earendil-works/pi-coding-agent");',
      'const aiCompat = await import("@earendil-works/pi-ai/compat");',
      'const tui = await import("@earendil-works/pi-tui");',
      'if (typeof codingAgent.ModelRegistry !== "function") {',
      '  throw new Error("ModelRegistry export missing from Pi coding agent");',
      "}",
      'if (typeof aiCompat.completeSimple !== "function") {',
      '  throw new Error("completeSimple export missing from Pi AI compat module");',
      "}",
      'for (const exportName of ["Text", "matchesKey", "truncateToWidth", "visibleWidth"]) {',
      '  if (typeof tui[exportName] !== "function") {',
      '    throw new Error(`${exportName} export missing from Pi TUI`);',
      "  }",
      "}",
      'console.log("capability probe: Pi AI compat, ModelRegistry, and TUI runtime exports confirmed");',
      "",
    ].join("\n"),
  );
}

function pinPackedPiDependencies(projectPath, packedPackages) {
  const packageJsonPath = join(projectPath, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  for (const { name, tarball } of packedPackages) {
    const dependencyGroup = Object.hasOwn(packageJson.dependencies ?? {}, name)
      ? packageJson.dependencies
      : (packageJson.devDependencies ??= {});
    dependencyGroup[name] = `file:${tarball}`;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function verifyPackedPiDependencies(projectPath, packedPackages) {
  const lockfile = JSON.parse(readFileSync(join(projectPath, "package-lock.json"), "utf8"));

  for (const { name, tarball } of packedPackages) {
    const lockEntry = lockfile.packages?.[`node_modules/${name}`];
    if (typeof lockEntry?.resolved !== "string" || !lockEntry.resolved.startsWith("file:")) {
      throw new Error(`Pi package did not resolve from a local tarball: ${name}`);
    }
    const resolvedTarball = resolve(projectPath, decodeURIComponent(lockEntry.resolved.slice("file:".length)));
    if (resolvedTarball !== tarball) {
      throw new Error(`Pi package resolved from the wrong tarball: ${name} -> ${resolvedTarball}`);
    }
    console.log(`packed ${name}: ${lockEntry.resolved}`);
  }
}

const { piDir, piRef } = parseArguments(process.argv.slice(2));
const tempRoot = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-fork-"));
const forkDir = join(tempRoot, "pi-fork");
const tarballDir = join(tempRoot, "tarballs");
const projectCopy = join(tempRoot, "project");
let passed = false;

try {
  mkdirSync(forkDir, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });

  const forkCommit = execFileSync("git", ["-C", piDir, "rev-parse", `${piRef}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const checkedOutCommit = execFileSync("git", ["-C", piDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (checkedOutCommit !== forkCommit) {
    throw new Error(`--pi-dir must be checked out at --pi-ref to use its generated AI model data`);
  }
  const archivePath = join(tempRoot, "pi-fork.tar");
  run("git", ["-C", piDir, "archive", "--format=tar", "--output", archivePath, piRef]);
  run("tar", ["-xf", archivePath, "-C", forkDir]);
  console.log(`Pi fork commit: ${forkCommit} (${piRef})`);

  console.log("Installing Pi fork dependencies in the isolated checkout.");
  run(npm, ["ci", "--ignore-scripts", "--prefix", forkDir]);
  run(npm, ["run", "build", "--prefix", join(forkDir, "packages/tui")]);
  // git archive intentionally omits generated model data. Compile the tagged
  // source with the selected checkout's existing snapshot, without refreshing
  // mutable provider catalogs from the network.
  const modelDataSource = join(piDir, "packages/ai/src/providers/data");
  const modelDataDestination = join(forkDir, "packages/ai/src/providers/data");
  if (!existsSync(modelDataSource)) {
    throw new Error(`Generated AI model data is missing from --pi-dir: ${modelDataSource}`);
  }
  cpSync(modelDataSource, modelDataDestination, { recursive: true });
  run(join(forkDir, "node_modules/.bin/tsgo"), ["-p", join(forkDir, "packages/ai/tsconfig.build.json")]);
  cpSync(modelDataDestination, join(forkDir, "packages/ai/dist/providers/data"), { recursive: true });
  run(npm, ["run", "build", "--prefix", join(forkDir, "packages/agent")]);
  run(npm, ["run", "build", "--prefix", join(forkDir, "packages/coding-agent")]);

  const workspaces = ["tui", "ai", "agent", "coding-agent"];
  for (const workspace of workspaces) {
    run(npm, [
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      tarballDir,
    ], { cwd: join(forkDir, "packages", workspace), stdio: "ignore" });
  }

  const packedPackages = workspaces.map((workspace) => {
    const packageDirectory = join(forkDir, "packages", workspace);
    const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    const tarballName = `${packageJson.name.slice(1).replace("/", "-")}-${packageJson.version}.tgz`;
    return { name: packageJson.name, tarball: join(tarballDir, tarballName) };
  });
  for (const { tarball } of packedPackages) {
    if (!existsSync(tarball)) {
      throw new Error(`Expected Pi tarball missing: ${tarball}`);
    }
  }

  cpSync(projectDir, projectCopy, {
    recursive: true,
    filter: (source) => !excludedPaths.has(basename(source)),
  });

  pinPackedPiDependencies(projectCopy, packedPackages);
  console.log("Installing the isolated adapter copy with Pi dependencies pinned to fork tarballs.");
  run(npm, ["install", "--ignore-scripts", "--prefix", projectCopy]);
  verifyPackedPiDependencies(projectCopy, packedPackages);

  const probePath = join(projectCopy, "verify-pi-provenance.mjs");
  writeCapabilityProbe(probePath);
  run(process.execPath, [probePath], {
    env: { ...process.env, PROJECT_COPY_DIR: projectCopy },
  });

  run(npm, ["test", "--prefix", projectCopy]);
  console.log(`Pi fork compatibility passed at ${forkCommit}.`);
  passed = true;
} finally {
  if (passed) {
    rmSync(tempRoot, { force: true, recursive: true });
  } else {
    console.error(`Pi fork compatibility failed; temporary directory retained at ${tempRoot}`);
  }
}
