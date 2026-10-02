'use strict';

/**
 * Sends the pipeline result to the team's Discord channel (the same channel that
 * receives production alerts). Never fails the build: notification problems are logged.
 *   node scripts/ci/notify.js --status SUCCESS|FAILURE|UNSTABLE|ABORTED [--stage <name>] [--duration <text>]
 */
const { info, warn, http, parseArgs, readJson, main } = require('./lib');

const COLOURS = { SUCCESS: 0x1f8f4e, FAILURE: 0xc62828, UNSTABLE: 0xc77700, ABORTED: 0x5d6b7e };

function fields(args) {
  const release = readJson('reports/release.json');
  const list = [
    { name: 'Version', value: process.env.APP_VERSION || 'n/a', inline: true },
    { name: 'Commit', value: (process.env.GIT_COMMIT || 'n/a').slice(0, 7), inline: true },
    { name: 'Duration', value: args.duration || 'n/a', inline: true },
  ];
  if (args.status !== 'SUCCESS' && args.stage) {
    list.push({ name: 'Stopped at stage', value: args.stage, inline: false });
  }
  if (release?.url) {
    list.push({ name: 'Release', value: release.url, inline: false });
  }
  list.push({ name: 'Jenkins', value: process.env.BUILD_URL || 'n/a', inline: false });
  return list;
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const status = String(args.status || 'UNKNOWN').toUpperCase();
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    warn('DISCORD_WEBHOOK_URL not set; skipping build notification');
    return;
  }
  const headline = status === 'SUCCESS' ? 'released to production' : `${status.toLowerCase()}`;
  const res = await http(webhook, {
    method: 'POST',
    body: {
      username: 'SmishGuard Jenkins',
      embeds: [{
        title: `SmishGuard build #${process.env.BUILD_NUMBER || '?'}: ${headline}`,
        color: COLOURS[status] ?? COLOURS.ABORTED,
        fields: fields({ ...args, status }),
        timestamp: new Date().toISOString(),
      }],
    },
  });
  if (res.ok) {
    info(`Build notification sent to Discord (${status})`);
  } else {
    warn(`Discord notification failed with HTTP ${res.status}`);
  }
});
