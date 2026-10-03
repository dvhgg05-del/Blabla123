import fs from 'node:fs';
import path from 'node:path';

const outputRoot = path.resolve('.dist');
const baseManifestPath = process.env.BASE_MANIFEST;
const baseDist = process.env.BASE_DIST;
const repo = process.env.GITHUB_REPOSITORY;

if (!baseManifestPath || !baseDist || !repo) {
  throw new Error('BASE_MANIFEST, BASE_DIST and GITHUB_REPOSITORY are required');
}

const base = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
const item = base.find((x) => x.id === 'novelpiaglobal');
if (!item) throw new Error('Built manifest did not contain novelpiaglobal');

const version = item.version;
const versionPath = `versions/v${version}`;
const root = `https://raw.githubusercontent.com/${repo}/main/.dist/${versionPath}`;

const compiledJs = path.join(
  path.resolve(baseDist, '..'),
  '.js',
  'plugins',
  'english',
  'novelpiaglobal.js',
);

const sourceIcon = path.resolve(
  'public/static/src/en/novelpiaglobal/icon.png',
);

if (!fs.existsSync(compiledJs)) {
  throw new Error(`Compiled Novelpia JS not found: ${compiledJs}`);
}
if (!fs.existsSync(sourceIcon)) {
  throw new Error(`Novelpia icon not found: ${sourceIcon}`);
}

const versionRoot = path.join(outputRoot, versionPath);
fs.mkdirSync(versionRoot, { recursive: true });

// Versioned URLs intentionally avoid stale CDN/app caches when a plugin is updated.
fs.copyFileSync(compiledJs, path.join(versionRoot, 'novelpiaglobal.js'));
fs.copyFileSync(sourceIcon, path.join(versionRoot, 'icon.png'));

const published = [{
  id: item.id,
  name: item.name,
  site: item.site,
  lang: item.lang,
  version: item.version,
  url: `${root}/novelpiaglobal.js`,
  iconUrl: `${root}/icon.png`,
}];

fs.writeFileSync(
  path.join(outputRoot, 'plugins.min.json'),
  JSON.stringify(published),
);
fs.writeFileSync(
  path.join(outputRoot, 'plugins.json'),
  JSON.stringify(published, null, 2) + '\n',
);

console.log(JSON.stringify(published[0], null, 2));
