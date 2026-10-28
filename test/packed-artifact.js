'use strict';

const assert = require('node:assert/strict');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPythServer, testEnv } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pyth-packed-test-'));
  const mock = await createMockPythServer();
  try {
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: ROOT });
    const pack = JSON.parse(packOutput)[0];
    const archive = path.join(temporary, pack.filename);
    const installRoot = path.join(temporary, 'install');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, archive], { cwd: ROOT });
    const packedRoot = path.join(installRoot, 'node_modules', 'pyth-mcp');
    assert.ok(fs.existsSync(path.join(packedRoot, 'bin', 'cli.js')));
    assert.ok(fs.existsSync(path.join(packedRoot, 'mcp-server.js')));
    const pkg = require(path.join(packedRoot, 'package.json'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.scripts.postinstall, undefined);
    const api = require(packedRoot);
    assert.equal(api.decimalValue('6700025000000', -8, 'price').text, '67000.25');
    assert.equal(api.MAJOR_FEEDS.length, 5);
    const root = path.join(temporary, 'state');
    const { stdout: output } = await promisify(execFile)(process.execPath, [path.join(packedRoot, 'bin', 'cli.js'), 'get-price', 'BTC/USD', '--json'], {
      cwd: ROOT,
      env: testEnv(root, mock.url),
      timeout: 15000,
    });
    const quote = JSON.parse(output);
    assert.equal(quote.price, 67000.25);
    assert.equal(quote.confidence, 12.5);
    console.log(`PASS packed artifact installs and executes without scripts`);
    console.log(`PACK ${pack.filename} ${pack.entryCount} files ${pack.unpackedSize} bytes`);
    console.log('RESULT 2/2 packed artifact checks passed');
  } finally {
    await mock.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
