import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';

const sourceDir = new URL('../src/', import.meta.url);
const outputDir = new URL('../dist/', import.meta.url);
await mkdir(outputDir, { recursive: true });

for (const fileName of ['index.ts', 'js-endpoint-analyzer.ts']) {
  const source = await readFile(new URL(fileName, sourceDir), 'utf8');
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
      sourceMap: false
    }
  });
  await writeFile(new URL(fileName.replace(/\.ts$/, '.js'), outputDir), result.outputText);
}

console.error(`[build] emitted ${join('dist', 'index.js')} and ${join('dist', 'js-endpoint-analyzer.js')}`);
