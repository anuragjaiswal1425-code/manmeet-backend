# MANMEET Authoritative Remote Cloud Backend Service

This directory contains the production-ready, authoritative remote cloud backend server for the **MANMEET** Matrimonial & Dating Android application.

## Architectural Highlights
- **Persistent Storage**: Hybrid libSQL client (`@libsql/client`) supporting local file persistence (`data/manmeet_cloud.db`) for local testing AND remote Turso Cloud (`libsql://...`) for zero-cost permanent cloud persistence without ephemeral container wipeouts.
- **Server-Side Authorization**: Bearer token authentication (`Authorization: Bearer <token>`). User identity is strictly validated server-side. Users cannot read/write each other's private data, eavesdrop on chats, or delete foreign accounts.
- **Mutual Matching & Heartfelt Notes**: Server authoritatively detects mutual likes, generates matched conversations, and delivers heartfelt notes as icebreakers.
- **Idempotency & Replay Protection**: Supported via `idempotencyKey` tracking.
- **Zero Secrets in APK**: All backend credentials and database state remain on the server.
- **Zero Cost Deployment**: Designed to run cleanly on free-tier container (Render.com Free Web Service) and Turso Free libSQL Database (5 GB permanent storage, ₹0 cost).

## Zero-Cost Cloud Deployment (Turso + Render)

### Step 1: Create Free Turso Database (Persistent Storage)
1. Go to [https://turso.tech](https://turso.tech) (no credit card required).
2. Create a free database:
   ```bash
   turso db create manmeet-db
   turso db show manmeet-db --url
   turso db tokens create manmeet-db
   ```
3. Save the `libsql://...` database URL and Auth Token.

### Step 2: Deploy to Render (Free Web Service)
1. In [https://render.com](https://render.com), click **New > Web Service** and connect your repository.
2. **Root Directory**: Leave blank / default (`.`) if this is a dedicated backend repository (or `backend` if deploying from the parent mono-repo).
3. **Build Command**: `npm install`
4. **Start Command**: `npm start` (or `node server.js`)
5. In **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = `libsql://<your-db>.turso.io`
   - `DATABASE_AUTH_TOKEN` = `<your-turso-token>`
6. Deploy! Render will provide your public HTTPS endpoint: `https://<your-app>.onrender.com`.

### Step 3: Connect Android App
Call `ManmeetCloudBackend.configureRemoteUrl("https://<your-app>.onrender.com")` in your Android build/configuration.

## REST API Endpoints

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| `GET` | `/health` | No | Service health check |
| `POST` | `/api/auth/register-or-login` | No | Authenticate or create user |
| `POST` | `/api/auth/logout` | Bearer | Invalidate session token |
| `GET` | `/api/profile/:userId` | Bearer | Fetch user profile |
| `PUT` | `/api/profile` | Bearer | Update caller's own profile |
| `POST` | `/api/matches/like` | Bearer | Submit like / check mutual match |
| `POST` | `/api/matches/pass` | Bearer | Submit pass |
| `GET` | `/api/matches/:userId` | Bearer | Retrieve active mutual matches |
| `GET` | `/api/chat/messages` | Bearer | Fetch conversation messages |
| `POST` | `/api/chat/messages` | Bearer | Send message in match |
| `POST` | `/api/matches/unmatch` | Bearer | Unmatch candidates |
| `DELETE` | `/api/account/:userId` | Bearer | Purge account & cloud data |
