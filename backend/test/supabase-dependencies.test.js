import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(backendRoot, 'package.json'), 'utf8'));

test('backend uses a pinned Supabase SDK and no direct PostgreSQL driver', () => {
  assert.match(packageJson.dependencies['@supabase/supabase-js'], /^\d+\.\d+\.\d+$/);
  assert.equal(Object.hasOwn(packageJson.dependencies, 'pg'), false);
});
