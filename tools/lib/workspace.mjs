import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..', '..');

const WORKSPACE_PREFIXES = [
  'apps/',
  'packages/contracts/',
  'packages/shared/',
  'packages/renderer/',
  'packages/editor/',
  'packages/lander/',
  'packages/content/',
  'packages/extensions/',
  'examples/',
];

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'storybook-static',
  'tmp',
]);

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function relativeToRepo(targetPath) {
  return toPosix(path.relative(repoRoot, targetPath));
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function resetDir(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, 'utf8'));
}

export async function writeJson(targetPath, data) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeText(targetPath, data) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, data, 'utf8');
}

export function classifyWorkspace(relativePath) {
  const normalized = toPosix(relativePath);
  if (normalized.startsWith('apps/client/')) {
    return 'app';
  }
  if (normalized.startsWith('apps/')) {
    return 'app';
  }
  if (normalized.startsWith('packages/contracts/')) {
    return 'contract';
  }
  if (normalized.startsWith('packages/shared/')) {
    return 'shared';
  }
  if (normalized.startsWith('packages/renderer/')) {
    return 'renderer';
  }
  if (normalized.startsWith('packages/editor/')) {
    return 'editor';
  }
  if (normalized.startsWith('packages/lander/')) {
    return 'lander';
  }
  if (normalized.startsWith('packages/content/')) {
    return 'content';
  }
  if (normalized.startsWith('packages/extensions/')) {
    return 'extension';
  }
  if (normalized.startsWith('examples/')) {
    return 'example';
  }
  return 'other';
}

export function isWorkspaceDir(relativePath) {
  return WORKSPACE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export async function collectWorkspacePackageJsonPaths() {
  const results = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.changeset') {
        if (entry.name === '.git' || entry.name === '.github') {
          continue;
        }
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = relativeToRepo(absolutePath);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (relativePath.startsWith('artifacts/')) {
          continue;
        }
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile() || entry.name !== 'package.json') {
        continue;
      }

      const packageRelativeDir = relativeToRepo(path.dirname(absolutePath));
      if (!isWorkspaceDir(`${packageRelativeDir}/`)) {
        continue;
      }

      results.push(absolutePath);
    }
  }

  await visit(repoRoot);
  return results.sort((a, b) => relativeToRepo(a).localeCompare(relativeToRepo(b)));
}

export async function loadWorkspacePackages() {
  const packageJsonPaths = await collectWorkspacePackageJsonPaths();
  const packages = [];
  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = await readJson(packageJsonPath);
    const dir = path.dirname(packageJsonPath);
    const relativeDir = relativeToRepo(dir);
    packages.push({
      dir,
      relativeDir,
      packageJsonPath,
      packageJson,
      category: classifyWorkspace(`${relativeDir}/`),
      publishable: packageJson.private !== true,
    });
  }
  return packages;
}

export async function hashFile(targetPath, algorithm = 'sha256') {
  const data = await fs.readFile(targetPath);
  return createHash(algorithm).update(data).digest('hex');
}

export async function hashBuffer(value, algorithm = 'sha256') {
  return createHash(algorithm).update(value).digest('hex');
}

export async function collectFiles(startDir, options = {}) {
  const {
    extensions = null,
    includeDotFiles = false,
    skip = new Set(),
  } = options;
  const output = [];

  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!includeDotFiles && entry.name.startsWith('.')) {
        continue;
      }
      if (skip.has(entry.name) || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (extensions && !extensions.has(path.extname(entry.name))) {
        continue;
      }
      output.push(absolutePath);
    }
  }

  if (await pathExists(startDir)) {
    await visit(startDir);
  }
  return output.sort((a, b) => relativeToRepo(a).localeCompare(relativeToRepo(b)));
}

export function looksLikeExtensionManifest(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.packageName === 'string' &&
      typeof value.version === 'string' &&
      typeof value.manifestVersion === 'number' &&
      value.compatibility &&
      typeof value.compatibility === 'object',
  );
}

export async function loadExtensionManifestForPackage(workspacePackage) {
  const manifestExport = workspacePackage.packageJson.exports?.['./manifest'];
  if (!manifestExport) {
    return null;
  }

  const importTarget = typeof manifestExport === 'string'
    ? manifestExport
    : manifestExport.import || manifestExport.default || manifestExport.require;

  if (!importTarget) {
    return null;
  }

  const manifestPath = path.resolve(workspacePackage.dir, importTarget);
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  const manifestModule = await import(pathToFileURL(manifestPath).href);
  if (looksLikeExtensionManifest(manifestModule.default)) {
    return manifestModule.default;
  }

  for (const exportedValue of Object.values(manifestModule)) {
    if (looksLikeExtensionManifest(exportedValue)) {
      return exportedValue;
    }
  }

  return null;
}

export function parseVersion(version) {
  const clean = String(version).trim().replace(/^v/, '').split('-')[0];
  const [major = '0', minor = '0', patch = '0'] = clean.split('.');
  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0,
    patch: Number.parseInt(patch, 10) || 0,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

export function satisfiesRange(version, range) {
  if (!range || range === '*') {
    return true;
  }

  const parts = String(range)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.every((part) => satisfiesSingleComparator(version, part));
}

function satisfiesSingleComparator(version, comparator) {
  if (comparator.startsWith('>=')) {
    return compareVersions(version, comparator.slice(2)) >= 0;
  }
  if (comparator.startsWith('<=')) {
    return compareVersions(version, comparator.slice(2)) <= 0;
  }
  if (comparator.startsWith('>')) {
    return compareVersions(version, comparator.slice(1)) > 0;
  }
  if (comparator.startsWith('<')) {
    return compareVersions(version, comparator.slice(1)) < 0;
  }
  if (comparator.startsWith('^')) {
    const base = parseVersion(comparator.slice(1));
    const current = parseVersion(version);
    if (current.major !== base.major) {
      return false;
    }
    return compareVersions(version, comparator.slice(1)) >= 0;
  }
  if (comparator.startsWith('~')) {
    const base = parseVersion(comparator.slice(1));
    const current = parseVersion(version);
    if (current.major !== base.major || current.minor !== base.minor) {
      return false;
    }
    return compareVersions(version, comparator.slice(1)) >= 0;
  }
  return compareVersions(version, comparator) === 0;
}

export function normalizeLabel(label) {
  if (typeof label === 'string') {
    return label;
  }
  if (!label || typeof label !== 'object') {
    return '';
  }
  return label.defaultMessage || label.id || '';
}

export async function copyRecursive(source, destination) {
  await ensureDir(path.dirname(destination));
  await fs.cp(source, destination, { recursive: true });
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, 'utf8');
}

export function isCliEntry(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  return fileURLToPath(importMetaUrl) === path.resolve(process.argv[1]);
}

export function getWorkspaceByName(workspaces) {
  const map = new Map();
  for (const workspacePackage of workspaces) {
    if (workspacePackage.packageJson.name) {
      map.set(workspacePackage.packageJson.name, workspacePackage);
    }
  }
  return map;
}

export function getWorkspaceByDir(workspaces) {
  return new Map(workspaces.map((workspacePackage) => [workspacePackage.dir, workspacePackage]));
}

export function findOwningWorkspace(workspaces, absolutePath) {
  const normalizedPath = path.resolve(absolutePath);
  let bestMatch = null;
  for (const workspacePackage of workspaces) {
    const candidateDir = `${path.resolve(workspacePackage.dir)}${path.sep}`;
    if (normalizedPath.startsWith(candidateDir)) {
      if (!bestMatch || candidateDir.length > `${path.resolve(bestMatch.dir)}${path.sep}`.length) {
        bestMatch = workspacePackage;
      }
    }
  }
  return bestMatch;
}
