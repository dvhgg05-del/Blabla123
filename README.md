# Novelpia Global — LNReader v3 plugin

This is a standalone LNReader v3 repository containing a JavaScript Novelpia Global plugin.

## Install in Tsundoku / LNReader

1. Create a public GitHub repository and upload this folder's contents.
2. Replace `YOUR_USERNAME/YOUR_REPO` in `.dist/plugins.min.json` and `.dist/plugins.json` with your GitHub username/repository.
3. In the app, add this manifest URL as a plugin repository:

`https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/.dist/plugins.min.json`

The manifest points the app at the compiled JavaScript plugin under `.dist/plugins/english/`.

## Novelpia login session

The plugin has three optional settings:
- `LOGINAT session token`
- `USERKEY cookie`
- `TKEY cookie`

These correspond to the session values saved by the supplied Novelpia scraper's `.api.json`. They are used as HTTP headers/cookies so the plugin can reuse a user's own Novelpia session.

Do not paste your password into the plugin source or commit session credentials to GitHub.

## Scope

The plugin handles:
- catalog/latest listings
- title search
- novel metadata
- chapter list
- dynamic viewer token extraction
- `/v1/novel/episode/content`
- `epi_content`, `epi_content1`, ... fragment reconstruction
- Novelpia image URL normalization

It does not automate rewarded-ad claims or bypass paid chapter access.

## Testing

`node --check plugins/english/novelpiaglobal.js`

For a full LNReader-repository build, place the file at `plugins/english/novelpiaglobal.js` in the LNReader plugin repo. The repo's current production TypeScript configuration has `allowJs: true`, while the standard contributor workflow normally uses `.ts` files.
