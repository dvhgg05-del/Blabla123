import fs from 'node:fs';
import path from 'node:path';

const outputRoot = path.resolve('.dist');
const baseManifestPath = process.env.BASE_MANIFEST;
const base = JSON.parse(fs.readFileSync(baseManifestPath, 'utf8'));
const item = base.find(x => x.id === 'novelpiaglobal');
if (!item) throw new Error('Built manifest did not contain novelpiaglobal');

const repo = process.env.GITHUB_REPOSITORY;
const ref = process.env.PUBLISH_REF || 'main';
const root = `https://raw.githubusercontent.com/${repo}/${ref}`;

const published = [{
  id: item.id,
  name: item.name,
  site: item.site,
  lang: item.lang,
  version: item.version,
  url: `${root}/.dist/plugins/english/novelpiaglobal.js`,
  iconUrl: `${root}/.dist/static/src/en/novelpiaglobal/icon.png`,
}];

fs.mkdirSync(path.join(outputRoot, 'plugins/english'), { recursive: true });
fs.mkdirSync(path.join(outputRoot, 'static/src/en/novelpiaglobal'), { recursive: true });
fs.copyFileSync(
  path.resolve(process.env.BASE_DIST, 'plugins/english/novelpiaglobal.js'),
  path.join(outputRoot, 'plugins/english/novelpiaglobal.js'),
);

const sourceIcon = path.resolve('public/static/src/en/novelpiaglobal/icon.png');
fs.copyFileSync(
  sourceIcon,
  path.join(outputRoot, 'static/src/en/novelpiaglobal/icon.png'),
);

fs.writeFileSync(
  path.join(outputRoot, 'plugins.min.json'),
  JSON.stringify(published),
);
fs.writeFileSync(
  path.join(outputRoot, 'plugins.json'),
  JSON.stringify(published, null, 2) + '\n',
);
