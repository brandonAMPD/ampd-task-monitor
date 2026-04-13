/**
 * AMPD Task Monitor — scan.js
 *
 * Reminder schedule per task:
 *   - Midpoint check-in
 *   - Nag reminders daily starting 2 days before due date
 *   - Due date reminder
 *   - Post-due daily reminders until marked complete ("overdue by X days")
 *   - 7-day follow-up for tasks with no due date
 *
 * Completion detection:
 *   - Scans main channel messages for completion keywords
 *   - Also reads thread replies on every tracked task message
 *
 * Runs every 30 minutes via GitHub Actions.
 * Persists state in scheduled-reminders.json for deduplication.
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
const REMINDER_HOUR_UTC = 14;  // 9:00 AM EST = 14:00 UTC
const NAG_DAYS_BEFORE   = 2;   // Start nag reminders this many days before due date
const MAX_OVERDUE_DAYS  = 30;  // Stop post-due reminders after this many days overdue

if (!ANTHROPIC_API_KEY || !SLACK_BOT_TOKEN) {
  console.error('ERROR: ANTHROPIC_API_KEY and SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Team channel mapping ─────────────────────────────────────────────────────
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

const COMPLETION_KEYWORDS = [
  'done', 'completed', 'finished', 'complete', 'wrapped up', 'wrapped',
  'submitted', 'delivered', 'sent', '✅', ':white_check_mark:'
];

// ─── State management ─────────────────────────────────────────────────────────
const STATE_FILE = 'scheduled-reminders.json';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not load state file, starting fresh:', e.message);
  }
  return { tasks: {}, scheduled: {}, lastRun: null };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function makeTaskId(task) {
  const raw = [
    task.task.toLowerCase().trim().slice(0, 60),
    (task.assignee_name || '').toLowerCase().trim(),
    task.assigned_date || ''
  ].join('|');
  return crypto.createHash('md5').update(raw).digest('hex');
}

function makeReminderKey(taskId, reminderType, dateStr) {
  return `${taskId}|${reminderType}|${dateStr}`;
}

function purgeOldState(state) {
  const cutoff = Date.now() - 90 * 86400000;
  let purged = 0;
  for (const [key, entry] of Object.entries(state.scheduled || {})) {
    if (entry.scheduledAt && new Date(entry.scheduledAt).getTime() < cutoff) {
      delete state.scheduled[key];
      purged++;
    }
  }
  for (const [key, entry] of Object.entries(state.tasks || {})) {
    if (entry.completedAt && new Date(entry.completedAt).getTime() < cutoff) {
      delete state.tasks[key];
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

// Fetch thread replies for a specific message timestamp
async function fetchThreadReplies(messageTs) {
  try {
    const data = await slackGet('conversations.replies', {
      channel: SLACK_CHANNEL_ID,
      ts: messageTs,
      limit: '50'
    });
    // replies[0] is the parent message, skip it
    return (data.messages || []).slice(1);
  } catch (e) {
    console.warn(`  Could not fetch thread for ${messageTs}: ${e.message}`);
    return [];
  }
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

// ─── Completion detection ─────────────────────────────────────────────────────
// Checks both main channel messages AND thread replies on task messages
async function detectCompletions(messages, userMap, existingTasks) {
  const openTasks = Object.entries(existingTasks).filter(([, t]) => !t.completed);
  if (openTasks.length === 0) return [];

  // 1. Check thread replies for each tracked task that has a message timestamp
  console.log('Checking thread replies for completions...');
  const quickCompletions = new Set();

  for (const [taskId, taskState] of openTasks) {
    if (!taskState.messageTs) continue;

    const replies = await fetchThreadReplies(taskState.messageTs);
    if (replies.length === 0) continue;

    const replyTexts = replies.map(r => (r.text || '').toLowerCase());
    const hasCompletion = replyTexts.some(text =>
      COMPLETION_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))
    );

    if (hasCompletion) {
      console.log(`  ✅ Thread reply signals completion: "${taskState.task}"`);
      quickCompletions.add(taskId);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Use Claude to check main channel messages for completions
  const taskList = openTasks
    .filter(([id]) => !quickCompletions.has(id))
    .map(([id, t]) => `ID: ${id} | Task: ${t.task} | Assignee: ${t.assignee_name}`)
    .join('\n');

  let claudeCompletions = [];

  if (taskList) {
    const today = new Date().toISOString().split('T')[0];
    const recentMessages = messages.slice(0, 50).map(m => {
      const author = userMap[m.user]?.name || m.user || 'unknown';
      const text = (m.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) =>
        `@${userMap[uid]?.name || uid}`
      );
      return `${author}: ${text}`;
    }).join('\n');

    console.log('Checking main channel for completion signals...');

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You detect when tasks have been marked complete in Slack messages. Today is ${today}.
A completion is when someone clearly says a task is done — e.g. "done", "completed", "finished", "submitted", "delivered", "✅".
Return ONLY valid JSON: {"completed": ["taskId1"]}
If none: {"completed": []}
Be conservative — only mark complete on clear signals.`,
        messages: [{
          role: 'user',
          content: `Open tasks:\n${taskList}\n\nRecent messages:\n${recentMessages}`
        }]
      });

      const raw = response.content[0].text.replace(/```json|```/g, '').trim();
      claudeCompletions = JSON.parse(raw).completed || [];
    } catch (e) {
      console.warn('Completion detection parse error:', e.message);
    }
  }

  return [...new Set([...quickCompletions, ...claudeCompletions])];
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
    // Include message timestamp so we can track threads later
    return { line: `[${date}] [ts:${m.ts}] ${author}: ${text}`, ts: m.ts };
  });

  if (!enriched.length) return [];

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
      "message_ts": "the ts value from [ts:...] in the source message",
      "source_message": "first 100 chars of the original message"
    }
  ]
}

Rules:
- Resolve relative dates (e.g. "by Friday", "end of week", "tomorrow") to YYYY-MM-DD from today ${today}
- Include ALL assignments — casual, formal, @mentioned, implied
- Set due_date to null if not mentioned
- Exclude join messages, bot messages, completion messages, non-task conversation
- assigned_date = date the message was sent
- message_ts = copy exactly from [ts:XXXXXXXXX] tag in the message line`,
    messages: [{
      role: 'user',
      content: `Extract all task assignments:\n\n${enriched.map(e => e.line).join('\n')}`
    }]
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

// ─── Reminder schedule ────────────────────────────────────────────────────────
function calcReminders(task) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const assigned = new Date((task.assigned_date || todayStr) + 'T00:00:00Z');
  const reminders = [];

  if (task.due_date) {
    const due = new Date(task.due_date + 'T00:00:00Z');
    const totalMs = due - assigned;

    // Midpoint
    if (totalMs > 2 * 86400000) {
      const mid = new Date(assigned.getTime() + totalMs / 2);
      mid.setUTCHours(0, 0, 0, 0);
      if (mid >= today) {
        reminders.push({ type: 'midpoint', date: new Date(mid), dateStr: mid.toISOString().split('T')[0] });
      }
    }

    // Pre-due nag window (NAG_DAYS_BEFORE days before due up to and including due date)
    for (let d = NAG_DAYS_BEFORE; d >= 0; d--) {
      const nagDate = new Date(due.getTime() - d * 86400000);
      nagDate.setUTCHours(0, 0, 0, 0);
      if (nagDate >= today) {
        const daysUntilDue = d;
        reminders.push({
          type: d === 0 ? 'due' : 'nag',
          date: new Date(nagDate),
          dateStr: nagDate.toISOString().split('T')[0],
          daysUntilDue
        });
      }
    }

    // Post-due daily reminders (day after due up to MAX_OVERDUE_DAYS)
    for (let d = 1; d <= MAX_OVERDUE_DAYS; d++) {
      const overdueDate = new Date(due.getTime() + d * 86400000);
      overdueDate.setUTCHours(0, 0, 0, 0);
      if (overdueDate >= today) {
        reminders.push({
          type: 'overdue',
          date: new Date(overdueDate),
          dateStr: overdueDate.toISOString().split('T')[0],
          daysOverdue: d
        });
      }
    }
  } else {
    // No due date: 7-day follow-up
    const followUp = new Date(assigned.getTime() + 7 * 86400000);
    followUp.setUTCHours(0, 0, 0, 0);
    if (followUp >= today) {
      reminders.push({
        type: 'followup',
        date: new Date(followUp),
        dateStr: followUp.toISOString().split('T')[0]
      });
    }
  }

  // Deduplicate by date (midpoint may land on a nag day)
  const seen = new Set();
  return reminders.filter(r => {
    if (seen.has(r.dateStr)) return false;
    seen.add(r.dateStr);
    return true;
  });
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

// ─── Message templates ────────────────────────────────────────────────────────
function buildMessages(reminder, task, assigneeMention) {
  const managerMention = `<@${SLACK_MANAGER_ID}>`;
  const dueLabel = task.due_date ? formatDate(task.due_date) : 'no due date set';

  switch (reminder.type) {
    case 'midpoint':
      return {
        manager:  `*Midpoint check-in* 📋\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Due:* ${dueLabel}\n\nHalfway to the deadline — consider checking on progress with ${assigneeMention}.`,
        assignee: `Hey ${assigneeMention}! 👋 Midpoint check-in:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nHow's progress? ${managerMention} wanted a quick status update.`,
        channel:  `${assigneeMention} — midpoint check-in 📋\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nHalfway there! Loop in ${managerMention} with a status update.`
      };

    case 'nag': {
      const d = reminder.daysUntilDue;
      const urgency = d === 1 ? '🚨 *1 day left!*' : `⚠️ *${d} days left*`;
      return {
        manager:  `*Task reminder* ${urgency}\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Due:* ${dueLabel}\n\nNot yet marked complete.`,
        assignee: `Hey ${assigneeMention}! ${urgency} on your task:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nPlease update ${managerMention} on your progress.`,
        channel:  `${assigneeMention} — ${urgency}:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nUpdate ${managerMention} on your status!`
      };
    }

    case 'due':
      return {
        manager:  `*Task due today* 📋\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Due:* ${dueLabel}\n\nThis task is due today — check in with ${assigneeMention}.`,
        assignee: `Hey ${assigneeMention}! ⏰ Task due *today*:\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nGet it wrapped up! Reach out to ${managerMention} if you need anything.`,
        channel:  `${assigneeMention} — task due *today* ⏰\n\n*Task:* ${task.task}\n*Due:* ${dueLabel}\n\nDue today! Let ${managerMention} know if you need help.`
      };

    case 'overdue': {
      const d = reminder.daysOverdue;
      const dayLabel = d === 1 ? '1 day' : `${d} days`;
      return {
        manager:  `*Task overdue* 🚨\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Was due:* ${dueLabel}\n*Overdue by:* ${dayLabel}\n\nThis task has not been marked complete.`,
        assignee: `Hey ${assigneeMention}! 🚨 This task is *overdue by ${dayLabel}*:\n\n*Task:* ${task.task}\n*Was due:* ${dueLabel}\n\nPlease complete this ASAP and notify ${managerMention}.`,
        channel:  `${assigneeMention} — *overdue by ${dayLabel}* 🚨\n\n*Task:* ${task.task}\n*Was due:* ${dueLabel}\n\nThis is past due! Update ${managerMention} immediately.`
      };
    }

    case 'followup':
    default:
      return {
        manager:  `*Weekly follow-up* 📋\n*Task:* ${task.task}\n*Assigned to:* ${assigneeMention}\n*Assigned:* ${formatDate(task.assigned_date)}\n\nNo due date set — hasn't been marked complete after 7 days.`,
        assignee: `Hey ${assigneeMention}! 👋 Following up on an open task:\n\n*Task:* ${task.task}\n\nNo due date was set — what's the status? Loop in ${managerMention}.`,
        channel:  `${assigneeMention} — weekly follow-up 📋\n\n*Task:* ${task.task}\n\nOpen for 7 days with no due date. What's the status? Let ${managerMention} know.`
      };
  }
}

// ─── Schedule reminders for a task ───────────────────────────────────────────
async function scheduleRemindersForTask(task, taskId, userMap, state) {
  if (state.tasks[taskId]?.completed) {
    console.log(`  → Completed — skipping: "${task.task}"`);
    return;
  }

  const reminders = calcReminders(task);
  if (reminders.length === 0) {
    console.log(`  → No upcoming reminders for: "${task.task}"`);
    return;
  }

  const assigneeId = resolveUserId(task.assignee_slack_mention, userMap)
    || resolveUserId(task.assignee_name, userMap);
  const assigneeMention = assigneeId ? `<@${assigneeId}>` : task.assignee_name;
  const fdChannelId = assigneeId ? TEAM_CHANNEL_MAP[assigneeId] : null;

  for (const reminder of reminders) {
    const key = makeReminderKey(taskId, reminder.type, reminder.dateStr);

    if (state.scheduled[key]) {
      console.log(`  → Already scheduled ${reminder.type} (${reminder.dateStr}) — skipping`);
      continue;
    }

    const sendTime = new Date(reminder.date);
    sendTime.setUTCHours(REMINDER_HOUR_UTC, 0, 0, 0);
    const postAt = Math.floor(sendTime.getTime() / 1000);
    const nowSec = Math.floor(Date.now() / 1000);

    if (postAt <= nowSec + 120) {
      console.log(`  → Past/too soon — skipping ${reminder.type} (${reminder.dateStr})`);
      state.scheduled[key] = {
        scheduledAt: new Date().toISOString(),
        type: reminder.type,
        task: task.task,
        skipped: true
      };
      continue;
    }

    const msgs = buildMessages(reminder, task, assigneeMention);
    let scheduled = false;

    // 1. Manager DM
    try {
      await slackPost('chat.scheduleMessage', {
        channel: SLACK_MANAGER_ID,
        text: msgs.manager,
        post_at: postAt
      });
      console.log(`  ✓ Manager DM — ${reminder.type} on ${reminder.dateStr}`);
      scheduled = true;
    } catch (e) {
      console.error(`  ✗ Manager DM failed: ${e.message}`);
    }

    // 2. Assignee DM
    if (assigneeId && assigneeId !== SLACK_MANAGER_ID) {
      try {
        await slackPost('chat.scheduleMessage', {
          channel: assigneeId,
          text: msgs.assignee,
          post_at: postAt
        });
        console.log(`  ✓ Assignee DM — ${task.assignee_name}`);
      } catch (e) {
        console.error(`  ✗ Assignee DM failed: ${e.message}`);
      }
    } else if (!assigneeId) {
      console.log(`  ⚠ Could not resolve Slack ID for "${task.assignee_name}"`);
    }

    // 3. Personal #fd- channel
    if (fdChannelId) {
      try {
        await slackPost('chat.scheduleMessage', {
          channel: fdChannelId,
          text: msgs.channel,
          post_at: postAt
        });
        console.log(`  ✓ #fd- channel — ${task.assignee_name}`);
      } catch (e) {
        console.error(`  ✗ #fd- channel failed: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 300));

    if (scheduled) {
      state.scheduled[key] = {
        scheduledAt: new Date().toISOString(),
        type: reminder.type,
        task: task.task,
        assignee: task.assignee_name,
        reminderDate: reminder.dateStr
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
  if (!state.tasks) state.tasks = {};
  if (!state.scheduled) state.scheduled = {};
  console.log(`State: ${Object.keys(state.tasks).length} tracked tasks, ${Object.keys(state.scheduled).length} scheduled reminders.`);
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

    // Step 1: Check for completions (channel messages + thread replies)
    const completedIds = await detectCompletions(realMessages, userMap, state.tasks);
    if (completedIds.length > 0) {
      console.log(`\nMarking ${completedIds.length} task(s) complete:`);
      for (const id of completedIds) {
        if (state.tasks[id] && !state.tasks[id].completed) {
          state.tasks[id].completed = true;
          state.tasks[id].completedAt = new Date().toISOString();
          const assigneeId = state.tasks[id].assigneeId;
          const assigneeMention = assigneeId ? `<@${assigneeId}>` : state.tasks[id].assignee_name;
          console.log(`  ✅ "${state.tasks[id].task}" — ${state.tasks[id].assignee_name}`);
          try {
            await slackPost('chat.postMessage', {
              channel: SLACK_MANAGER_ID,
              text: `*Task completed* ✅\n*Task:* ${state.tasks[id].task}\n*Completed by:* ${assigneeMention}\n\nAll future reminders for this task have been cancelled.`
            });
          } catch (e) {
            console.warn('  Could not send completion notice:', e.message);
          }
        }
      }
    }

    // Step 2: Extract tasks
    const tasks = await extractTasks(realMessages, userMap);
    if (tasks.length === 0) {
      console.log('No task assignments found.');
      saveState(state);
      return;
    }

    // Step 3: Register new tasks and schedule reminders
    console.log('\nProcessing tasks...');
    for (const task of tasks) {
      const taskId = makeTaskId(task);

      if (!state.tasks[taskId]) {
        const assigneeId = resolveUserId(task.assignee_slack_mention, userMap)
          || resolveUserId(task.assignee_name, userMap);
        state.tasks[taskId] = {
          ...task,
          assigneeId,
          messageTs: task.message_ts || null,
          completed: false,
          firstSeenAt: new Date().toISOString()
        };
        console.log(`\n[NEW] "${task.task}" → ${task.assignee_name} (due: ${task.due_date || 'none'})`);
      } else if (state.tasks[taskId].completed) {
        console.log(`\n[DONE] Skipping: "${task.task}"`);
        continue;
      } else {
        console.log(`\n[OPEN] "${task.task}" → ${task.assignee_name} (due: ${task.due_date || 'none'})`);
        // Update messageTs if we now have it
        if (task.message_ts && !state.tasks[taskId].messageTs) {
          state.tasks[taskId].messageTs = task.message_ts;
        }
      }

      await scheduleRemindersForTask(task, taskId, userMap, state);
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
