/**
 * cleanup-scheduled.js
 * Cancels ALL pre-scheduled messages from the Task Monitor bot across all channels.
 * Handles rate limiting automatically with retries and delays.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

if (!SLACK_BOT_TOKEN) {
  console.error('ERROR: SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function slackGet(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

async function slackPost(method, body = {}) {
  const maxRetries = 6;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('Retry-After') || '10') + 2) * 1000;
      console.log(`  ⏳ Rate limited — waiting ${wait/1000}s...`);
      await sleep(wait);
      continue;
    }

    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'ratelimited') {
        const wait = Math.pow(2, attempt) * 3000;
        console.log(`  ⏳ Rate limited — waiting ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      // Invalid/already-sent messages are fine — just skip
      if (data.error === 'invalid_scheduled_message_id' ||
          data.error === 'not_found' ||
          data.error === 'message_not_found') {
        return { ok: true, skipped: true };
      }
      throw new Error(`${method}: ${data.error}`);
    }
    return data;
  }
  throw new Error(`${method} failed after ${maxRetries} retries`);
}

async function getAllScheduledMessages() {
  const allMessages = [];
  let cursor = undefined;
  let page = 1;

  console.log('Fetching all scheduled messages...');
  while (true) {
    const params = { limit: '100' };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('chat.scheduledMessages.list', params);
    const messages = data.scheduled_messages || [];
    allMessages.push(...messages);
    console.log(`  Page ${page}: found ${messages.length} messages (total: ${allMessages.length})`);

    if (!data.response_metadata?.next_cursor) break;
    cursor = data.response_metadata.next_cursor;
    page++;
    await sleep(1000);
  }

  return allMessages;
}

async function main() {
  console.log('=== Slack Scheduled Message Cleanup ===');
  console.log(`Time: ${new Date().toISOString()}\n`);

  const messages = await getAllScheduledMessages();

  if (messages.length === 0) {
    console.log('✅ No scheduled messages found — queue is already clean!');
    return;
  }

  console.log(`\nFound ${messages.length} scheduled message(s) to cancel.\n`);

  let cancelled = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const progress = `[${i + 1}/${messages.length}]`;

    try {
      const result = await slackPost('chat.deleteScheduledMessage', {
        channel: msg.channel_id,
        scheduled_message_id: msg.id
      });

      if (result.skipped) {
        console.log(`${progress} ⚠ Already sent/expired — skipped (channel: ${msg.channel_id})`);
        skipped++;
      } else {
        console.log(`${progress} ✓ Cancelled — channel: ${msg.channel_id}, scheduled: ${new Date(msg.post_at * 1000).toLocaleDateString()}`);
        cancelled++;
      }
    } catch (e) {
      console.log(`${progress} ✗ Failed — ${e.message}`);
      failed++;
    }

    // Pace requests to avoid rate limits: 1 per second
    await sleep(1100);
  }

  console.log(`\n=== Done ===`);
  console.log(`✓ Cancelled: ${cancelled}`);
  console.log(`⚠ Skipped (already sent): ${skipped}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`Total processed: ${messages.length}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
