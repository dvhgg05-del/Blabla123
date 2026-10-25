// Publishes every plugin found in ./plugins/english/*.ts (file name == plugin id)
// into ./.dist and writes the manifest the app consumes.
import fs from 'node:fs';
import path from 'node:path';

const outputRoot = path.resolve('.dist');
const base = JSON.parse(fs.readFileSync(process.env.BASE_MANIFEST, 'utf8'));
const builtJsDir = path.resolve(process.env.BASE_DIST, '../.js/plugins/english');

const repo = process.env.GITHUB_REPOSITORY;
const ref = process.env.PUBLISH_REF || 'main';
const root = `https://raw.githubusercontent.com/${repo}/${ref}`;

const ids = fs
  .readdirSync(path.resolve('plugins/english'))
  .filter(file => file.endsWith('.ts'))
  .map(file => file.replace(/\.ts$/, ''))
  .sort();
if (!ids.length) throw new Error('No plugins found in plugins/english');

fs.rmSync(outputRoot, { recursive: true, force: true });

const published = ids.map(id => {
  const item = base.find(x => x.id === id);
  if (!item) throw new Error(`Built manifest did not contain ${id}`);

  const jsDir = path.join(outputRoot, 'plugins/english');
  const iconDir = path.join(outputRoot, `static/src/en/${id}`);
  fs.mkdirSync(jsDir, { recursive: true });
  fs.mkdirSync(iconDir, { recursive: true });
  fs.copyFileSync(path.join(builtJsDir, `${id}.js`), path.join(jsDir, `${id}.js`));
  fs.copyFileSync(
    path.resolve(`public/static/src/en/${id}/icon.png`),
    path.join(iconDir, 'icon.png'),
  );

  return {
    id: item.id,
    name: item.name,
    site: item.site,
    lang: item.lang,
    version: item.version,
    url: `${root}/.dist/plugins/english/${id}.js`,
    iconUrl: `${root}/.dist/static/src/en/${id}/icon.png`,
  };
});

fs.writeFileSync(path.join(outputRoot, 'plugins.min.json'), JSON.stringify(published));
fs.writeFileSync(path.join(outputRoot, 'plugins.json'), JSON.stringify(published, null, 2) + '\n');
console.log(`Published ${published.length} plugin(s): ${ids.join(', ')}`);
