#!/usr/bin/env node
/**
 * Puts the READMEs, the CHANGELOG and the LICENSE of the repository into
 * plugin/ (the published package), run by npm pack / npm publish (prepack).
 *
 * The Signal K App Store and npm show the README of the package: relative
 * images and links would point inside the package, where docs/ and the
 * repository root are not published. In the copies they point to GitHub, at
 * the commit being published.
 *
 * Usage: node scripts/prepare-npm-package.mjs [--clean]   (GITHUB_SHA, or git HEAD)
 *        --clean removes the copies again (postpack)
 */
import { execSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'laborima/ocearo-core';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');
const READMES = ['README.md', 'README.fr.md'];
const COPIES = ['CHANGELOG.md', 'LICENSE'];

if (process.argv.includes('--clean')) {
    for (const name of [...READMES, ...COPIES]) rmSync(join(PLUGIN, name), { force: true });
    process.exit(0);
}

const ref = process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
const blob = (path) => `https://github.com/${REPO}/${path.endsWith('/') ? 'tree' : 'blob'}/${ref}/${path}`;
const isRelative = (url) => !/^([a-z]+:|#|\/\/)/i.test(url);

export function rewriteReadme(markdown) {
    return markdown
        // Images first (![alt](path)), then links ([text](path))
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
            (m, alt, url) => isRelative(url) ? `![${alt}](${raw(url)})` : m)
        .replace(/(^|[^!])\[([^\]]+)\]\(([^)\s]+)\)/g,
            (m, pre, text, url) => isRelative(url) ? `${pre}[${text}](${blob(url)})` : m)
        // Linked badges: [![alt](image)](path)
        .replace(/\)\]\(([^)\s]+)\)/g,
            (m, url) => isRelative(url) ? `)](${blob(url)})` : m);
}

for (const name of COPIES) copyFileSync(join(ROOT, name), join(PLUGIN, name));
for (const name of READMES) {
    writeFileSync(join(PLUGIN, name), rewriteReadme(readFileSync(join(ROOT, name), 'utf8')));
}
console.log(`READMEs, CHANGELOG and LICENSE in plugin/, README links at ${ref}`);
