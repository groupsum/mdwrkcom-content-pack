import { isCliEntry, loadWorkspacePackages } from '../lib/workspace.mjs';

const INTERNAL_PACKAGE_PREFIX = '@mdwrk/';
const LOCAL_WORKSPACE_PROTOCOLS = ['workspace:', 'file:', 'link:'];
const EXCLUDED_PUBLISH_WORKSPACE_DIRS = new Set([]);

export function isPublishGraphTarget(workspacePackage) {
  if (!workspacePackage.publishable) {
    return false;
  }
  if (workspacePackage.category === 'example') {
    return false;
  }
  if (EXCLUDED_PUBLISH_WORKSPACE_DIRS.has(workspacePackage.relativeDir)) {
    return false;
  }
  return true;
}

function dependencyEntries(packageJson, includeDevDependencies) {
  const buckets = [
    ['dependencies', packageJson.dependencies],
    ['optionalDependencies', packageJson.optionalDependencies],
    ['peerDependencies', packageJson.peerDependencies],
  ];
  if (includeDevDependencies) {
    buckets.push(['devDependencies', packageJson.devDependencies]);
  }

  return buckets.flatMap(([kind, dependencies]) => {
    if (!dependencies || typeof dependencies !== 'object') {
      return [];
    }
    return Object.entries(dependencies).map(([name, spec]) => ({ name, kind, spec }));
  });
}

function requiresLocalWorkspace(spec) {
  if (typeof spec !== 'string') {
    return false;
  }
  return LOCAL_WORKSPACE_PROTOCOLS.some((prefix) => spec.startsWith(prefix));
}

function topoSort(nodes, edges) {
  const remainingIncoming = new Map(nodes.map((node) => [node.name, 0]));
  const outgoing = new Map(nodes.map((node) => [node.name, []]));

  for (const edge of edges) {
    if (!remainingIncoming.has(edge.from) || !remainingIncoming.has(edge.to)) {
      continue;
    }
    remainingIncoming.set(edge.to, remainingIncoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }

  const ready = nodes
    .filter((node) => remainingIncoming.get(node.name) === 0)
    .map((node) => node.name)
    .sort();
  const ordered = [];

  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(name);
    for (const dependent of outgoing.get(name) ?? []) {
      remainingIncoming.set(dependent, remainingIncoming.get(dependent) - 1);
      if (remainingIncoming.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  const cycleNodes = nodes
    .map((node) => node.name)
    .filter((name) => !ordered.includes(name))
    .sort();

  return { ordered, cycleNodes };
}

export function buildPackagePublishGraph(workspaces, options = {}) {
  const includeDevDependencies = options.includeDevDependencies ?? true;
  const targetPredicate = options.targetPredicate ?? isPublishGraphTarget;
  const workspaceByName = new Map(workspaces.map((workspacePackage) => [workspacePackage.packageJson.name, workspacePackage]));
  const targets = workspaces.filter(targetPredicate);
  const targetNames = new Set(targets.map((workspacePackage) => workspacePackage.packageJson.name));
  const edges = [];
  const missingInternalDependencies = [];

  for (const workspacePackage of targets) {
    for (const dependency of dependencyEntries(workspacePackage.packageJson, includeDevDependencies)) {
      const dependencyWorkspace = workspaceByName.get(dependency.name);
      if (dependencyWorkspace && targetNames.has(dependency.name)) {
        edges.push({
          from: dependency.name,
          to: workspacePackage.packageJson.name,
          kind: dependency.kind,
        });
        continue;
      }
      if (
        !dependencyWorkspace &&
        dependency.name.startsWith(INTERNAL_PACKAGE_PREFIX) &&
        requiresLocalWorkspace(dependency.spec)
      ) {
        missingInternalDependencies.push({
          packageName: workspacePackage.packageJson.name,
          dependencyName: dependency.name,
          dependencyKind: dependency.kind,
          dependencySpec: dependency.spec,
        });
      }
    }
  }

  const nodes = targets.map((workspacePackage) => ({
    name: workspacePackage.packageJson.name,
    version: workspacePackage.packageJson.version,
    path: workspacePackage.relativeDir,
    category: workspacePackage.category,
    hasBuildScript: Boolean(workspacePackage.packageJson.scripts?.build),
  }));
  const { ordered, cycleNodes } = topoSort(nodes, edges);
  const workspacePackageByName = new Map(targets.map((workspacePackage) => [workspacePackage.packageJson.name, workspacePackage]));
  const orderedPackages = ordered.map((name) => workspacePackageByName.get(name)).filter(Boolean);

  return {
    ok: cycleNodes.length === 0 && missingInternalDependencies.length === 0,
    includeDevDependencies,
    nodes,
    edges,
    order: ordered,
    cycleNodes,
    missingInternalDependencies,
    orderedPackages,
  };
}

async function main() {
  const graph = buildPackagePublishGraph(await loadWorkspacePackages());
  const output = {
    ok: graph.ok,
    includeDevDependencies: graph.includeDevDependencies,
    order: graph.order,
    nodes: graph.nodes,
    edges: graph.edges,
    cycleNodes: graph.cycleNodes,
    missingInternalDependencies: graph.missingInternalDependencies,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!graph.ok) {
    process.exitCode = 1;
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
