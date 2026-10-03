import fs from 'node:fs';

const repo =
  process.env.GITHUB_REPOSITORY;

if (!repo) {
  throw new Error(
    'GITHUB_REPOSITORY is required',
  );
}

const baseManifest =
  JSON.parse(
    fs.readFileSync(
      'base/.dist/plugins.json',
      'utf8',
    ),
  );

const plugin =
  baseManifest.find(
    (p) => p.id === 'novelpiaglobal',
  );

if (!plugin) {
  throw new Error(
    'Novelpia Global was not generated',
  );
}

const version = String(
  plugin.version || '2.0.0',
);

const target = {
  ...plugin,

  url:
    `https://raw.githubusercontent.com/${repo}/main/.dist/plugins/english/novelpiaglobal-v${version}.js`,

  iconUrl:
    `https://raw.githubusercontent.com/${repo}/main/.dist/static/src/en/novelpiaglobal/icon.png`,
};

fs.mkdirSync(
  '.dist/plugins/english',
  {
    recursive: true,
  },
);

fs.mkdirSync(
  '.dist/static/src/en/novelpiaglobal',
  {
    recursive: true,
  },
);

const compiled =
  fs.readFileSync(
    'base/.js/plugins/english/novelpiaglobal.js',
  );

fs.writeFileSync(
  `.dist/plugins/english/novelpiaglobal-v${version}.js`,
  compiled,
);

fs.copyFileSync(
  'public/static/src/en/novelpiaglobal/icon.png',
  '.dist/static/src/en/novelpiaglobal/icon.png',
);

const manifest = [target];

fs.writeFileSync(
  '.dist/plugins.json',
  JSON.stringify(
    manifest,
    null,
    2,
  ) + '\n',
);

fs.writeFileSync(
  '.dist/plugins.min.json',
  JSON.stringify(manifest) + '\n',
);

console.log(
  JSON.stringify(
    target,
    null,
    2,
  ),
);
