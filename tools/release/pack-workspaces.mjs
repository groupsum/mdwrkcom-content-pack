import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  ensureDir,
  isCliEntry,
  loadWorkspacePackages,
  repoRoot,
  writeJson,
} from '../lib/workspace.mjs';
import { buildPackagePublishGraph } from './build-publish-graph.mjs';

const execFileAsync = promisify(execFile);

function shouldPack(workspacePackage) {
  if (!workspacePackage.publishable) {
    return false;
  }
  if (workspacePackage.category === 'example') {
    return false;
  }
  return true;
}

export async function packWorkspaces() {
  const workspaces = await loadWorkspacePackages();
  const publishGraph = buildPackagePublishGraph(workspaces, { targetPredicate: shouldPack });
  const packTargets = publishGraph.orderedPackages;
  const outputDir = path.join(repoRoot, 'artifacts', 'packs');
  await ensureDir(outputDir);

  const results = [];
  const failures = [];

  for (const workspacePackage of packTargets) {
    try {
      const { stdout } = await execFileAsync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDir],
        { cwd: workspacePackage.dir, env: process.env },
      );
      const parsed = JSON.parse(stdout);
      results.push({
        packageName: workspacePackage.packageJson.name,
        path: workspacePackage.relativeDir,
        packed: parsed,
      });
    } catch (error) {
      failures.push({
        packageName: workspacePackage.packageJson.name,
        path: workspacePackage.relativeDir,
        message: error.message,
        stdout: error.stdout ?? null,
        stderr: error.stderr ?? null,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    ok: publishGraph.ok && failures.length === 0,
    publishGraph: {
      ok: publishGraph.ok,
      order: publishGraph.order,
      edges: publishGraph.edges,
      cycleNodes: publishGraph.cycleNodes,
      missingInternalDependencies: publishGraph.missingInternalDependencies,
    },
    packed: results,
    failures,
  };
  await writeJson(path.join(outputDir, 'pack-report.json'), report);
  return report;
}

async function main() {
  const report = await packWorkspaces();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
