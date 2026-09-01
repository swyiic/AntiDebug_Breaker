import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(toolDirectory, '..');
const distributionDirectory = path.join(projectDirectory, 'dist');
const outputDirectory = path.join(distributionDirectory, 'firefox');
const sourceManifestPath = path.join(projectDirectory, 'manifest.firefox.json');

const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.background?.scripts?.length) {
    throw new Error('manifest.firefox.json 不是有效的 Firefox Manifest V3 清单');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const rootFiles = [
    'api-analyzer.js',
    'background.js',
    'content.js',
    'discovery-engine.js',
    'firefox-compat.js',
    'mcp-client.js',
    'scripts.json'
];
const directories = ['devtools', 'icons', 'popup', 'scripts'];

for (const file of rootFiles) {
    await cp(path.join(projectDirectory, file), path.join(outputDirectory, file));
}
for (const directory of directories) {
    await cp(path.join(projectDirectory, directory), path.join(outputDirectory, directory), {
        recursive: true,
        filter: source => path.basename(source) !== '.DS_Store'
    });
}

await writeFile(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
);

const packageName = `antidebug-breaker-firefox-${manifest.version}.xpi`;
const packagePath = path.join(distributionDirectory, packageName);
await rm(packagePath, { force: true });
execFileSync('/usr/bin/zip', ['-q', '-r', packagePath, '.'], {
    cwd: outputDirectory,
    stdio: 'inherit'
});

console.log(`Firefox 扩展目录: ${outputDirectory}`);
console.log(`Firefox XPI: ${packagePath}`);
