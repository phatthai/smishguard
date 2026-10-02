'use strict';

// Container HEALTHCHECK: exits 0 when the API answers /health with HTTP 200.
const http = require('node:http');

const port = Number(process.env.PORT) || 3000;
const request = http.get({ host: 'localhost', port, path: '/health', timeout: 2000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => process.exit(1));
