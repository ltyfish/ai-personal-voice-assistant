# MailMind scheduled jobs (external cron)

PersonalAI runs on Vercel Hobby, whose built-in cron only fires once per day —
too slow for email polling. Instead, an external scheduler pings the endpoints.
[cron-job.org](https://cron-job.org) is free and supports 10-minute intervals
plus custom headers.

## Prerequisites

Set `CRON_SECRET` to a long random string in your Vercel project env vars.
The two endpoints below reject any request whose `Authorization` header does
not match `Bearer <CRON_SECRET>`. (If `CRON_SECRET` is unset they accept any
request — fine for testing, not recommended in production.)

## Jobs to create on cron-job.org

Create two jobs. For each, add a request header:

    Authorization: Bearer <your CRON_SECRET>

| Job              | URL                                                  | Method | Schedule        |
| ---------------- | ---------------------------------------------------- | ------ | --------------- |
| Poll Gmail       | `https://<your-app>/api/mail/fetch-emails`           | GET    | every 10 min    |
| Hourly digest    | `https://<your-app>/api/mail/daily-digest`           | GET    | every hour (`0 * * * *`) |

The digest endpoint decides internally whether the current hour matches one of
your configured digest times, so running it hourly is correct and cheap.

## Verifying

- Hit `https://<your-app>/api/mail/fetch-emails` manually with the header to
  confirm it returns `{"ok":true}`.
- Or use the dashboard's **Fetch Now** button (Inbox view), which calls
  `manual-fetch` and does not require the cron secret (it uses DASHBOARD_SECRET).
