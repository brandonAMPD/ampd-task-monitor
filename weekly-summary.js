/**
 * AMPD Task Monitor — weekly-summary.js
 * Dedicated weekly summary script — runs every Friday at 10 AM EST via its own workflow.
 * Posts a full task checklist to #ampd-team-tasks.
 */

import fs from 'fs';

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0AQK5D4LD6';
const STATE_FILE       = 'scheduled-reminders.json';

if (!SLACK_BOT_TOKEN) {
  console.error('ERROR: SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
  return data;
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

function getThisWeekStr() {
  const now = new Date();
  const estDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const startOfYear = new Date(estDate.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((estDate - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${estDate.getFullYear()}-W${weekNum}`;
}

async function main() {
  console.log('=== AMPD Weekly Summary ===');
  console.log(`Run time: ${new Date().toISOString()}`);

  // Load state
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read state file:', e.message);
    process.exit(1);
  }

  const allTasks = Object.values(state.tasks || {});
  console.log(`Total tasks in state: ${allTasks.length}`);

  if (allTasks.length === 0) {
    console.log('No tasks found — skipping summary.');
    return;
  }

  const today = new Date(); today.setUTCHours(0,0,0,0);
  const completed = allTasks.filter(t => t.completed);
  const open      = allTasks.filter(t => !t.completed);
  const overdue   = open.filter(t => t.due_date && new Date(t.due_date + 'T00:00:00Z') < today);
  const dueThisWeek = open.filter(t => {
    if (!t.due_date) return false;
    const due = new Date(t.due_date + 'T00:00:00Z');
    return due >= today && due <= new Date(today.getTime() + 7 * 86400000);
  });
  const onTrack = open.filter(t => !overdue.includes(t) && !dueThisWeek.includes(t));

  const lines = [];
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/New_York'
  });
  lines.push(`*📊 Weekly Task Summary — ${dateLabel}*`);
  lines.push(`_${completed.length} completed · ${open.length} open · ${overdue.length} overdue_\n`);

  if (overdue.length > 0) {
    lines.push(`*🚨 OVERDUE (${overdue.length})*`);
    for (const t of overdue) {
      const mention  = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      const daysLate = Math.round((today - new Date(t.due_date + 'T00:00:00Z')) / 86400000);
      lines.push(`☐  ${t.task}\n     → ${mention} | Was due: ${formatDate(t.due_date)} | *${daysLate}d late*`);
    }
    lines.push('');
  }

  if (dueThisWeek.length > 0) {
    lines.push(`*⚠️ DUE THIS WEEK (${dueThisWeek.length})*`);
    for (const t of dueThisWeek) {
      const mention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      lines.push(`☐  ${t.task}\n     → ${mention} | Due: ${formatDate(t.due_date)}`);
    }
    lines.push('');
  }

  if (onTrack.length > 0) {
    lines.push(`*📌 IN PROGRESS (${onTrack.length})*`);
    for (const t of onTrack) {
      const mention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      const dueStr  = t.due_date ? `Due: ${formatDate(t.due_date)}` : 'No due date';
      lines.push(`☐  ${t.task}\n     → ${mention} | ${dueStr}`);
    }
    lines.push('');
  }

  if (completed.length > 0) {
    lines.push(`*✅ COMPLETED (${completed.length})*`);
    const recent = completed
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 20);
    for (const t of recent) {
      const mention = t.assigneeId ? `<@${t.assigneeId}>` : t.assignee_name;
      lines.push(`☑  ~${t.task}~\n     → ${mention}`);
    }
  }

  try {
    await slackPost('chat.postMessage', {
      channel: SLACK_CHANNEL_ID,
      text: lines.join('\n')
    });
    console.log('✓ Weekly summary posted to #ampd-team-tasks');

    // Save the week so scan.js doesn't try to double-send
    state.lastWeeklySummaryDate = getThisWeekStr();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`✓ State updated — lastWeeklySummaryDate: ${state.lastWeeklySummaryDate}`);
  } catch (e) {
    console.error('✗ Failed to post summary:', e.message);
    process.exit(1);
  }

  console.log('=== Done ===');
}

main();
