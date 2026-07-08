const https = require('https');
const { config } = require('./configStore');

/**
 * Sends a push notification via ntfy.sh (https://ntfy.sh) so reminders reach
 * phones that can't get WhatsApp notifications (i.e. the account the bot runs
 * on — WhatsApp never notifies you about your own messages).
 *
 * Uses ntfy's JSON endpoint because titles/messages contain emoji, which
 * Node's HTTP layer rejects in headers.
 *
 * Fire-and-forget: failures are logged but never break the WhatsApp flow.
 * Disabled unless `ntfyTopic` is set in config.json.
 */
function notify(title, message) {
  const topic = config.ntfyTopic;
  if (!topic) return;

  // WhatsApp markdown (*bold* / _italic_) reads as noise in a push notification.
  const clean = (s) => String(s).replace(/[*_]/g, '');

  const body = Buffer.from(
    JSON.stringify({
      topic,
      title: clean(title),
      message: clean(message),
      tags: ['dog'],
    }),
    'utf8'
  );

  const req = https.request(
    {
      hostname: 'ntfy.sh',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
      timeout: 10000,
    },
    (res) => res.resume() // drain so the socket is freed
  );
  req.on('error', (err) => console.error('[notify] ntfy push failed:', err.message));
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.write(body);
  req.end();
}

module.exports = { notify };
