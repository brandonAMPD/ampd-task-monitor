/**
 * AMPD Task Monitor — scan.js
 * Reads #ampd-team-tasks, extracts task assignments using Claude AI,
 * then schedules Slack DM reminders to assignees and the manager.
 *
 * Runs every 30 minutes via GitHub Actions.
 * Uses scheduled-reminders.json to track already-scheduled reminders
 * so duplicates are never created across runs.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import crypto from 'crypto';

// ─── Config from environment ──────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID  || 'C0AQK5D4LD6';
const SLACK_MANAGER_ID  = process.env.SLACK_MANAGER_ID  || 'UMS39RAGP';
const LOOKBACK_DAYS     = parseInt(process.env.LOOKBACK_DAYS || '14');

// Send reminders at 9:00 AM EST (14:00 UTC)
const REMINDER_HOUR_UTC = 14;

if (!ANTHROPIC_API_KEY || !SLACK_BOT_TOKEN) {
  console.error('ERROR: ANTHROPIC_API_KEY and SLACK_BOT_TOKEN must be set.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

// ─── Slack API helpers ────────────────────────────────────────────────────────

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

// ─── Fetch channel messages ───────────────────────────────────────────────────

async function fetchMessages() {
  const oldest = Math.floor(Date.now() / 1000 