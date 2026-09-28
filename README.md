# Brandfluence — Catalyst Backend

Creator ↔ Business marketplace on Zoho Catalyst.

- **Project:** Brandfluence
- **Project ID:** `5666000000546001`
- **Org:** `60027750675`
- **Region:** IN

## Already set up in your Catalyst project

| Item | Status |
|---|---|
| Data Store: 21 tables (UserProfiles … AuditLogs) | ✅ ready |
| Categories seeded (17 creator, 15 business, 8 creator types) | ✅ ready |
| Stratus `brandfluence-media` (private, encrypted) | ✅ ready |
| Stratus `brandfluence-docs` (private, encrypted, versioned) | ✅ ready |
| Cache segment `bf_discovery` (id 5666000000556019) | ✅ ready |

## What's in this folder

```
catalyst.json
functions/
  brandfluence_api/      Advanced I/O function (Express) — 82 endpoints
    index.js
    src/lib/             db (safe ZCQL), auth (roles), errors
    src/services/        dealMachine, razorpay, social, notify, audit, storage
    src/routes/          me, meta, creators, businesses, discovery, deals, content,
                         messages, payments, webhooks, reviews, disputes,
                         notifications, uploads, admin, internal
  bf_scheduler/          Job function: metrics sync, auto-release, reminders
```

## Secrets (keys and passwords)

Secrets are **not** stored in Git. They live in `secrets.local.json`, which Git ignores.

1. Copy `secrets.example.json` to `secrets.local.json`.
2. Fill in your values: scheduler secret, YouTube key, Razorpay keys, and so on.
3. Deploy with `deploy.bat` (Windows) or `./deploy.sh`. These put the secrets into the function settings only while the deploy runs, then restore the files.

Never run a plain `catalyst deploy` for functions. It would upload empty secret values and break the scheduler, payments and YouTube sync. Deploying only the web app is safe: `catalyst deploy -p 5666000000546001 --only client`.

## Automatic deploys (Catalyst Pipelines)

`catalyst-pipelines.yaml` deploys the backend, scheduler and web app to **Development** on every push to `main`. It uses Catalyst's default build machine, so no Docker account is needed.

One-time setup:
1. On your computer, run `catalyst token:generate` and copy the token.
2. Catalyst Console → **Pipelines** → **Create Pipeline** → choose **GitHub** → add your GitHub account → pick this repository and the `main` branch. Use the existing `catalyst-pipelines.yaml`.
3. In the pipeline's **Global configuration**, add these variables:
   - `CATALYST_TOKEN`: the token from step 1
   - `CATALYST_ORG`: `60027750675`
   - `PROJECT_NAME`: `Brandfluence`
   - `SCHEDULER_SECRET`: same value as in `secrets.local.json`
   - Optional keys, left empty if unused: `YOUTUBE_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `IG_BUSINESS_ACCOUNT_ID`, `IG_ACCESS_TOKEN`

Production is still updated from the Console with **Deploy to Production**, after checking Development.

## Sign-in form styling

Catalyst draws the sign-in form inside an iframe. Following Catalyst's docs, it is styled with its official template plus our changes at the end:

- `client/css/embedded_signin.css`: Catalyst's template, downloaded from `https://api.catalyst.zoho.com/baas/v1/auth/static-file?file_name=embedded_signin.css`
- `client/css/embedded-brand.css`: Brandfluence overrides. These change colours, fonts and shapes only, never what is shown or hidden.
- `client/css/embedded-auth.css`: the file the sign-in page uses, made of a font import, then the template, then the overrides.

After editing the overrides, rebuild the combined file (PowerShell):
```
cd client\css
"@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap');" | Set-Content embedded-auth.css
Get-Content embedded_signin.css, embedded-brand.css | Add-Content embedded-auth.css
```

## Web app (client/)

This is a no-build single-page app, served by Catalyst Web Client Hosting on the same domain as the API. Because of that, login cookies just work and CORS isn't needed.

- **Landing and sign-in:** uses Catalyst hosted authentication.
- **Onboarding:** "What are you here to do?" (Creator / Business / Admin).
- **Creator:**
  - home dashboard
  - profile (details, social accounts, rate card, portfolio, availability, payout account)
  - deals
  - earnings
  - notifications
- **Business:**
  - dashboard
  - creator search with filters
  - creator profile and offer builder
  - campaigns (5-step wizard, results page)
  - deals
  - payments
  - company profile and verification
- **Deal page:**
  - journey rail showing each stage
  - "what to do next" panel for each side
  - offer, counter-offer, accept and decline
  - agreement viewing and e-signing
  - Razorpay checkout
  - draft upload, approval and change requests
  - live links and results
  - chat with attachments
  - reviews and disputes
- **Admin:**
  - overview
  - dispute case file with a decision form
  - creator and business verification
  - users, deals, payments and audit log

The app URL after deploy is:
`https://brandfluence-60027750675.development.catalystserverless.in/app/index.html`

## Deploy (about 10 minutes)

**Quickest:** run `./deploy.sh` (Mac/Linux) or `deploy.bat` (Windows). It installs the CLI, logs you in, and deploys the functions and the web app together.

**Manual steps:**

1. Install the CLI and log in:
   ```bash
   npm install -g zcatalyst-cli
   catalyst login --dc in
   ```

2. Unzip this folder and run the following from inside it:
   ```bash
   catalyst project:use     # choose "Brandfluence"
   cd functions/brandfluence_api && npm install && cd ../..
   cd functions/bf_scheduler && npm install && cd ../..
   catalyst deploy
   ```

3. Check the API is up by opening:
   `https://brandfluence-60027750675.development.catalystserverless.in/server/brandfluence_api/health`

## Console settings to do once

**A. Authentication**

Go to Cloud Scale → Authentication and enable:
- Hosted or Embedded login
- Email sign-up
- Google sign-in
- Optionally, phone OTP

**B. Lock direct table access (important)**

Go to Data Store and open each of the 21 tables. Under **Scopes & Permissions**, set **App User** to have **no** permissions (untick SELECT, INSERT, UPDATE and DELETE).

The API reads and writes with admin scope and checks every permission in code. So users never need direct table access, and removing it stops anyone bypassing the rules from the browser.

**C. Environment variables**

These go in `functions/brandfluence_api/catalyst-config.json`, or in the Console under Functions → brandfluence_api → Configuration.

| Variable | What to put |
|---|---|
| `SCHEDULER_SECRET` | Any long random string. Use the same value in `bf_scheduler`. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | From the Razorpay Dashboard → API Keys. Use test keys first. |
| `RAZORPAY_WEBHOOK_SECRET` | Set when creating the webhook (step E below). |
| `MAIL_FROM` | A sender address verified in Catalyst Mail. Leave empty to disable emails. |
| `YOUTUBE_API_KEY` | Google Cloud Console → enable "YouTube Data API v3" → create an API key. |
| `IG_BUSINESS_ACCOUNT_ID` / `IG_ACCESS_TOKEN` | Your own Instagram Business account, connected to a Meta app with `instagram_basic` and `pages_show_list` permissions. |
| `ADMIN_EMAILS` | Comma-separated. Only these emails can onboard as admin. |
| `BUSINESS_FEE_PERCENT` / `CREATOR_FEE_PERCENT` / `GST_ON_FEE_PERCENT` | Commission model. Defaults are 10 / 0 / 18. |
| `AUTO_RELEASE_DAYS` | Days after publishing before held funds release automatically. Default is 7. |

**D. Cron jobs**

Go to Job Scheduling:
1. Create a Job Pool, e.g. `bf_pool`.
2. Create 3 cron jobs that all use the function **bf_scheduler**:

| Name | Schedule (IST) | Job param |
|---|---|---|
| `metrics_sync` | Daily 02:00 | `task = sync_metrics` |
| `auto_release` | Every hour | `task = auto_release` |
| `reminders` | Daily 09:00 | `task = reminders` |

**E. Razorpay**

1. Enable **Route** on your account.
2. Create a **Linked Account** for each creator. It is KYC-verified by Razorpay. Its `acc_...` ID is what the creator saves via `PUT /creators/me/payout-account`.
3. Add a webhook:
   - URL: `…/server/brandfluence_api/webhooks/razorpay`
   - Events: `payment.captured`, `order.paid`, `payment.failed`

> Before going live, confirm the fee/GST model, invoicing, and marketplace/KYC obligations with your CA or lawyer.

## The core flow (Deal statuses)

```
offer_sent → negotiation ⇄ (counter offers) → accepted → contract_signed
→ payment_secured → in_progress → content_submitted ⇄ revision_requested
→ approved → published → completed
(side exits: rejected, cancelled, disputed → admin resolves)
```

The server enforces every step:
- You can't pay before both sides sign.
- You can't submit content before payment is secured.
- You can't publish before approval.
- You can't release payment while a dispute is open.
- You can't request more revisions than the agreed limit.

## API quick reference

Base path: `/server/brandfluence_api`

| Area | Endpoints |
|---|---|
| Onboarding | `GET /me`, `POST /me/onboard` |
| Lists | `GET /meta/categories`, `GET /meta/options` |
| Creator | `GET/PUT /creators/me`, `GET /creators/me/dashboard`, `POST /creators/me/social`, `POST /creators/me/social/:id/sync`, CRUD `/creators/me/rates`, `/creators/me/portfolio`, `/creators/me/availability`, `PUT /creators/me/payout-account`, `GET /creators/:id` |
| Business | `GET/PUT /businesses/me`, `POST /businesses/me/verification`, `GET /businesses/me/dashboard`, CRUD `/businesses/me/campaigns`, `GET /businesses/:id` |
| Discovery | `GET /discover/creators?category=&city=&platform=&min_followers=&min_engagement=&max_price=&verified=1&sort=` |
| Deals | `POST /deals`, `GET /deals`, `GET /deals/:id`, `POST /deals/:id/counter`, `/accept`, `/reject`, `/cancel`, `GET /deals/:id/contract`, `POST /deals/:id/sign` |
| Content | `POST /deals/:id/start`, `POST /deliverables/:id/submissions`, `POST /submissions/:id/approve`, `POST /submissions/:id/request-changes`, `POST /deliverables/:id/publish`, `PUT /deliverables/:id/metrics` |
| Chat | `GET/POST /deals/:id/messages` |
| Payments | `POST /deals/:id/payment-order`, `POST /payments/verify`, `POST /deals/:id/release`, `GET /wallet`, `POST /webhooks/razorpay` |
| Trust | `POST /deals/:id/reviews`, `POST /deals/:id/disputes` |
| Files | `POST /uploads/url` (presigned upload), `GET /uploads/url?key=` (presigned view) |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| Admin | `GET /admin/stats`, `/admin/users`, `/admin/creators`, `/admin/businesses`, `/admin/deals`, `/admin/payments`, `/admin/audit`, `/admin/disputes`, `GET /admin/disputes/:id` (all evidence), `POST /admin/disputes/:id/resolve` (release / refund / partial / dismiss), verification endpoints |

## Known MVP limits

- **Social stats**
  - YouTube is verified through the official API.
  - Instagram is verified via Business Discovery; this only works for Business/Creator accounts.
  - Other platforms are self-reported and flagged as unverified.
  - Audience demographics need creator-side OAuth (Phase 2).
- **Campaign metrics** after publishing are self-reported or entered by an admin. Automatic post-level insights come with OAuth in Phase 2.
- **Discovery results** are cached for 1 hour.
- **Upload size** is not limited by the server. Set a limit in the frontend, and optionally a bucket lifecycle rule.
