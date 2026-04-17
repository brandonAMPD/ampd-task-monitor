/**
 * AMPD Task Monitor — scan.js
 *
 * Reminder schedule per task:
 *   - Midpoint check-in
 *   - Nag reminders daily starting 2 days before due date
 *   - Due date reminder
 *   - Post-due daily reminders until marked complete ("overdue by X days"), up to 30 days
 *   - 7-day follow-up for tasks with no due date
 *
 * Weekly Friday summary posted to #ampd-team-tasks at 9 AM EST
 *
 * Completion detection: thread replies + main channel messages
 * Runs every 30 minutes via GitHub Actions.
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
const NAG_DAYS_BEFORE   = 2;
// MAX_OVERDUE_DAYS removed — overdue now schedules one reminder at a time

if (!ANTHROPIC_API_KEY || !SLACK_BOT_TOKEN) {
  console.error('ERROR: ANTHROPIC_API_KEY and SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Team channel mapping ─────────────────────────────────────────────────────
const TEAM_CHANNEL_MAP = {
  'UMS39RAGP':   'C05HV4SQD6G',  // Brandon   → #fd-brandon
  'U023F61R16F': 'C05JGF817H6',  // Mark      → #fd-mark
  'U03KVJD9927': 'C08RPJDC073',  // Joma      → #fd-joma
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
  return { tasks: {}, scheduled: {}, lastWeeklySummaryDate: null, lastRun: null };
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
      delete state.scheduled[key]; purged++;
    }
  }
  for (const [key, entry] of Object.entries(state.tasks || {})) {
    if (entry.completedAt && new Date(entry.completedAt).getTime() < cutoff) {
      delete state.tasks[key]; purged++;
    }
  }
  if (purged > 0) console.log(`Purged ${purged} old state entries.`);
}

// ─── Slack helpers with retry ─────────────────────────────────────────────────
async function slackRequest(method, options = {}) {
  const maxRetries = 4;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      let res;
      if (options.body) {
        res = await fetch(`https://slack.com/api/${method}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: JSON.stringify(options.body)
        });
      } else {
        const url = new URL(`https://slack.com/api/${method}`);
        Object.entries(options.params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
        res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
      }
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '5') * 1000 + 1000;
        console.warn(`  ⏳ Rate limited. Waiting ${wait/1000}s...`);
        await sleep(wait); attempt++; continue;
      }
      if (res.status >= 500) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`  ⏳ Server error ${res.status}. Waiting ${wait/1000}s...`);
        await sleep(wait); attempt++; continue;
      }
      const data = await res.json();
      if (!data.ok && data.error === 'ratelimited') {
        const wait = Math.pow(2, attempt) * 2000;
        await sleep(wait); attempt++; continue;
      }
      if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
      return data;
    } catch (e) {
      if (attempt < maxRetries && e.message && e.message.includes('fetch')) {
        await sleep(Math.pow(2, attempt) * 1000); attempt++; continue;
      }
      throw e;
    }
  }
  throw new Error(`Slack ${method} failed after ${maxRetries} retries`);
}

function slackGet(method, params = {}) { return slackRequest(method, { params }); }
function slackPost(method, body = {}) { return slackRequest(method, { body }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Claude API with retry ────────────────────────────────────────────────────
async function claudeWithRetry(params) {
  const maxRetries = 6;
  const overloadedWaits = [15000, 30000, 60000, 120000, 120000, 120000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes('overloaded'));
      const isRateLimit  = e.status === 429;
      const isServerErr  = e.status >= 500 && e.status !== 529;
      if (attempt < maxRetries && (isOverloaded || isRateLimit || isServerErr)) {
        const wait = isRateLimit ? 30000 : (overloadedWaits[attempt] || 120000);
        console.warn(`  ⏳ Anthropic API ${e.status || 'error'} — waiting ${wait/1000}s before retry ${attempt+1}/${maxRetries}...`);
        await sleep(wait); continue;
      }
      throw e;
    }
  }
}

// ─── Fetch messages ───────────────────────────────────────────────────────────
async function fetchMessages() {
  const oldest = Math.floor(Date.now() / 1000 - LOOKBACK_DAYS * 86400);
  console.log(`Reading #ampd-team-tasks (last ${LOOKBACK_DAYS} days)...`);
  const data = await slackGet('conversations.history', {
    channel: SLACK_CHANNEL_ID, oldest: String(oldest), limit: '200'
  });
  return data.messages || [];
}

async function fetchThreadReplies(messageTs) {
  try {
    const data = await slackGet('conversations.replies', {
      channel: SLACK_CHANNEL_ID, ts: messageTs, limit: '50'
    });
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
async function detectCompletions(messages, userMap, existingTasks) {
  const openTasks = Object.entries(existingTasks).filter(([, t]) => !t.completed);
  if (openTasks.length === 0) return [];

  const quickCompletions = new Set();

  console.log('Checking thread replies for completions...');
  for (const [taskId, taskState] of openTasks) {
    if (!taskState.messageTs) continue;
    const replies = await fetchThreadReplies(taskState.messageTs);
    if (replies.length === 0) continue;
    const hasCompletion = replies
      .map(r => (r.text || '').toLowerCase())
      .some(text => COMPLETION_KEYWORDS.some(kw => text.includes(kw.toLowerCase())));
    if (hasCompletion) {
      console.log(`  ✅ Thread reply signals completion: "${taskState.task}"`);
      quickCompletions.add(taskId);
    }
    await sleep(200);
  }

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
        `@${userMap[uid]?.name || uid}`);
      return `${author}: ${text}`;
    }).join('\n');

    console.log('Checking main channel for completion signals...');
    try {
      const response = await claudeWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `Detect completed tasks from Slack messages. Today is ${today}.
Return ONLY valid JSON: {"completed": ["taskId1"]}
If none: {"completed": []}
Only mark complete on clear signals: "done", "completed", "finished", "submitted", "✅".`,
        messages: [{ role: 'user', content: `Open tasks:\n${taskList}\n\nRecent messages:\n${recentMessages}` }]
      });
      const raw = response.content[0].text.replace(/```json|```/g, '').trim();
      claudeCompletions = JSON.parse(raw).completed || [];
    } catch (e) {
      console.warn('Completion detection error:', e.message);
    }
  }

  return [...new Set([...quickCompletions, ...claudeCompletions])];
}

// ─── Extract tasks via Claude (with chunking for large message sets) ──────────
async function extractTasksFromChunk(lines, today) {
  const response = await claudeWithRetry({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You extract task assignments from Slack messages. Today is ${today}.

Return ONLY a valid complete JSON object — no markdown, no explanation, no code fences, no truncation:
{"tasks":[{"task":"brief description (max 100 chars)","assignee_name":"full name or handle","assignee_slack_mention":"@handle or null","assigned_date":"YYYY-MM-DD","due_date":"YYYY-MM-DD or null","message_ts":"ts from [ts:...] tag","source_message":"first 100 chars"}]}

Rules:
- Resolve relative dates to YYYY-MM-DD from today ${today}
- Include ALL assignments — casual, formal, @mentioned, implied
- Exclude join/bot/completion messages
- assigned_date = message send date
- message_ts = copy exactly from [ts:XXXXX] tag
- Return {"tasks":[]} if no tasks found
- CRITICAL: Return complete valid JSON only, never truncate`,
    messages: [{ role: 'user', content: `Extract all task assignments:\n\n${lines}` }]
  });

  const raw = response.content[0].text.replace(/```json|```/g, '').trim();

  // Try to parse, attempt to fix truncated JSON
  try {
    return JSON.parse(raw).tasks || [];
  } catch (e) {
    // Try to salvage truncated JSON by finding last complete task object
    console.warn('JSON truncated, attempting repair...');
    const lastBrace = raw.lastIndexOf('},');
    if (lastBrace > 0) {
      try {
        const repaired = raw.substring(0, lastBrace + 1) + ']}';
        return JSON.parse(repaired).tasks || [];
      } catch (_) {}
    }
    console.warn('Could not repair JSON, skipping chunk');
    return [];
  }
}

async function extractTasks(messages, userMap) {
  const today = new Date().toISOString().split('T')[0];

  const enriched = messages.map(m => {
    const date = new Date(parseFloat(m.ts) * 1000).toISOString().split('T')[0];
    const author = userMap[m.user]?.name || m.user || 'unknown';
    const text = (m.text || '').replace(/<@([A-Z0-9]+)>/g, (_, uid) =>
      `@${userMap[uid]?.name || uid}`);
    return `[${date}] [ts:${m.ts}] ${author}: ${text}`;
  });

  if (enriched.length === 0) return [];

  // Chunk messages to avoid token limits — process in groups of 15
  const CHUNK_SIZE = 15;
  const allTasks = [];

  for (let i = 0; i < enriched.length; i += CHUNK_SIZE) {
    const chunk = enriched.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(enriched.length / CHUNK_SIZE);
    console.log(`Extracting tasks from chunk ${chunkNum}/${totalChunks} (${chunk.length} messages)...`);

    const tasks = await extractTasksFromChunk(chunk.join('\n'), today);
    allTasks.push(...tasks);

    if (i + CHUNK_SIZE < enriched.length) await sleep(500);
  }

  // Deduplicate by message_ts + assignee to handle same task appearing across chunks
  const seen = new Set();
  const deduplicated = allTasks.filter(t => {
    const key = `${t.message_ts}|${(t.assignee_slack_mention || t.assignee_name || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Claude found ${deduplicated.length} task(s) across all chunks.`);
  return deduplicated;
}

// ─── Reminder date logic ──────────────────────────────────────────────────────
function calcReminders(task) {
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const todayStr = today.toISOString().split('T')[0];
  const assigned = new Date((task.assigned_date || todayStr) + 'T00:00:00Z');
  const reminders = [];

  if (task.due_date) {
    const due = new Date(task.due_date + 'T00:00:00Z');
    const totalMs = due - assigned;

    // Midpoint
    if (totalMs > 2 * 86400000) {
      const mid = new Date(assigned.getTime() + totalMs / 2);
      mid.setUTCHours(0,0,0,0);
      if (mid >= today) reminders.push({ type: 'midpoint', date: new Date(mid), dateStr: mid.toISOString().split('T')[0] });
    }

    // Pre-due nag window
    for (let d = NAG_DAYS_BEFORE; d >= 0; d--) {
      const nagDate = new Date(due.getTime() - d * 86400000);
      nagDate.setUTCHours(0,0,0,0);
      if (nagDate >= today) {
        reminders.push({ type: d === 0 ? 'due' : 'nag', date: new Date(nagDate), dateStr: nagDate.toISOString().split('T')[0], daysUntilDue: d });
      }
    }

    // Post-due: ONE overdue reminder scheduled for tomorrow only.
    // Each scan re-schedules the next occurrence so it fires daily
    // without pre-queuing 30 messages at once.
    if (due < today) {
      const daysOverdue = Math.round((today - due) / 86400000);
      const tomorrow = new Date(today.getTime() + 86400000);
      tomorrow.setUTCHours(0,0,0,0);
      reminders.push({ type: 'overdue', date: new Date(tomorrow), dateStr: tomorrow.toISOString().split('T')[0], daysOverdue: daysOverdue + 1 });
    }
  } else {
    // No due date: 7-day follow-up
    const followUp = new Date(assigned.getTime() + 7 * 86400000);
    followUp.setUTCHours(0,0,0,0);
    if (followUp >= today) reminders.push({ type: 'followup', date: new Date(followUp), dateStr: followUp.toISOString().split('T')[0] });
  }

  // Deduplicate by date
  const seen = new Set();
  return reminders.filter(r => { if (seen.has(r.dateStr)) return false; seen.add(r.dateStr); return true; });
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
    default: // followup
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
      state.scheduled[key] = { scheduledAt: new Date().toISOString(), type: reminder.type, task: task.task, skipped: true };
      continue;
    }

    const msgs = buildMessages(reminder, task, assigneeMention);
    let scheduled = false;

    try {
      await slackPost('chat.scheduleMessage', { channel: SLACK_MANAGER_ID, text: msgs.manager, post_at: postAt });
      console.log(`  ✓ Manager DM — ${reminder.type} on ${reminder.dateStr}`);
      scheduled = true;
    } catch (e) { console.error(`  ✗ Manager DM failed: ${e.message}`); }

    if (assigneeId && assigneeId !== SLACK_MANAGER_ID) {
      try {
        await slackPost('chat.scheduleMessage', { channel: assigneeId, text: msgs.assignee, post_at: postAt });
        console.log(`  ✓ Assignee DM — ${task.assignee_name}`);
      } catch (e) { console.error(`  ✗ Assignee DM failed: ${e.message}`); }
    } else if (!assigneeId) {
      console.log(`  ⚠ Could not resolve Slack ID for "${task.assignee_name}"`);
    }

    if (fdChannelId) {
      try {
        await slackPost('chat.scheduleMessage', { channel: fdChannelId, text: msgs.channel, post_at: postAt });
        console.log(`  ✓ #fd- channel — ${task.assignee_name}`);
      } catch (e) { console.error(`  ✗ #fd- channel failed: ${e.message}`); }
    }

    await sleep(500);

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

// ─── Weekly Friday summary ────────────────────────────────────────────────────
function isFriday() {
  const now = new Date();
  // Check if it's Friday in EST
  const estDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return estDate.getDay() === 5; // 5 = Friday
}

function getThisWeekStr() {
  const now = new Date();
  const estDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  // Return ISO week string YYYY-WW
  const startOfYear = new Date(estDate.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((estDate - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${estDate.getFullYear()}-W${weekNum}`;
}

async function sendWeeklySummary(state) {
  const allTasks = Object.values(state.tasks);
  if (allTasks.length === 0) {
    console.log('No tasks for weekly summary.');
    return;
  }

  const today = new Date(); today.setUTCHours(0,0,0,0);

  const completed = allTasks.filter(t => t.completed);
  const open = allTasks.filter(t => !t.completed);
  const overdue = open.filter(t => t.due_date && new Date(t.due_date + 'T00:00:00Z') < today);
  const dueThisWeek = open.filter(t => {
    if (!t.due_date) return false;
    const due = new Date(t.due_date + 'T00:00:00Z');
    const sevenDays = new Date(today.getTime() + 7 * 86400000);
    return due >= today && due <= sevenDays;
  });
  const onTrack = open.filter(t => !overdue.includes(t) && !dueThisWeek.includes(t));

  const lines = [];
  lines.push(`*📊 Weekly Task Summary — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}*`);
  lines.push(`_${completed.length} completed · ${open.length} open · ${overdue.length} overdue_\n`);

  if (overdue.length > 0) {
    lines.push(`*🚨 OVERDUE (${overdue.length})*`);
    for (const t of overdue) {
      const assigneeMention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      const daysLate = Math.round((today - new Date(t.due_date + 'T00:00:00Z')) / 86400000);
      lines.push(`☐  ${t.task}\n     → ${assigneeMention} | Was due: ${formatDate(t.due_date)} | *${daysLate}d late*`);
    }
    lines.push('');
  }

  if (dueThisWeek.length > 0) {
    lines.push(`*⚠️ DUE THIS WEEK (${dueThisWeek.length})*`);
    for (const t of dueThisWeek) {
      const assigneeMention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      lines.push(`☐  ${t.task}\n     → ${assigneeMention} | Due: ${formatDate(t.due_date)}`);
    }
    lines.push('');
  }

  if (onTrack.length > 0) {
    lines.push(`*📌 IN PROGRESS (${onTrack.length})*`);
    for (const t of onTrack) {
      const assigneeMention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      const dueStr = t.due_date ? `Due: ${formatDate(t.due_date)}` : 'No due date';
      lines.push(`☐  ${t.task}\n     → ${assigneeMention} | ${dueStr}`);
    }
    lines.push('');
  }

  if (completed.length > 0) {
    lines.push(`*✅ COMPLETED THIS PERIOD (${completed.length})*`);
    // Show most recently completed first, max 20
    const recentCompleted = completed
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 20);
    for (const t of recentCompleted) {
      const assigneeMention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      lines.push(`☑  ~${t.task}~\n     → ${assigneeMention}`);
    }
  }

  const summaryMsg = lines.join('\n');

  try {
    await slackPost('chat.postMessage', { channel: SLACK_CHANNEL_ID, text: summaryMsg });
    console.log('✓ Weekly summary posted to #ampd-team-tasks');
  } catch (e) {
    console.error(`✗ Weekly summary failed: ${e.message}`);
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
  if (!state.lastWeeklySummaryDate) state.lastWeeklySummaryDate = null;
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

    // Step 1: Detect completions
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
              text: `*Task completed* ✅\n*Task:* ${state.tasks[id].task}\n*Completed by:* ${assigneeMention}\n\nAll future reminders cancelled.`
            });
          } catch (e) { console.warn('  Could not send completion notice:', e.message); }
        }
      }
    }

    // Step 2: Extract tasks (chunked to avoid token limits)
    const tasks = await extractTasks(realMessages, userMap);
    if (tasks.length > 0) {
      let newCount = 0;
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
          newCount++;
          console.log(`\n[NEW] "${task.task}" → ${task.assignee_name} (due: ${task.due_date || 'none'})`);
        } else if (!state.tasks[taskId].messageTs && task.message_ts) {
          state.tasks[taskId].messageTs = task.message_ts;
        }
      }
      if (newCount > 0) console.log(`\nRegistered ${newCount} new task(s).`);
    } else {
      console.log('No task assignments found.');
    }

    // Step 3: Schedule reminders for all open tasks
    console.log('\nProcessing reminders...');
    for (const [taskId, taskData] of Object.entries(state.tasks)) {
      if (taskData.completed) continue;
      await scheduleRemindersForTask(taskData, taskId, userMap, state);
    }

    // Step 4: Weekly Friday summary at 9 AM EST
    // Weekly summary is handled by a separate workflow (weekly-summary.yml)
    // which runs every Friday at 10 AM EST independently.

    saveState(state);
    console.log(`\n=== Done. ===`);

  } catch (e) {
    console.error('FATAL ERROR:', e.message);
    console.error(e.stack);
    saveState(state);
    try {
      await slackPost('chat.postMessage', {
        channel: SLACK_MANAGER_ID,
        text: `*Task Monitor Error* ⚠️\nThe scan failed: \`${e.message}\`\nCheck GitHub Actions logs for details.`
      });
    } catch (_) {}
    process.exit(1);
  }
}

main();
