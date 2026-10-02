'use strict';

const { start } = require('../../src/server');

const baseEnv = { APP_ENV: 'test', PORT: '0', METRICS_PORT: '0', LOG_LEVEL: 'silent', DATABASE_PATH: ':memory:' };

describe('server lifecycle', () => {
  test('starts the API and metrics servers and shuts down gracefully', async () => {
    const instance = await start(baseEnv);
    try {
      const apiPort = instance.server.address().port;
      const metricsPort = instance.metricsServer.address().port;

      const health = await fetch(`http://localhost:${apiPort}/health`);
      expect(health.status).toBe(200);
      const metrics = await fetch(`http://localhost:${metricsPort}/metrics`);
      expect(await metrics.text()).toContain('process_cpu_seconds_total');
    } finally {
      await instance.stop('test');
    }
    await expect(instance.stop('again')).resolves.toBeUndefined();
    expect(instance.server.listening).toBe(false);
  });

  test('fails fast on invalid configuration', async () => {
    await expect(start({ ...baseEnv, APP_ENV: 'production' })).rejects.toThrow(/JWT_SECRET/);
  });

  test('reports a port that is already in use', async () => {
    const first = await start(baseEnv);
    try {
      const port = String(first.server.address().port);
      await expect(start({ ...baseEnv, PORT: port })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.stop();
    }
  });
});
