/**
 * AMPD Task Monitor — cleanup-scheduled.js
 * One-time script to delete ALL scheduled messages from the Slack bot.
 * Run this manually from GitHub Actions once to clear the queue.
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
  return res.json();
}

async function slackPost(method, body = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function deleteAllScheduledMessages() {
  console.log('=== Slack Scheduled Message Cleanup ===\n');

  let totalDeleted = 0;
  let totalFailed = 0;
  let cursor = undefined;

  // Keep fetching pages until no more scheduled messages
  while (true) {
    console.log('Fetching scheduled messages...');
    const params = { limit: '100' };
    if (cursor) params.cursor = cursor;

    const data = await slackGet('chat.scheduledMessages.list', params);

    if (!data.ok) {
      console.error('Failed to list scheduled messages:', data.error);
      break;
    }

    const messages = data.scheduled_messages || [];
    console.log(`Found ${messages.length} scheduled messages in this page.`);

    if (messages.length === 0) break;

    // Delete each one
    for (const msg of messages) {
      try {
        const result = await slackPost('chat.deleteScheduledMessage', {
          channel: msg.channel_id,
          scheduled_message_id: msg.id
        });

        if (result.ok) {
          totalDeleted++;
          process.stdout.write(`  ✓ Deleted [${totalDeleted}] — channel: ${msg.channel_id}, scheduled for: ${new Date(msg.post_at * 1000).toISOString().split('T')[0]}\n`);
        } else {
          totalFailed++;
          console.log(`  ✗ Failed — ${result.error} (channel: ${msg.channel_id})`);
        }
      } catch (e) {
        totalFailed++;
        console.log(`  ✗ Error — ${e.message}`);
      }

      // Small delay to avoid rate limiting
      await sleep(200);
    }

    // Check for next page
    if (data.response_metadata?.next_cursor) {
      cursor = data.response_metadata.next_cursor;
      console.log('Fetching next page...\n');
    } else {
      break;
    }
  }

  console.log(`\n=== Cleanup Complete ===`);
  console.log(`✓ Deleted: ${totalDeleted}`);
  console.log(`✗ Failed:  ${totalFailed}`);
  console.log('\nAll scheduled messages cleared. You can now run scan.js cleanly.');
}

deleteAllScheduledMessages();
