import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  isCliEntry,
  loadWorkspacePackages,
  relativeToRepo,
  repoRoot,
  writeJson,
} from '../lib/workspace.mjs';
import { buildPackagePublishGraph } from './build-publish-graph.mjs';

const DEFAULT_MANAGER = process.env.npm_execpath?.includes('pnpm') ? 'pnpm' : 'npm';
const planOnly = process.argv.includes('--plan') || process.env.PUBLISH_VERIFY_PLAN_ONLY === 'true';

function packageManager() {
  return process.env.PUBLISH_VERIFY_PACKAGE_MANAGER || DEFAULT_MANAGER;
}

function commandFor(manager) {
  if (process.platform !== 'win32') {
    return manager;
  }
  return manager.endsWith('.cmd') ? manager : `${manager}.cmd`;
}

function scriptFor(workspacePackage, phase) {
  const scripts = workspacePackage.packageJson.scripts ?? {};
  if (phase === 'prepare') {
    if (scripts.prepack) return 'prepack';
    if (scripts.build) return 'build';
    return null;
  }
  if (phase === 'test') {
    if (scripts['test:run']) return 'test:run';
    if (scripts.test) return 'test';
    return null;
  }
  return null;
}

function runScript(workspacePackage, scriptName, manager) {
  const args = manager === 'pnpm'
    ? ['--filter', workspacePackage.packageJson.name, 'run', scriptName]
    : ['run', scriptName, '-w', workspacePackage.packageJson.name];

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(commandFor(manager), args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        script: scriptName,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        ok: code === 0,
        script: scriptName,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        signal,
      });
    });
  });
}

export async function verifyPublishPackages() {
  const manager = packageManager();
  const workspaces = await loadWorkspacePackages();
  const publishGraph = buildPackagePublishGraph(workspaces);
  const releaseRoot = path.join(repoRoot, 'artifacts', 'releases', 'latest');
  await ensureDir(releaseRoot);

  const results = [];
  const failures = [];

  if (!publishGraph.ok) {
    failures.push({
      phase: 'publish-graph',
      message: 'Publish graph contains cycles or missing internal dependencies.',
      cycleNodes: publishGraph.cycleNodes,
      missingInternalDependencies: publishGraph.missingInternalDependencies,
    });
  }

  for (const phase of ['prepare', 'test']) {
    for (const workspacePackage of publishGraph.orderedPackages) {
      const scriptName = scriptFor(workspacePackage, phase);
      const result = {
        phase,
        packageName: workspacePackage.packageJson.name,
        path: workspacePackage.relativeDir,
        script: scriptName,
        skipped: scriptName === null,
        planned: planOnly && scriptName !== null,
        ok: true,
      };

      if (scriptName === null || planOnly) {
        results.push(result);
        continue;
      }

      console.log(`Running ${phase} verification for ${workspacePackage.packageJson.name}: ${scriptName}`);
      const scriptResult = await runScript(workspacePackage, scriptName, manager);
      Object.assign(result, scriptResult);
      results.push(result);
      if (!result.ok) {
        failures.push(result);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    generator: relativeToRepo(fileURLToPath(import.meta.url)),
    ok: publishGraph.ok && failures.length === 0,
    packageManager: manager,
    planOnly,
    publishGraph: {
      ok: publishGraph.ok,
      order: publishGraph.order,
      edges: publishGraph.edges,
      cycleNodes: publishGraph.cycleNodes,
      missingInternalDependencies: publishGraph.missingInternalDependencies,
    },
    results,
    failures,
  };

  await writeJson(path.join(releaseRoot, 'package-publish-verification.json'), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const report = await verifyPublishPackages();
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
