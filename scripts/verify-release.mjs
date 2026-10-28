import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
assert.ok(target, 'Pass the native Rust target triple');
const windows = target.includes('windows');
const archive = path.resolve(`target/distrib/lain-${target}.${windows ? 'zip' : 'tar.xz'}`);
const checksum = (await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), checksum.toLowerCase());
const directory = await mkdtemp(path.join(tmpdir(), 'lain-archive-'));

async function executable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === (windows ? 'lain.exe' : 'lain')) return file;
    if (entry.isDirectory()) {
      const nested = await executable(file);
      if (nested) return nested;
    }
  }
}

try {
  if (windows) {
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(directory)}`], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xJf', archive, '-C', directory], { stdio: 'inherit' });
  }
  const binary = await executable(directory);
  assert.ok(binary, 'Release archive must contain the native executable');
  if (windows) {
    const test = fileURLToPath(new URL('../tests/installer-windows.test.ps1', import.meta.url));
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', test, '-Binary', binary], { stdio: 'inherit' });
  }
  const smoke = fileURLToPath(new URL('../tests/release-smoke.mjs', import.meta.url));
  execFileSync(process.execPath, [smoke, binary], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
