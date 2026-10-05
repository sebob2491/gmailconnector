# gmail-multi-mcp

A Gmail connector (MCP server) for Claude that works with **several Gmail accounts at once**. It has
the same tools as the built-in Gmail connector (`search_threads`, `get_thread`, `send_message`,
`reply`, `forward`, drafts, labels, trash, spam, …). Each tool also takes an `account` argument, and
there's a new `list_accounts` tool.

```
You:    Anything from my landlord this week, in either inbox?
Claude: search_threads { query: "from:landlord newer_than:7d" }   → searches personal + work
Claude: get_thread     { account: "personal", threadId: "…" }
You:    Reply from my personal address saying Tuesday works.
Claude: reply          { account: "personal", messageId: "…", body: "Tuesday works for me." }
```

## How multiple accounts work

| Situation | Behaviour |
|---|---|
| `search_threads`, `list_drafts`, `list_labels` with no `account` | Runs on **every** linked account. `search_threads` merges the results from all accounts newest first, and each thread says which account it's in; `list_drafts` and `list_labels` group results by account. The returned `nextPageToken` continues every account at once (each account returns a page, so the merged order is newest first within each page). If one account fails, the others still return results, and the next page tries the failed one again. Threads or drafts Gmail can't return just then are skipped and listed under `unavailable`. |
| Any other tool with no `account` | Uses the only account if just one is linked, or the default (local version: `accounts default …`). Otherwise the tool asks Claude to pick one. |
| `send_message`, `reply`, `forward` | Always need an explicit `account` when more than one is linked, even if a default is set, so mail is never sent from the wrong address. |
| IDs (message, thread, draft, label) | Belong to one account. Every result includes its `account`, and a wrong-account lookup returns an error that says so. |
| `account` values | The account's email address. The local version also accepts an alias you pick (`work`, `personal`, …). |
| Label arguments | Take label IDs **or** display names (e.g. `"Receipts"`), resolved per account. |

### Differences from the built-in Gmail connector

- New `list_accounts` tool, and an `account` argument on every tool. `list_accounts` also checks each
  account and says "needs re-link" when its Google access was revoked or has expired, so Claude can tell
  you which one to link again.
- New `get_attachment` tool: Claude can read attachments. Text, CSV, HTML, calendar invites, Word
  (.docx), Excel (.xlsx) and PowerPoint (.pptx) come back as text; images as images; PDFs as extracted
  text (when the PDF has a text layer with standard fonts), otherwise as the PDF file itself for clients
  that read PDFs.
- New `bulk_update` and `bulk_trash` tools: archive, mark read/unread, star, label, trash or report as
  spam many emails at once, across every account, chosen with a Gmail search (e.g. "archive all
  promotions older than a week"). They support a dry run that previews what would change, and Claude
  is told to show you that preview first. Up to 500 emails per account per run by default (`maxEmails`
  raises it to 2,000). Only emails that don't already have the change are counted and changed (archiving
  "category:promotions" only touches promotions still in the inbox), so running the same change again
  continues with the rest. With thread or message IDs, the IDs left over are returned to pass next time.
  If a run fails partway, the result says how many emails were changed and how to finish.
- `messageFormat` defaults to `PLAIN_TEXT` instead of `FULL_CONTENT`, which keeps HTML out of Claude's context.
- `search_threads` shows each thread's **5 most recent** messages (not the oldest), plus `totalMessages`.
  Results are compact: one-email threads are shown flat, previews are cleaned of the invisible padding
  and HTML codes that marketing emails contain, and recipients are listed only when an email wasn't
  addressed to just you. A 50-email search comes back about half the size of the raw Gmail data.
- `get_message`, `get_thread` and `get_draft` shorten bodies over 20,000 characters (with a note saying
  how much was left out). Pass `maxBodyChars: 0` for the full text. Replies and forwards always use the
  whole email.
- `get_message` and `get_thread` cut links longer than 200 characters (almost always marketing tracking
  redirects) to their website, e.g. `https://click.shop.com/…`, with a note saying so. A typical store
  email shrinks from tens of thousands of characters to a few thousand. `messageFormat: "FULL_CONTENT"`
  returns the full links. Drafts are never shortened, so editing one can't break its links.
- `get_thread` hides each reply's quoted copy of the earlier messages ("On … wrote:" and below), since
  those messages are in the result anyway. A real 13-email conversation went from about 41,000 to 4,700
  characters. Replies that answer between quoted lines are left alone, and `get_message` still shows any
  one email in full. With bodies, the subject is given once for the thread (and on a message only when
  it changes), and messages don't repeat their preview snippet or the thread ID.
- `update_draft` **keeps** existing attachments unless you pass `attachments`. Pass `[]` to remove them.
- `reply` and `create_draft` with `replyToMessageId` quote the original message the way Gmail does.
- `forward` re-attaches the original message's attachments, up to Gmail's 25 MB limit (larger ones are
  refused before anything is downloaded; forward those in Gmail, which sends them as Drive links).
- If sending fails with a server or network error, the error says the email may have gone out anyway,
  so Claude checks your Sent folder instead of sending it twice.
- The two legacy `apply_sensitive_*_label` tools are left out. `trash_*` and `mark_*_spam` cover them.

## Setup: hosted, for claude.ai on the web and phone

The connector runs as a free Cloudflare Worker that deploys straight from this GitHub repo. You
sign into it from claude.ai just like the built-in Gmail connector. Everything below works from a
phone browser. It takes about 15 minutes, in three places: Cloudflare, Google Cloud, then Claude.

### 1. Deploy to Cloudflare (about 5 minutes)

1. Sign up at <https://dash.cloudflare.com/sign-up> (the free plan is enough).
2. Go to **Workers & Pages → Create → Import a repository**. Connect GitHub and pick
   `gmailconnector`.
3. Fill in the form:
   - **Project name:** `gmail-multi-mcp` (it must match `name` in `wrangler.jsonc`).
   - **Deploy command:** `npx wrangler deploy` (the default). Leave the build command empty.
4. Deploy. The first deploy creates the Worker's storage (a KV namespace) automatically.
5. Open the Worker's URL, `https://gmail-multi-mcp.<your-subdomain>.workers.dev`. You'll see a
   **setup page** that lists the exact URLs for the next steps, each with a Copy button.

### 2. Create a Google OAuth client (about 8 minutes)

Every Gmail account you link uses this one client. Google doesn't let anyone else create it for you.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. Go to **APIs & Services → Library → Gmail API** and click **Enable**.
3. Go to **Google Auth Platform** (also called *OAuth consent screen*):
   - **Branding:** app name (e.g. "My Gmail connector") and your email. Under **App domain**, fill in
     the **home page**, **privacy policy link** and **authorized domain** shown on your connector's
     setup page (the connector serves its own privacy policy at `/privacy`). Google requires these
     before you can publish.
   - **Audience:** user type **External**, then **Publish app** so the status reads **In production**.
     In *Testing*, Google expires logins every 7 days.
   - **Data access:** add the scope `https://www.googleapis.com/auth/gmail.modify`.
4. Go to **Clients → Create client**:
   - Application type **Web application**.
   - **Authorized redirect URIs:** paste the redirect URI from the setup page
     (`https://gmail-multi-mcp.<your-subdomain>.workers.dev/google/callback`).
   - Create, then copy the **Client ID** and **Client secret**.
5. Back in Cloudflare, open your Worker → **Settings → Variables and Secrets → Add**. Add two
   variables of type **Secret**: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Add one more variable, of type **Text**: `ALLOWED_EMAILS`, with your Gmail address as its value
   (for several of your own addresses, separate them with commas). **This step is required:** the
   connector refuses every sign-in until it's set, so nobody who comes across your Worker's URL can
   claim it before you do. Then **Deploy**.

Reload the setup page: steps 1 and 2 should now show **✓ Done**.

### 3. Add it to Claude and sign in (about 2 minutes)

1. In claude.ai, go to **Customize → Connectors → Add custom connector**. Name it (e.g.
   "Gmail (all accounts)") and paste the connector URL from the setup page (`…workers.dev/mcp`).
2. Press **Connect**. You'll see a consent page. Press **Continue with Google** and sign in with
   the Gmail account you put in `ALLOWED_EMAILS`. Google will warn "Google hasn't verified this app"; that's expected for
   your own app. Tap **Advanced → Go to …** and allow Gmail access.
3. On the account page, tap **＋ Link another Gmail account** for each extra inbox, then
   **Done — connect to Claude**.

You can add or remove accounts later at `…workers.dev/accounts`. Claude sees the change within a
minute, without reconnecting. The same page has **Disconnect Claude**, which signs Claude out of the
connector everywhere it's connected (your linked accounts stay linked).

That page also checks each account's Google access every time you open it:

- **Working**: Claude can use it.
- **Needs re-link**: Google no longer accepts the account's sign-in, usually because its password
  changed, its access was removed at myaccount.google.com/permissions, or (in *Testing* mode) its
  7 days ran out. Tap **Re-link** and sign in to that account again; Google preselects it.
- **Couldn't check**: Google couldn't be reached or answered with an error. The account may be fine;
  reload the page later.

**Who can use it:** only the addresses in `ALLOWED_EMAILS` can sign in, and the first of them to sign
in becomes the owner (connectors set up before `ALLOWED_EMAILS` was required keep their owner, who can
still sign in). Linked accounts can't sign in, so someone with access to one of your linked inboxes
(for example a work admin) can't use it to reach the others. Anyone else is turned away. Signing in
only proves who you are: it never re-adds an account you removed; use **Link** for that. If you take
an address off `ALLOWED_EMAILS`, Claude connections made by that address stop working.

Tokens are only ever sent back to Claude (`https://claude.ai`, `https://claude.com`, or a local Claude
app at `localhost`); override the hosts with `ALLOWED_REDIRECT_HOSTS`. Variables you add in the
dashboard are kept when the Worker redeploys.

**Cloudflare's free plan** allows 50 outgoing calls and 10 ms of CPU per request. The connector
batches Gmail calls to stay well inside that: searching five inboxes takes about 15 calls, and
archiving 2,000 emails in each of five inboxes about 35. If Claude ever reports errors like "exceeded
CPU" or "too many subrequests", switch the Worker to the Workers Paid plan ($5/month), which raises
both limits.

**If the first deploy fails to create storage:** in Cloudflare, go to **Storage & Databases → KV →
Create** and make a namespace. Then under your Worker's **Settings → Bindings → Add → KV
namespace**, name the binding `OAUTH_KV`, pick that namespace, and redeploy.

## Setup: local, for Claude Desktop or Claude Code

You need Node.js 22 or newer. Setup has three parts: create a Google OAuth client (once), link each
Gmail account (once per account), and add the server to Claude.

### 1. Create a Google OAuth client (one time, about 5 minutes)

Every Gmail account you link uses this one client.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. Go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles):
   - User type **External**. Fill in an app name and your email.
   - Under **Data access / Scopes**, add `https://www.googleapis.com/auth/gmail.modify`.
   - Under **Audience**, click **Publish app** so the status reads **In production**.
     If you leave it in **Testing**, Google expires your tokens every 7 days and you'd have to
     re-link each account weekly. (In Testing you'd also have to add every Gmail address under
     "Test users".) An unverified app is fine for personal use. When you link an account, Google shows
     "Google hasn't verified this app": click **Advanced → Go to (app name)**.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**. Choose
   application type **Desktop app**, then **Download JSON**.
5. Save the downloaded file as `~/.config/gmail-multi-mcp/credentials.json`.
   Instead, you can set the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables, or
   pass `--credentials /path/to/file.json` to `accounts add`. Either way, `accounts add` saves the
   client to that `credentials.json` so the server Claude launches can find it.

> Google Workspace (work/school) accounts: some admins block third-party apps. If linking fails
> with "access blocked", ask your admin to allow the app's client ID. If your Cloud project is inside
> that Workspace org, you can use user type **Internal** instead.

### 2. Install and link your accounts

```bash
git clone https://github.com/sebob2491/gmailconnector
cd gmailconnector
npm install && npm run build

node dist/src/index.js accounts add --alias personal
node dist/src/index.js accounts add --alias work
node dist/src/index.js accounts list
```

`accounts add` opens Google's sign-in page. Pick the account to link and approve Gmail access.
Repeat the command once for each account. If the browser is on another machine (for example over
SSH), open the printed URL there. The last page will fail to load; copy that page's full URL
(`http://127.0.0.1:…/?code=…`) and paste it into the terminal.

Other account commands:

```bash
node dist/src/index.js accounts default work           # used by read tools when no account is given
node dist/src/index.js accounts alias me@gmail.com home
node dist/src/index.js accounts remove work            # unlinks and revokes the token
```

(Run `npm link` once if you'd rather type `gmail-multi-mcp` instead of `node dist/src/index.js`.)

### 3. Add it to Claude

**Claude Desktop:** edit `claude_desktop_config.json`, found under
*Settings → Developer → Edit Config*. On macOS it's at `~/Library/Application Support/Claude/`,
on Windows at `%APPDATA%\Claude\`. Add:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/gmailconnector/dist/src/index.js"]
    }
  }
}
```

Then restart Claude Desktop.

**Claude Code:**

```bash
claude mcp add --scope user gmail-multi -- node /ABSOLUTE/PATH/TO/gmailconnector/dist/src/index.js
```

You can link more accounts at any time. The server picks them up without a restart.

## Where things are stored

**Hosted:** linked accounts and their Google refresh tokens live in the Worker's KV namespace in
your Cloudflare account. The refresh tokens are useless without `GOOGLE_CLIENT_SECRET`, which is
stored as an encrypted Worker secret. Claude's own tokens for the connector are stored only as
hashes.

**Local:**

- `~/.config/gmail-multi-mcp/accounts.json` holds each account's email, alias and **refresh token**.
  The file is created with owner-only permissions (0600). Anyone who can read it can read and send
  your mail, so treat it like a password. Set `GMAIL_MCP_CONFIG_DIR` to use another folder.
- `~/.config/gmail-multi-mcp/credentials.json` holds your OAuth client.

The only scope requested is `gmail.modify`: read, compose, send, label and trash. It can't
permanently delete mail or change account settings. Revoke access at any time with
`accounts remove`, or at <https://myaccount.google.com/permissions>.

## Development

```bash
npm test        # builds both versions, then runs unit tests, MCP tests against a fake Gmail API,
                # and an end-to-end run of the Worker in workerd (Cloudflare's runtime) with Google faked
npm run build   # Node CLI → dist/
npm run build:worker   # Worker bundle → dist-worker/ (a dry-run deploy)
```

Code layout:

| File | What it does |
|---|---|
| `worker/index.ts` | Cloudflare Worker entry: OAuth provider in front of a stateless MCP endpoint at `/mcp` |
| `worker/routes.ts`, `worker/pages.ts` | Setup page, consent page, Google sign-in, and the account linking page |
| `worker/owner.ts` | Account storage in KV, and who may sign in |
| `src/index.ts` | CLI: `accounts …` subcommands, or runs the stdio server |
| `src/server.ts` | MCP tool definitions and account routing (`account` → mailbox, fan-out across accounts) |
| `src/mailbox.ts` | Gmail operations for one account: search, read, send, reply, forward, drafts, labels |
| `src/gmailClient.ts` | Authenticated Gmail REST calls, token caching and refresh, retries |
| `src/oauth.ts` | Google OAuth loopback flow with PKCE, token refresh and revoke |
| `src/mime.ts`, `src/format.ts` | Building outgoing RFC 822 messages and turning Gmail API messages into tool output |
| `src/accounts.ts`, `src/accountStore.ts` | Account lookup (shared) and `accounts.json` persistence (local) |
| `src/google.ts` | Google OAuth endpoints and token calls (shared by the CLI and the Worker) |
