import { parentPort, workerData } from 'node:worker_threads';

const gate = new Int32Array(workerData.gate);
parentPort.on('message', ({ wavPath }) => {
  if (wavPath === 'crash') process.exit(3);
  if (wavPath === 'hold') {
    Atomics.store(gate, 0, 1);
    workerData.started.postMessage('started');
    Atomics.wait(gate, 1, 0);
  }
  parentPort.postMessage(
    wavPath === 'fail'
      ? { ok: false, error: 'Recognition failed' }
      : { ok: true, result: { content: wavPath, duration: 1, segments: 1 } },
  );
});
