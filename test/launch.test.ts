import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findServer, ownsListener, portTaken } from '../src/launch.ts';
import { serverFile } from '../src/core/paths.ts';
import { FakeWorld } from './fixtures.ts';

let fw: FakeWorld | undefined;
afterEach(() => { fw?.cleanup(); fw = undefined; });

/** Server pid 600 listening on :7399 (socket inode 9100); an unrelated pid 700 listening on :8000. */
function serverWorld(info: object = { pid: 600, procStart: 1600, port: 7399, token: 't' }) {
  const w = new FakeWorld()
    .proc({ pid: 600, comm: 'node', sockets: [9100] })
    .proc({ pid: 700, comm: 'squatter', sockets: [9200] })
    .listen({ 9100: 7399, 9200: 8000 });
  fs.mkdirSync(w.paths.dataDir, { recursive: true });
  fs.writeFileSync(serverFile(w.paths), JSON.stringify(info));
  return w;
}

describe('server identity', () => {
  test('ownsListener is true only for the pid that holds the socket', () => {
    fw = serverWorld();
    assert.equal(ownsListener(600, 7399, fw.paths.procRoot), true);
    assert.equal(ownsListener(600, 8000, fw.paths.procRoot), false);
    assert.equal(ownsListener(700, 7399, fw.paths.procRoot), false);
  });

  test('findServer requires the exact process, and with `listening` that it holds the port', () => {
    fw = serverWorld();
    assert.equal(findServer(fw.paths, { listening: true })?.pid, 600);
  });

  test('a server.json whose pid was recycled is ignored', () => {
    fw = serverWorld({ pid: 600, procStart: 4242, port: 7399, token: 't' });
    assert.equal(findServer(fw.paths), null);
  });

  test('a server.json naming a port someone else holds is not trusted as listening', () => {
    fw = serverWorld({ pid: 600, procStart: 1600, port: 8000, token: 't' });
    assert.ok(findServer(fw.paths), 'the process itself is alive');
    assert.equal(findServer(fw.paths, { listening: true }), null);
  });

  test('portTaken sees listeners of any process', () => {
    fw = serverWorld();
    assert.equal(portTaken(8000, fw.paths.procRoot), true);
    assert.equal(portTaken(8001, fw.paths.procRoot), false);
  });
});
