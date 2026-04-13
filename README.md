# AMPD Task Monitor — Setup Guide

Automatically scans `#ampd-team-tasks` every morning, extracts task assignments using Claude AI, and schedules Slack DM reminders to assignees and Brandon at the midpoint and due date of each task.

---

## What you need before starting

- A free GitHub account → github.com/signup
- Your **Anthropic API key** → console.anthropic.com (Settings → API Keys)
- A **Slack Bot Token** (see Step 2 below)

---

## Step 1 — Create the GitHub repository

1. Go to **github.com** and log in
2. Click the **+** icon (top right) → **New repository**
3. Name it `ampd-task-monitor`
4. Set it to **Private**
5. Click **Create repository**

---

## Step 2 — Create a Slack Bot and get your token

1. Go to **api.slack.com/apps** → **Create New App** → **From Scratch**
2. Name it `Task Monitor`, select your Dovetail workspace → **Create App**
3. In the left sidebar click **OAuth & Permissions**
4. Scroll to **Scopes → Bot Token Scopes** and add these four scopes:
   - `channels:history` — read messages from channels
   - `chat:write` — send and schedule messages
   - `users:read` — look up team member IDs
   - `im:write` — open DM channels with users
5. Scroll back to the top and click **Install to Workspace** → **Allow**
6. Copy the **Bot User OAuth Token** — it starts with `xoxb-`
7. In Slack, open `#ampd-team-tasks` and type `/invite @Task Monitor` to give the bot access

---

## Step 3 — Add your files to GitHub

In your new GitHub repo, create these files exactly as shown (you can use the GitHub web editor — click **Add file → Create new file**):

### File 1: `package.json`
Paste the contents of the `package.json` file provided.

### File 2: `scan.js`
Paste the contents of the `scan.js` file provided.

### File 3: `.github/workflows/daily-scan.yml`
- First create the folder path by typing `.github/workflows/daily-scan.yml` as the filename (GitHub will create the folders automatically)
- Paste the contents of the `daily-scan.yml` file provided

---

## Step 4 — Add your secrets to GitHub

Your API keys are stored as encrypted GitHub Secrets — they're never visible in logs or code.

1. In your GitHub repo, click **Settings** (top nav)
2. In the left sidebar click **Secrets and variables → Actions**
3. Click **New repository secret** for each of the following:

| Secret name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (sk-ant-...) |
| `SLACK_BOT_TOKEN` | Your Slack bot token (xoxb-...) |
| `SLACK_CHANNEL_ID` | `C0AQK5D4LD6` |
| `SLACK_MANAGER_ID` | `UMS39RAGP` |

---

## Step 5 — Test it manually

Before waiting for the 9 AM schedule, trigger it manually to confirm everything works:

1. In your GitHub repo click the **Actions** tab
2. In the left sidebar click **Daily Task Monitor**
3. Click **Run workflow** → **Run workflow** (green button)
4. Watch the logs in real time — you should see it scan the channel and schedule reminders
5. Check your Slack DMs — you should receive the scheduled messages at 9 AM PHT

---

## How it runs automatically

The workflow is scheduled via cron: `0 1 * * *` which is **1:00 AM UTC = 9:00 AM Philippine Time (PHT)** every day.

Each morning it will:
1. Read all messages in `#ampd-team-tasks` from the last 14 days
2. Use Claude to extract every task assignment regardless of format
3. For each task, schedule two Slack DMs:
   - **Midpoint reminder** — halfway between assignment date and due date
   - **Due date reminder** — the morning the task is due
4. DMs go to both you (Brandon) and the assignee

If no tasks are found, you'll get a brief "no tasks found" summary DM.
If the script errors, you'll get an error DM with details.

---

## Adjusting the schedule

To change the run time, edit `.github/workflows/daily-scan.yml` and change the cron line:

```
- cron: '0 1 * * *'   # 1:00 AM UTC = 9:00 AM PHT
- cron: '0 0 * * *'   # 12:00 AM UTC = 8:00 AM PHT
- cron: '30 1 * * *'  # 1:30 AM UTC = 9:30 AM PHT
```

Use **crontab.guru** to easily convert times.

---

## Adjusting the lookback window

In `daily-scan.yml`, change `LOOKBACK_DAYS: '14'` to however many days back you want to scan (e.g. `'7'` or `'30'`).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Slack error: not_in_channel` | Run `/invite @Task Monitor` in `#ampd-team-tasks` |
| `Slack error: missing_scope` | Re-add the four OAuth scopes and reinstall the app |
| `Claude returned invalid JSON` | Usually a temporary API issue — re-run the workflow |
| Reminders not arriving | Check that `post_at` is in the future; Slack requires 2 min minimum |
| Assignee not getting DM | Claude couldn't match the name to a Slack user — ensure they use `@mentions` in the channel |
