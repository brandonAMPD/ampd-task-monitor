/**
 * cancel-task.js — one-off cleanup for a single task's pre-scheduled Slack messages.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... node cancel-task.js <taskId>
 *
 * Run this from your repo root (same folder as scheduled-reminders.json).
 * It cancels every Slack scheduled message already queued for that task
 * (whatever channel they were sent to) and removes them from state, so
 * the next `node scan.js` run starts clean and reschedules using the
 * current TEAM_CHANNEL_MAP.
 */

import fs from 'fs';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const STATE_FILE = 'scheduled-reminders.json';
const taskId = process.argv[2];

if (!SLACK_BOT_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN env var.');
  process.exit(1);
}
if (!taskId) {
  console.error('Usage: node cancel-task.js <taskId>');
  process.exit(1);
}

async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'unknown_slack_error');
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const ids = state.scheduledMessageIds?.[taskId] || [];

  if (ids.length === 0) {
    console.log(`No pre-scheduled messages recorded for task ${taskId}.`);
    return;
  }

  console.log(`Found ${ids.length} pre-scheduled message(s) for task ${taskId}. Cancelling...`);
  let cancelled = 0;

  for (const { channel, messageId } of ids) {
    try {
      await slackPost('chat.deleteScheduledMessage', {
        channel,
        scheduled_message_id: messageId
      });
      cancelled++;
      console.log(`  ✓ cancelled ${messageId} on ${channel}`);
    } catch (e) {
      if (e.message.includes('invalid_scheduled_message_id') || e.message.includes('not_found')) {
        console.log(`  – ${messageId} on ${channel} already fired or gone (fine)`);
      } else {
        console.warn(`  ✗ could not cancel ${messageId} on ${channel}: ${e.message}`);
      }
    }
    await sleep(200);
  }

  console.log(`Cancelled ${cancelled}/${ids.length}.`);
  delete state.scheduledMessageIds[taskId];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('State file updated — this task will reschedule fresh (with the new channel map) on the next scan.js run.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
