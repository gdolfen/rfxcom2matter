import * as fs from 'fs';
import * as path from 'path';

let cached: string | null = null;

/**
 * Returns the version of this build. Priority:
 *  1. /app/version.txt written by the Docker build (ARG VERSION, set from the
 *     git tag by the GitHub Action).
 *  2. package.json "version" (fallback for local runs / tests).
 *  3. "dev" as last resort.
 */
function resolveProjectFile(name: string): string | null {
  let dir = __dirname;
  for (;;) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const base of [process.cwd(), '/app']) {
    const f = path.join(base, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function getVersion(): string {
  if (cached) return cached;
  try {
    const file = resolveProjectFile('version.txt');
    if (file) {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) {
        cached = v;
        return cached;
      }
    }
  } catch {
    // fall through to package.json
  }
  try {
    const pkgFile = resolveProjectFile('package.json');
    if (pkgFile) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { version?: string };
      cached = pkg.version || 'dev';
    } else {
      cached = 'dev';
    }
  } catch {
    cached = 'dev';
  }
  return cached;
}