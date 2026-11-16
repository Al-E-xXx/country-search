import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Copies static assets from src/ to dist/ after tsc has emitted JS.
// Missing assets are reported and skipped so the build never breaks.
const ASSET_FILE_NAMES = ['index.html', 'styles.css'];

const projectRoot = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

await mkdir(distDir, { recursive: true });

let copiedCount = 0;
for (const fileName of ASSET_FILE_NAMES) {
  const sourcePath = path.join(srcDir, fileName);
  try {
    await copyFile(sourcePath, path.join(distDir, fileName));
    copiedCount += 1;
    console.log(`copied src/${fileName} -> dist/${fileName}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.warn(`skipped src/${fileName}: file not found`);
    } else {
      throw error;
    }
  }
}

console.log(`assets copied: ${copiedCount}/${ASSET_FILE_NAMES.length}`);
