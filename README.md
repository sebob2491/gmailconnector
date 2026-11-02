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
| `search_threads`, `list_drafts`, `list_labels`, `list_filters` with no `account` | Runs on **every** linked account. `search_threads` merges the results from all accounts into one list in true newest-first order, across accounts and across pages, and each thread says which account it's in; `list_drafts`, `list_labels` and `list_filters` group results by account. The returned `nextPageToken` continues every account at once: a page holds the newest threads of all accounts together (so it can be shorter than pageSize × accounts), and the next page carries on from there with nothing skipped or repeated. If one account fails, the others still return results, and the next page tries the failed one again. Threads or drafts Gmail can't return just then are skipped and listed under `unavailable`. |
| Any other tool with no `account` | Uses the only account if just one is linked, or the default (local version: `accounts default …`). Otherwise the tool asks Claude to pick one. |
| `send_message`, `reply`, `forward` | Always need an explicit `account` when more than one is linked, even if a default is set, so mail is never sent from the wrong address. |
| IDs (message, thread, draft, label, filter) | Belong to one account. Every result includes its `account`, and a wrong-account lookup returns an error that says so. |
| `account` values | The account's email address, or a nickname you pick (`work`, `personal`, …): on the hosted connector's accounts page, or with `accounts alias` in the local version. |
| Label arguments | Take label IDs **or** display names (e.g. `"Receipts"`), resolved per account. |

### Differences from the built-in Gmail connector

- New `list_accounts` tool, and an `account` argument on every tool. `list_accounts` also checks each
  account (with a fresh token, so a revoked grant shows up right away) and says "needs re-link" when its
  Google access was revoked or has expired, so Claude can tell you which one to link again. It lists the
  other addresses an account can send from (send-as aliases) under `addresses`.
- The connector knows your own addresses: `reply` with `replyAll` never puts you in Cc, whether an email
  reached you through an alias, a dotted or `+tagged` form of your Gmail address, or googlemail.com.
  Emails you sent carry `fromMe: true` in search results, threads and messages, so "did I reply?" has
  an answer. The send-as list is read once an hour per account, only when something needs it.
- `includeSignature` on `send_message`, `reply`, `forward` and `create_draft` appends the Gmail
  signature of the sending address (as Gmail formats it, above any quoted or forwarded text).
- `reply` takes `attachments` like `send_message`, and `forward` takes extra ones to send along with the
  original's (the size limits count both). Recipients can be plain addresses or `Ann Lee <ann@example.com>`.
- An argument name a tool doesn't know (say `quary`) is an error instead of being dropped silently.
- New `get_attachment` tool: Claude can read attachments. Text, CSV, HTML, calendar invites, Word
  (.docx), Excel (.xlsx) and PowerPoint (.pptx) come back as text; images as images; PDFs as extracted
  text (when the PDF has a text layer: standard fonts, or embedded fonts with ToUnicode maps),
  otherwise as the PDF file itself for clients that read PDFs. PDF text comes in page order with
  "--- Page N ---" markers, with lines rebuilt from where the text sits on the page (so Word-made
  PDFs don't break mid-sentence) and filled-in form fields included. Spreadsheets keep empty cells in
  place and show dates as dates; Word tables come out row by row. Text files are decoded in their own
  character set. Very large files (and booby-trapped ones) are read only as far as needed, with a
  note saying what was left out. Emails list their attachments with file name, type, size and a stable
  `partId`, which is what `get_attachment` takes (Gmail's attachment IDs, often hundreds of characters
  long, are left out of results).
  Files that can't be shown (unreadable types over 1 MB, images over 4 MB, anything over 8 MB to read as text) are refused from their listed size and type before anything is downloaded, and the email's own bodies are never decoded just to find an attachment.
- New `bulk_update` and `bulk_trash` tools: archive, mark read/unread, star, label, trash or report as
  spam many emails at once, across every account, chosen with a Gmail search (e.g. "archive all
  promotions older than a week"). They support a dry run that previews what would change, and Claude
  is told to show you that preview first. Up to 500 emails per account per run by default (`maxEmails`
  raises it to 2,000). Only emails that don't already have the change are counted and changed (archiving
  "category:promotions" only touches promotions still in the inbox), so running the same change again
  continues with the rest. With thread or message IDs, the IDs left over are returned to pass next time
  (their count and where they start in your list, when more than 100 remain), and IDs the account doesn't
  have are listed under `notFound` with a reminder that IDs belong to one account. If a run fails
  partway, the result says how many emails were changed and how to finish.
- New `unsubscribe` tool: "unsubscribe me from everything Levi's sends, in both accounts". It looks at the
  newest matching emails, groups them by account and sender, and uses the unsubscribe option senders
  put in their emails' headers: the standard one-click request (sent by the connector, only to public
  https addresses), an unsubscribe email from that account (it shows in Sent), or, when the sender only
  offers a web page, the link for you to open (the connector never opens links). Claude is told to show
  you the plan first (`dryRun`) and to ask before doing it. The plan shows where each request goes: the
  full one-click address, or the recipient, subject and body of an unsubscribe email (all three come
  from the sender's own email, so the subject and body are capped at 200 and 1,000 characters). One-click
  requests only go to public https sites on the standard port, never to the connector itself or to an
  address inside a private network; an unsubscribe email is never sent to one of your own linked
  accounts; and the plan notes when an unsubscribe address isn't on the sender's own domain. Up to 10
  senders per run (`maxSenders` up to 20); the emails you already have stay until you archive or trash
  them with the bulk tools.
- New `list_filters`, `create_filter` and `delete_filter` tools: "file everything from my bank under
  Finance and skip the inbox". A filter matches on sender, recipient, subject, a Gmail search (or one
  that must not match), attachments or size, and can add existing labels, archive, mark read, star, mark
  or never mark important, trash, never send to spam, or set the inbox category. `create_filter` with
  `preview: true` counts the existing emails that match (up to 500, with examples) without creating
  anything, and Claude is told to show you that and ask before creating or deleting a filter. Filters
  only act on new mail, so the result gives the equivalent search for `bulk_update` or `bulk_trash` to
  handle the emails you already have. There is no forwarding action (Gmail needs a verified forwarding
  address, and an email could try to talk Claude into forwarding your mail); set that up in Gmail.
  Filters need the `gmail.settings.basic` scope. **After updating, add the scope
  `https://www.googleapis.com/auth/gmail.settings.basic` on your Google Cloud project's Data access page
  and re-link your accounts** (on the accounts page when hosted, or with `accounts add` locally) to use
  filters. Until an account is re-linked, everything else keeps working and the filter tools say how to
  re-link it (listing filters works either way).
- `messageFormat` defaults to `PLAIN_TEXT` instead of `FULL_CONTENT`, which keeps HTML out of Claude's context.
  HTML-only emails are converted the way a browser shows them, without what the sender hid (a
  newsletter's preview text, mobile-only copies of the content), and tables come out one row per line
  with tabs between cells, also when Outlook puts a paragraph in every cell.
- Results are compact JSON, so more mail fits in Claude's context. Emails show `from`, `to`, `cc`, `date`
  and `body`; addresses read `Ann Lee <ann@example.com>`. Instead of Gmail's label IDs, an email (or a
  thread) has flags that appear only when true: `unread`, `starred`, `important`, `inInbox` or
  `archived`, `sent`, `trash`, `spam`, `category` ("promotions", …) and `labels` with your own labels'
  names (read from the label list once per call, only when one appears, and kept for 10 minutes).
  `messageFormat: "RAW"` keeps Gmail's `labelIds`, and the label tools still return the label IDs they
  changed. Lists give one `viewUrlTemplate` instead of a Gmail link per item; single items (an email, a
  draft, sent mail) keep their own `viewUrl`. On sample data with two accounts, a 50-thread search of
  both went from 129,000 to 77,000 characters and a list of 20 drafts from 6,100 to 2,700.
- The tool list Claude loads at the start of every session is about a third smaller (about 34,900 instead
  of 51,900 characters, the new filter tools included): rules shared by many tools (the `account` argument, recipient formats, plain-text
  bodies, `messageFormat`) are stated once in the server instructions instead of in every tool, and the
  arguments' descriptions are short. Label colors are plain names (`colorPreset: "blue"`).
- `search_threads` shows each thread's **3 most recent** emails (not the oldest), the thread's `total`
  and flags, and the subject its first email had. One-email threads are shown flat, previews are cleaned
  of the invisible padding and HTML codes that marketing emails contain and cut to 140 characters, and
  recipients are listed only when an email wasn't addressed to just you. The search help Claude sees
  covers Gmail's full operator syntax.
- `get_message`, `get_thread` and `get_draft` shorten bodies over 20,000 characters (with a note saying
  so, and how much was left out when the body was read whole). Only the start of a long body is read
  and converted, so a 2 MB newsletter takes a few milliseconds. Pass `maxBodyChars: 0` for the full
  text. Replies and forwards always use the whole email.
- `get_message` and `get_thread` cut links longer than 200 characters (almost always marketing tracking
  redirects) to their website, e.g. `https://click.shop.com/…`, with a note saying so. A typical store
  email shrinks from tens of thousands of characters to a few thousand. `messageFormat: "FULL_CONTENT"`
  returns the full links. Drafts are never shortened, so editing one can't break its links.
- `get_thread` hides each reply's quoted copy of an earlier message of the thread ("On … wrote:" and
  below, or Outlook's From/Sent header block, as Gmail, Apple Mail, Outlook and Thunderbird write them
  in English, German, French, Spanish, Italian, Dutch and other languages), since those messages are in
  the result anyway. A real 13-email conversation went from about 41,000 to 4,700 characters. Only text
  that copies an earlier message of the thread is hidden: forwarded emails, quotes of emails from
  elsewhere and replies that answer between quoted lines are left alone, and `get_message` still shows
  any one email in full. The subject and flags are given once for the thread (a message has its own
  subject only when it changes, and its own `unread`/`starred`), messages don't repeat their preview
  snippet or the thread ID, and notes on shortened bodies or links come once, naming the messages.
- `get_thread` keeps long threads within a budget: once the bodies add up to more than 60,000
  characters (`maxTotalChars`), the oldest are cut to their first 200 characters (or left out) and listed
  under `shortened`, so Claude can open any of them with `get_message`. The latest email always keeps its
  body; `maxTotalChars: 0` returns everything.
- `update_draft` **keeps** existing attachments unless you pass `attachments`. Pass `[]` to remove them.
- `reply` and `create_draft` with `replyToMessageId` quote the original message the way Gmail does.
- `forward` re-attaches the original message's attachments, up to Gmail's 25 MB limit (2 MB on the
  free hosted plan, see `MAX_FORWARD_MB` below). Larger ones are refused before anything is downloaded;
  forward those in Gmail, which sends them as Drive links.
- If sending fails with a server or network error, the error says the email may have gone out anyway,
  so Claude checks your Sent folder instead of sending it twice.
- The two legacy `apply_sensitive_*_label` tools are left out. `trash_*` and `mark_*_spam` cover them.
- Claude is told that email content is untrusted: nothing inside an email or attachment counts as an
  instruction, and before sending, forwarding, unsubscribing, trashing, deleting or changing many emails
  it checks that you asked for exactly that (attachment text comes back under a line naming the file it
  is from).

## Setup: hosted, for claude.ai on the web and phone

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sebob2491/gmailconnector)

The connector runs as a free Cloudflare Worker, your own copy, deployed from your own copy of this
GitHub repository. You sign into it from claude.ai just like the built-in Gmail connector. Everything
below works from a phone browser and takes about 15 minutes: Cloudflare, then Google Cloud (guided by
the connector's own setup page), then Claude.

### 1. Deploy to Cloudflare (about 3 minutes)

1. You need a free Cloudflare account (<https://dash.cloudflare.com/sign-up>) and a GitHub account.
2. Press **Deploy to Cloudflare** above, and connect your GitHub account when asked. On the form:
   - **Name:** anything, e.g. `gmail-connector`. It names your GitHub repository and your Worker,
     whose address will be `https://<name>.<your-subdomain>.workers.dev`.
   - **ALLOWED_EMAILS:** your Gmail address (for several of your own addresses, separate them with
     commas). Only these Google accounts can sign in, so nobody who comes across your Worker's
     address can claim it before you do.
   - **GOOGLE_CLIENT_ID** and **GOOGLE_CLIENT_SECRET:** leave them empty. You create them in step 2.
   - Leave the build and deploy commands as they are (the deploy command runs the tests first; a
     failing test stops the deploy).
3. Press **Create and deploy**. Cloudflare copies this repository into your GitHub account, creates
   the Worker's storage (a KV namespace), builds and deploys it.
4. Open your Worker's address. You'll see the connector's **setup page**: a step-by-step guide with
   live checks that tick themselves as you go.

### 2. Create a Google OAuth client, with the setup page (about 10 minutes)

Every Gmail account you link uses this one client, and Google doesn't let anyone create it for you.
Follow the setup page: each step links to the exact Google Cloud page and shows the values to paste
beside it, with Copy buttons, and what you should see when it worked. In short:

1. Create a Google Cloud project (any name).
2. Enable the **Gmail API**.
3. **Google Auth Platform → Branding:** app name and your email (the first time, **Get started**, with
   audience **External**); under **App domain**, the home page, privacy policy link and authorized
   domain from the setup page. The connector serves its own privacy policy at `/privacy`.
4. **Data access:** add the scopes `https://www.googleapis.com/auth/gmail.modify` and
   `https://www.googleapis.com/auth/gmail.settings.basic` (the second one lets Claude create Gmail filters).
5. **Audience:** **Publish app**, so the status reads **In production**. In *Testing*, Google signs
   every account out after 7 days, and anyone not listed as a test user sees "Access blocked".
6. **Clients → Create client:** type **Web application**, with the setup page's redirect URI
   (`https://<your Worker's address>/google/callback`) under **Authorized redirect URIs**. Copy the
   **Client ID** and **Client secret** (Google shows the secret only once).

### 3. Give the Worker the Google client (about 1 minute)

In Cloudflare, open your Worker → **Settings → Variables and Secrets** (the setup page links straight
there) and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, type **Secret**, to the two values from
Google. If you didn't set `ALLOWED_EMAILS` while deploying, add it now too (it's required: the
connector refuses every sign-in until it's set). Variables you add in the dashboard are kept when the
Worker redeploys.

Reload the setup page: **Google client configured**, **Client ID and secret accepted by Google** and
**ALLOWED_EMAILS set** should all show ✓. (The connector checks the client by asking Google's token
endpoint about it; a wrong Client ID, a wrong secret or the wrong client type each get their own
explanation.)

### 4. Add it to Claude and sign in (about 2 minutes)

1. In claude.ai, go to **Settings → Connectors → Add custom connector**. Name it (e.g.
   "Gmail (all accounts)") and paste the connector URL from the setup page (`https://<your Worker's
   address>/mcp`).
2. Press **Connect**. You'll see a consent page. Press **Continue with Google** and sign in with
   the Gmail account you put in `ALLOWED_EMAILS`. Google will warn "Google hasn't verified this app"; that's expected for
   your own app. Tap **Advanced → Go to …** and allow Gmail access.
3. On the account page, tap **＋ Link another Gmail account** for each extra inbox, then
   **Done — connect to Claude**.

### Alternative: fork and import the repository yourself

Instead of the button, you can set the Worker up by hand:

1. On GitHub, press **Fork** on this repository.
2. In Cloudflare, go to **Workers & Pages → Create → Import a repository**, connect GitHub and pick
   your fork.
3. **Project name:** anything (Cloudflare deploys under the name you pick, whatever `wrangler.jsonc`
   says). **Build command:** `npm test` (every deploy runs the tests first, and a failing test stops
   it). **Deploy command:** `npx wrangler deploy` (the default).
4. Deploy. The first deploy creates the Worker's storage automatically. Then add `ALLOWED_EMAILS`
   (type **Text** or **Secret**) under the Worker's **Settings → Variables and Secrets**, and continue
   with step 2 above.

### Managing it

You can add or remove accounts later at `https://<your Worker's address>/accounts`. Claude sees the
change within a minute, without reconnecting. Give each account a **nickname** there (e.g. `work`,
`personal`: up to 32 letters, digits, spaces, `-` or `_`), and Claude can use it instead of the address
("search my work inbox"). The same page has **Disconnect Claude**, which signs Claude out of the
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

Sign-in codes are only ever sent to Claude's own callback for custom connectors,
`https://claude.ai/api/mcp/auth_callback` (and `https://claude.com/api/mcp/auth_callback`, its
announced future address), or to a local Claude app at `localhost`/`127.0.0.1` (any port); any other
page, even on claude.ai, is refused. To change the list, add a variable `ALLOWED_REDIRECT_URIS`:
comma-separated exact URIs, or prefixes ending in `*` (e.g. `https://claude.ai/api/*`); addresses must
still be https, or http to a loopback address. (The older `ALLOWED_REDIRECT_HOSTS`, any path on the
listed hosts, still works when `ALLOWED_REDIRECT_URIS` isn't set.) Client metadata documents are only
read from the same hosts (by default claude.ai and claude.com). Changing the list doesn't affect
existing connections. Variables you add in the dashboard are kept when the Worker redeploys.

Requests anyone can make without signing in (registering a Claude client, opening the consent page,
the setup page's check of the Google client, which Google answers once per 5 minutes at most) are
rate-limited per Worker instance (best effort: Cloudflare runs several instances), so someone who
finds the URL can't burn through the free plan's daily storage writes in one go.

**Cloudflare's free plan** allows 50 outgoing calls and 10 ms of CPU per request. The connector
batches Gmail calls to stay well inside that: searching five inboxes takes about 15 calls (a reply-all
or a signature adds one settings call per account per hour), `list_accounts` two per account, archiving
2,000 emails in each of five inboxes about 35, and unsubscribing from 20 senders across five inboxes
about 35. If Claude ever reports errors like "exceeded CPU" or "too many subrequests", switch the
Worker to the Workers Paid plan ($5/month), which raises both limits.

**Forwarding attachments** costs about 3 ms of CPU per MB of attachments, so on the free plan the
hosted connector forwards (and keeps in edited drafts) up to 2 MB of attachments per email; for
anything larger, Claude gives you a link to forward it in Gmail. On the paid plan, raise the limit
with a variable `MAX_FORWARD_MB` (e.g. `25`, Gmail's own limit) under the Worker's **Settings →
Variables and Secrets**. The local version always allows Gmail's 25 MB.

**If the first deploy fails to create storage:** in Cloudflare, go to **Storage & Databases → KV →
Create** and make a namespace. Then under your Worker's **Settings → Bindings → Add → KV
namespace**, name the binding `OAUTH_KV`, pick that namespace, and redeploy.

### Keeping it up to date

The setup page and the accounts page show the version that's running, and say **An update is
available** (with a link to what changed) when this repository has something newer. `/version` gives
the same as JSON. To update:

- **A Deploy-button copy** updates itself: its repository includes the **Update from upstream**
  workflow (`.github/workflows/update-from-upstream.yml`), which runs once a day, brings in this
  repository's changes, and pushes them; Cloudflare then builds and deploys the push. To update right
  away: on GitHub, open your copy → **Actions → Update from upstream → Run workflow**.
- **A fork** can use the same workflow, but GitHub keeps Actions off in forks until you turn them on
  once: open your fork's **Actions** tab and press **I understand my workflows, go ahead and enable
  them**. Or update by hand with **Sync fork → Update branch** on your fork's GitHub page.
- **Turn the daily update off:** in your copy, **Settings → Secrets and variables → Actions →
  Variables → New repository variable** `AUTO_UPDATE` with the value `false` (**Run workflow** still
  works), or disable the workflow under **Actions**.

If your copy has changes of its own that clash with an update, the workflow changes nothing and fails
with a message saying which files clash (GitHub emails you about failed runs). It never force-pushes.
An update that changes a workflow file can't be pushed with the workflow's built-in token: update
that once by hand, or add a repository secret `UPDATE_TOKEN` holding a fine-grained personal access
token for your copy with **Contents** and **Workflows** read and write. GitHub pauses scheduled
workflows in public repositories after 60 days without activity; it emails you first, and **Enable
workflow** under **Actions** turns it back on. Updates come from `sebob2491/gmailconnector` unless you
set the repository variable (for the workflow) and Worker variable (for the notice) `UPSTREAM_REPO`
to another `owner/repo`.

### Setting up a copy for a friend

Each person runs their own copy: their own Cloudflare Worker, their own Google client, their own
`ALLOWED_EMAILS`. Don't add a friend's address to your `ALLOWED_EMAILS` instead: everyone who can sign
in to a connector sees every Gmail account linked to it. Send them this page; they press **Deploy to
Cloudflare** themselves and follow steps 1 to 4 with their own accounts. Their copy updates itself
like yours (see above), and nothing about it depends on the name they pick.

## Setup: local, for Claude Desktop or Claude Code

### Claude Desktop (one click)

1. Download **`gmail-multi-mcp.mcpb`** from the
   [latest release](https://github.com/sebob2491/gmailconnector/releases/latest).
2. Double-click it (or drag it into Claude Desktop, or use **Settings → Extensions → Advanced
   settings → Install Extension…**) and click **Install**.
3. In a chat, say **"link my Gmail"**. Google's sign-in page opens in your browser: pick the
   account and allow Gmail access. Claude replies with the address it linked. Say it again for each
   other account ("link my work Gmail as work").

That's all: no terminal, no Google Cloud project, no config file. Claude Desktop ships its own
Node.js, so nothing else needs installing. Ask Claude to "unlink my work account" or "call
me@gmail.com home" to remove or rename accounts (`unlink_account`, `set_account_nickname`).

Things to know:

- **"Google hasn't verified this app."** The release's built-in sign-in client belongs to the
  maintainer's own, unverified Google project. Click **Advanced → Go to … (unsafe)** to continue.
  Google lets an unverified app sign in at most **100 users, ever**, so the built-in client is meant
  for the maintainer, family and friends. Please don't publish the `.mcpb` file more widely; anyone
  else should use their own client (next point).
- **Your own Google client.** In **Settings → Extensions → Gmail (multiple accounts) → Configure**,
  fill in **Your own Google client ID** and **secret** (create them as in
  [step 1 of the manual setup](#1-create-a-google-oauth-client-one-time-about-5-minutes)). The
  extension then signs in with your project instead. Accounts linked with the other client have to
  be linked again afterwards (refresh tokens belong to the client that issued them). Which client
  is used, in order: these settings → `credentials.json` / `GOOGLE_CLIENT_ID` from the manual setup →
  the built-in client. A release built without a built-in client says so in its release notes, and
  Claude tells you to fill in these settings when you try to link an account.
- If the browser can't be opened, Claude shows you the sign-in link instead. Sign-in links expire
  after 3 minutes; just ask again.
- The extension and the manual setup share the same files (see
  [Where things are stored](#where-things-are-stored)), so accounts linked one way also show up in
  the other.

#### For the maintainer: publishing a release

1. In your Google Cloud project (with the **Gmail API** enabled and the consent screen set up as in
   [step 1 below](#1-create-a-google-oauth-client-one-time-about-5-minutes), published **In
   production** so tokens don't expire after 7 days), create a client: **Google Auth Platform →
   Clients → Create client** (or **APIs & Services → Credentials → Create credentials → OAuth
   client ID**), application type **Desktop app**. Google documents that a desktop app's client
   secret can't be kept confidential, so shipping it inside the extension is expected; the limits
   above are what keep it personal.
2. In this GitHub repository, add two secrets under **Settings → Secrets and variables → Actions**:
   `GMAIL_MCP_DESKTOP_CLIENT_ID` and `GMAIL_MCP_DESKTOP_CLIENT_SECRET`.
3. Push a tag: `git tag v0.1.0 && git push origin v0.1.0` (or run the **Release desktop extension**
   workflow by hand). The workflow builds `gmail-multi-mcp.mcpb` with the client inside it and
   attaches it to a GitHub Release named after the tag; the tag also sets the extension's version.

To build the bundle yourself: `npm run pack:desktop` writes `dist-desktop/gmail-multi-mcp.mcpb`
(set the two variables above to include a built-in client; they end up in the bundle's
`server/google-client.json`, never in the repository).

### Manual setup (Claude Desktop or Claude Code)

You need Node.js 22 or newer. Setup has three parts: create a Google OAuth client (once), link each
Gmail account (once per account), and add the server to Claude.

#### 1. Create a Google OAuth client (one time, about 5 minutes)

Every Gmail account you link uses this one client.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. Go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles):
   - User type **External**. Fill in an app name and your email.
   - Under **Data access / Scopes**, add `https://www.googleapis.com/auth/gmail.modify` and
     `https://www.googleapis.com/auth/gmail.settings.basic` (for Gmail filters).
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

#### 2. Install and link your accounts

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

#### 3. Add it to Claude

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

You can link more accounts at any time, with `accounts add` or by asking Claude to "link my Gmail"
(the `link_account` tool works here too, with your own client). The server picks them up without a
restart.

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

The scopes requested are `gmail.modify` (read, compose, send, label and trash) and
`gmail.settings.basic` (filters; optional: an account linked without it works, except for creating
and deleting filters). Neither can permanently delete mail. Revoke access at any time with
`accounts remove`, or at <https://myaccount.google.com/permissions>.

## Development

```bash
npm test        # builds both versions, then runs unit tests, MCP tests against a fake Gmail API,
                # and an end-to-end run of the Worker in workerd (Cloudflare's runtime) with Google faked
npm run build   # Node CLI → dist/
npm run build:worker   # Worker bundle → dist-worker/ (a dry-run deploy)
npm run deploy  # tests, then deploys the Worker (what the Deploy to Cloudflare button runs)
```

Code layout:

| File | What it does |
|---|---|
| `worker/index.ts` | Cloudflare Worker entry: OAuth provider in front of a stateless MCP endpoint at `/mcp` |
| `worker/routes.ts`, `worker/pages.ts` | Setup page, consent page, Google sign-in, and the account linking page |
| `worker/owner.ts` | Account storage in KV, who may sign in, and where sign-in codes may go |
| `worker/clientCheck.ts` | The setup page's check that Google accepts the configured OAuth client |
| `worker/version.ts`, `worker/write-version.mjs` | The running version (recorded at build time) and the update check |
| `.github/workflows/update-from-upstream.yml` | Keeps copies up to date with this repository |
| `src/index.ts` | CLI: `accounts …` subcommands, or runs the stdio server |
| `src/server.ts` | MCP tool definitions and account routing (`account` → mailbox, fan-out across accounts) |
| `src/mailbox.ts` | Gmail operations for one account: search, read, send, reply, forward, drafts, labels |
| `src/gmailClient.ts` | Authenticated Gmail REST calls, token caching and refresh, retries |
| `src/oauth.ts` | Google OAuth loopback flow with PKCE, token refresh and revoke |
| `src/mime.ts`, `src/format.ts` | Building outgoing RFC 822 messages and turning Gmail API messages into tool output |
| `src/accounts.ts`, `src/accountStore.ts` | Account lookup (shared) and `accounts.json` persistence (local) |
| `src/google.ts` | Google OAuth endpoints and token calls (shared by the CLI and the Worker) |
