/**
 * AMPD Task Monitor — scan.js
 * Reads #ampd-team-tasks, extracts task assignments using Claude AI,
 * then schedules:
 *   1. A Slack DM to the manager (Brandon)
 *   2. A Slack DM to the assignee
 *   3. A message to the assignee's personal #fd- channel (with @mention)
 *
 * Runs every 30 minutes via GitHub Actions.
 * Uses scheduled-reminders.json to deduplicate across runs.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import crypto from 'crypto';

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID || 'C0AQK5D4LD6';
const SLACK_MANAGER_ID  = process.env.SLACK_MANAGER_ID || 'UMS39RAGP';
const LOOKBACK_DAYS     = parseInt(process.env.LOOKBACK_DAYS || '14');
const REMINDER_HOUR_UTC = 14; // 9:00 AM EST = 14:00 UTC

if (!ANTHROPIC_API_KEY || !SLACK_BOT_TOKEN) {
  console.error('ERROR: ANTHROPIC_API_KEY and SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Team channel mapping ─────────────────────────────────────────────────────
// Maps Slack user ID → their personal #fd- channel ID
const TEAM_CHANNEL_MAP = {
  'U023F61R16F': 'C05JGF817H6',  // Mark      → #fd-mark
  'U01M7FMPTRR': 'C08RNTW55JM',  // Chrissy   → #fd-to-do-chrissy
  'U07FVUF09T7': 'C093VPK55NF',  // Josh      → #fd-josh
  'U02LFUG2WLR': 'C05HPPDCSS1',  // Eddie     → #fd-eddie
  'U08D4RE1SKF': 'C097HTJ0Z5G',  // Liz       → #fd-liz
  'U02773FLDN2': 'C097208ALLF',  // Jimmy     → #fd-jimmy
  'UMCPG3D8A':   'C08R493ESAJ',  // Christle  → #fd-christle
  'U05FE9QNFSQ': 'C05HL1VGA22',  // Megan     → #fd-megan
};

// ─── Deduplication state ──────────────────────────────────────────────────────
const STATE_FILE = 'scheduled-reminders.json';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not load state file, starting fresh:', e.message);
  }
  return { scheduled: {}, lastRun: null };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function makeReminderKey(task, reminderType) {
  const raw = [
    task.task.toLowerCase().trim().slice(0, 60),
    (task.assignee_name || '').toLowerCase().trim(),
    task.due_date || 'nodate',
    task.assigned_date || '',
    reminderType
  ].join('|');
  return crypto.createHash('md5').update(raw).digest('hex');
}

function purgeOldState(state) {
  const cutoff = Date.now() - 60 * 86400000;
  let purged = 0;
  for (const [key, entry] of Object.entries(state.scheduled)) {
    if (entry.scheduledAt && new Date(entry.scheduledAt).getTime() < cutoff) {
      delete state.scheduled[key];
      purged++;
    }
  }
  if (purged > 0) console.log(`Purged ${purged} old state entries.`);
}

// ─── Slack helpers ────────────────────────────────────────────────────────────
async function slackGet(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
  return data;
}

async function slackPost(method, body = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
  return data;
}

// ─── Fetch messages ───────────────────────────────────────────────────────────
async function fetchMessages() {
  const oldest = Math.floor(Date.now() / 1000 - LOOKBACK_DAYS * 86400);
  console.log(`Reading #ampd-team-tasks (last ${LOOKBACK_DAYS} days)...`);
  const data = await slackGet('conversations.history', {
    channel: SLACK_CHANNEL_ID,
    oldest: String(oldest),
    limit: '200'
  });
  return data.messages || [];
}

// ─── Build user map ───────────────────────────────────────────────────────────
async function buildUserMap() {
  const data = await slackGet('users.list', { limit: '200' });
  const map = {};
  for (const u of data.members || []) {
    const name = u.profile?.display_name || u.profile?.real_name || u.name;
    map[u.id] = { id: u.id, name };
    if (u.name) map[`@${u.name.toLowerCase()}`] = u.id;
    if (u.profile?.display_name) map[u.profile.display_name.toLowerCase()] = u.id;
    if (u.profile?.real_name) map[u.profile.real_name.toLowerCase()] = u.id;
  }
  return map;
}

function resolveUserId(mention, userMap) {
  if (!mention) return null;
  const idMatch = mention.match(/<@([A-Z0-9]+)>/);
  if (idMatch) return idMatch[1];
  const key = mention.replace(/^@/, '').toLowerCase();
  return userMap[`@${key}`] || userMap[key] || null;
}

// ─── Extract tasks via Claude ─────────────────────────────────────────────────
async function extractTasks(messages, userMap) {
  const today = new Date().toISOString().split('T')[0];

  const enriched = messages.map(m => {
    const date = new Date(parseFloat(m.ts) * 1000).toISOString().split('T')[0];
    const author = userMap[m.user]?.name || m.user || 'unknown';
    const text = (m.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) =>
      `@${userMap[uid]?.name || uid}`
    );
    return `[${date}] ${author}: ${text}`;
  }).join('\n');

  if (!enriched.trim()) return [];

  console.log(`Sending ${messages.length} messages to Claude for task extraction...`);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    system: `You extract task assignments from Slack messages. Today is ${today}.

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "tasks": [
    {
      "task": "brief task description (max 100 chars)",
      "assignee_name": "full name or @handle of person assigned",
      "assignee_slack_mention": "@handle exactly as written, or null",
      "assigned_date": "YYYY-MM-DD",
      "due_date": "YYYY-MM-DD or null if not mentioned",
      "source_message": "first 100 chars of the original message"
    }
  ]
}

Rules:
- Resolve relative dates (e.g. "by Friday", "end of week", "tomorrow") to YYYY-MM-DD from today ${today}
- Include ALL assignments — casual, formal, @mentioned, implied
- Set due_date to null if not mentioned
- Exclude join messages, bot messages, non-task conversation
- assigned_date = date the message was sent`,
    messages: [{ role: 'user', content: `Extract all task assignments:\n\n${enriched}` }]
  });

  const raw = response.content[0].text.replace(/```json|```/g, '').trim();
  try {
    const tasks = JSON.parse(raw).tasks || [];
    console.log(`Claude found ${tasks.length} task(s).`);
    return tasks;
  } catch (e) {
    console.error('Failed to parse Claude response:', raw);
    throw new Error('Claude returned invalid JSON');
  }
}

// ─── Reminder date logic ──────────────────────────────────────────────────────
function calcReminders(task) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const assigned = new Date((task.assigned_date || new Date().toISOString().split('T')[0]) + 'T00:00:00Z');
  const reminders = [];

  if (task.due_date) {
    const due = new Date(task.due_date + 'T00:00:00Z');
    const totalMs = due - assigned;
    if (totalMs > 2 * 86400000) {
      const mid = new Date(assigned.getTime() + totalMs / 2);
      mid.setUTCHours(0, 0, 0, 0);
      if (mid >= today) reminders.push({ type: 'midpoint', date: mid });
    }
    if (due >= today) reminders.push({ type: 'due', date: due });
  } else {
    const followUp = new Date(assigned.getTime() + 7 * 86400000);
    followUp.setUTCHours(0, 0, 0, 0);
    if (followUp >= today) reminders.push({ type: 'followup', date: followUp });
  }
  return reminders;
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

// ─── Schedule reminders ───────────────────────────────────────────────────────
async function scheduleRemindersForTask(task, userMap, state) {
  const reminders = calcReminders(task);
  if (reminders.length === 0) {
    console.log(`  → No upcoming reminders for: "${task.task}"`);
    return;
  }

  const assigneeId = resolveUserId(task.assignee_slack_mention, userMap)
    || resolveUserId(task.assignee_name, userMap);

  // Slack @mention string — renders as a clickable tag and sends a notification
  const assigneeMention = assigneeId ? `<@${assigneeId}>` : task.assignee_name;
  const managerMention  = `<@${SLACK_MANAGER_ID}>`;

  const fdChannelId = assigneeId ? TEAM_CHANNEL_MAP[assigneeId] : null;

  for (const reminder of reminders) {
    const key = makeReminderKey(task, reminder.type);

    if (state.scheduled[key]) {
      console.log(`  → Already scheduled ${reminder.type} for "${task.task}" — skipping`);
      continue;
    }

    const sendTime = new Date(reminder.date);
    sendTime.setUTCHours(REMINDER_HOUR_UTC, 0, 0, 0);
    const postAt = Math.floor(sendTime.getTime() / 1000);
    const nowSec = Math.floor(Date.now() / 1000);

    if (postAt <= nowSec + 120) {
      console.log(`  → Skipping ${reminder.type} reminder (past or too soon): "${task.task}"`);
      state.scheduled[key] = {
        scheduledAt: new Date().toISOString(),
        type: reminder.type,
        task: task.task,
        skipped: true
      };
      continue;
    }

    const dueLabel = task.due_date ? formatDate(task.due_date) : 'no due date set';
    const isMidpoint = reminder.type === 'midpoint';

    // ── Message templates (all use real @mentions) ─────────────────────────

    // 1. Manager DM — tags the assignee so Brandon can see who it's about
    const managerMsg = isMidpoint
      ? `*Midpoint check-in* 📋\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Due:* ${dueLabel}\n\nThis task is at its halfway point. Consider checking on progress with ${assigneeMention}.`
      : `*Task due today* 📋\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Due:* ${dueLabel}\n\nThis task is due today — you may want to check in with ${assigneeMention}.`;

    // 2. Assignee DM — tags themselves (confirms it's meant for them) + tags Brandon
    const assigneeDmMsg = isMidpoint
      ? `Hey ${assigneeMention}! 👋 Midpoint check-in on your task:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nHow's progress coming along? ${managerMention} wanted a quick status update.`
      : `Hey ${assigneeMention}! ⏰ Reminder — task due today:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nThis is due today! Reach out to ${managerMention} if you need anything.`;

    // 3. #fd- channel — tags the assignee so they get a channel notification too
    const fdChannelMsg = isMidpoint
      ? `${assigneeMention} — midpoint check-in 📋\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nYou're halfway to the deadline on this one. How's it going? Loop in ${managerMention} with a status update.`
      : `${assigneeMention} — task due today ⏰\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nThis is due today! Let ${managerMention} know if you need any help.`;

    let scheduled = false;

    // Send manager DM
    try {
      await slackPost('chat.scheduleMessage', {
        channel: SLACK_MANAGER_ID,
        text: managerMsg,
        post_at: postAt
      });
      console.log(`  ✓ Manager DM scheduled → ${sendTime.toISOString().split('T')[0]}`);
      scheduled = true;
    } catch (e) {
      console.error(`  ✗ Manager DM failed: ${e.message}`);
    }

    // Send assignee DM
    if (assigneeId && assigneeId !== SLACK_MANAGER_ID) {
      try {
        await slackPost('chat.scheduleMessage', {
          channel: assigneeId,
          text: assigneeDmMsg,
          post_at: postAt
        });
        console.log(`  ✓ Assignee DM scheduled → ${task.assignee_name}`);
      } catch (e) {
        console.error(`  ✗ Assignee DM failed: ${e.message}`);
      }
    } else if (!assigneeId) {
      console.log(`  ⚠ Could not resolve Slack ID for "${task.assignee_name}" — manager DM only`);
    }

    // Send to personal #fd- channel
    if (fdChannelId) {
      try {
        await slackPost('chat.scheduleMessage', {
          channel: fdChannelId,
          text: fdChannelMsg,
          post_at: postAt
        });
        console.log(`  ✓ #fd- channel message scheduled → ${task.assignee_name}`);
      } catch (e) {
        console.error(`  ✗ #fd- channel message failed: ${e.message}`);
      }
    } else if (assigneeId) {
      console.log(`  ⚠ No #fd- channel mapped for "${task.assignee_name}" (${assigneeId})`);
    }

    await new Promise(r => setTimeout(r, 300));

    if (scheduled) {
      state.scheduled[key] = {
        scheduledAt: new Date().toISOString(),
        type: reminder.type,
        task: task.task,
        assignee: task.assignee_name,
        reminderDate: sendTime.toISOString().split('T')[0]
      };
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== AMPD Task Monitor ===');
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log('');

  const state = loadState();
  console.log(`State: ${Object.keys(state.scheduled).length} previously tracked reminders.`);
  purgeOldState(state);

  try {
    console.log('Loading Slack users...');
    const userMap = await buildUserMap();

    const messages = await fetchMessages();
    const realMessages = messages.filter(m => !m.subtype);
    console.log(`Found ${realMessages.length} user messages.`);

    if (realMessages.length === 0) {
      console.log('No messages to process.');
      saveState(state);
      return;
    }

    const tasks = await extractTasks(realMessages, userMap);

    if (tasks.length === 0) {
      console.log('No task assignments found.');
      saveState(state);
      return;
    }

    console.log('\nProcessing reminders...');
    for (const task of tasks) {
      console.log(`\nTask: "${task.task}" → ${task.assignee_name} (due: ${task.due_date || 'none'})`);
      await scheduleRemindersForTask(task, userMap, state);
    }

    saveState(state);
    console.log(`\n=== Done. Processed ${tasks.length} task(s). ===`);

  } catch (e) {
    console.error('FATAL ERROR:', e.message);
    console.error(e.stack);
    saveState(state);
    try {
      await slackPost('chat.scheduleMessage', {
        channel: SLACK_MANAGER_ID,
        text: `*Task Monitor Error* ⚠️\nThe scan failed: \`${e.message}\`\nCheck GitHub Actions logs for details.`,
        post_at: Math.floor(Date.now() / 1000) + 130
      });
    } catch (_) {}
    process.exit(1);
  }
}

main();
