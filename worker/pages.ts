/** Server-rendered HTML for the connector's setup, consent and account pages. */
import type { ClientCheck } from "./clientCheck.js";
import type { HistoryEntry } from "../src/history.js";
import type { AccountHealth } from "./health.js";
import type { UpdateAvailable } from "./version.js";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--text:#1f1e1c;--muted:#6b6862;--line:#e3e0da;--accent:#c96442;--accent-text:#fff;--ok:#2f7d4f;--warn:#a15c07;--bad:#b3261e;--code:#f0eee9}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--text:#ecebe8;--muted:#a19e97;--line:#3a3935;--accent:#d97757;--accent-text:#1c1b19;--ok:#6cc08b;--warn:#e0a458;--bad:#f28b82;--code:#1f1e1c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:32px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:16px 0}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 8px}
h2{font-size:1.05rem;margin:0 0 8px}
p{margin:8px 0}
.muted{color:var(--muted);font-size:.93rem}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.9rem;font-weight:600;letter-spacing:.02em}
.brand svg{flex:none}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button.link{border:none;background:none;min-height:auto;padding:4px 6px;color:var(--bad);font-weight:500}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.actions form{margin:0}
ul.accounts{list-style:none;margin:8px 0 0;padding:0}
ul.accounts li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
ul.accounts li:first-child{border-top:none}
.email{overflow-wrap:anywhere;font-weight:500}
.account{min-width:0}
.health{font-size:.85rem;font-weight:600;margin-top:2px}
.health.ok{color:var(--ok)}
.health.bad{color:var(--bad)}
.health.warn{color:var(--warn)}
.health .reason{font-weight:400;color:var(--muted)}
.nickname{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;font-size:.88rem;color:var(--muted)}
.nickname label{display:flex;align-items:center;gap:6px}
.nickname input{width:9.5em;min-height:36px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font:inherit;font-size:.95rem}
.row-actions{display:flex;align-items:center;gap:4px;flex:none}
.row-actions form{margin:0}
button.small{min-height:36px;padding:6px 12px;font-size:.9rem}
.tag{display:inline-block;white-space:nowrap;font-size:.75rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:500;vertical-align:middle}
.notice{border-radius:10px;padding:10px 12px;margin:12px 0;font-size:.95rem}
.notice.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.notice.bad{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.notice.warn{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.copy{display:flex;gap:8px;align-items:stretch;margin:6px 0 2px}
.copy code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.copy button{min-height:auto;padding:6px 12px;font-size:.9rem}
ol.steps{margin:0;padding-left:22px}
ol.steps>li{margin:18px 0}
ol.steps>li::marker{font-weight:700}
.status{font-weight:600;font-size:.9rem;white-space:nowrap}
.status.ok{color:var(--ok)}
.status.todo,.status.unknown{color:var(--warn)}
.status.bad{color:var(--bad)}
h2.part{font-size:1.15rem}
ul.checks{list-style:none;margin:12px 0 0;padding:0}
.check{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}
.check:first-child{border-top:none}
.check .mark{flex:none;width:1.6em;height:1.6em;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.9rem;border:2px solid currentColor}
.check.ok .mark{color:var(--ok)}
.check.todo .mark,.check.unknown .mark{color:var(--warn)}
.check.bad .mark{color:var(--bad)}
.check .detail{display:block;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.check.bad .detail{color:var(--bad)}
a.button.open{min-height:40px;padding:8px 14px;font-size:.95rem}
.label{margin:10px 0 0}
.expect{font-size:.93rem;margin-top:10px}
.unchecked{font-size:.9rem;border-left:3px solid var(--warn);padding:4px 0 4px 10px;color:var(--muted)}
.notice.update .how{display:block;margin-top:6px}
.notice a{color:inherit}
.version{text-align:center;font-size:.8rem}
ul.activity{list-style:none;margin:8px 0 0;padding:0}
ul.activity li{padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
ul.activity li:first-child{border-top:none}
ul.activity .meta{display:block;font-size:.82rem;color:var(--muted)}
ul.activity .failed{color:var(--bad)}
`;

const LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 6l9 7 9-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

/** The copy buttons' script, allowed to run by the nonce (see htmlResponse). */
const copyScript = (nonce: string) => `<script nonce="${escapeHtml(nonce)}">
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;
navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1500)})});
</script>`;

/** A page. With `nonce` (one per response, also passed to htmlResponse) it includes the copy buttons' script. */
export function layout(title: string, body: string, opts: { nonce?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main><div class="brand">${LOGO}<span>Gmail · multiple accounts</span></div>${body}</main>${opts.nonce ? copyScript(opts.nonce) : ""}</body></html>`;
}

/**
 * Serves a page with no caching, no framing, and a policy that allows no scripts at all, except
 * (with `nonce`) the one script tag carrying that nonce. Forms may only post to this site.
 */
export function htmlResponse(html: string, init: { status?: number; headers?: Headers; nonce?: string } = {}): Response {
  const headers = init.headers ?? new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; ${init.nonce ? `script-src 'nonce-${init.nonce}'; ` : ""}img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(html, { status: init.status ?? 200, headers });
}

export function messagePage(
  title: string,
  message: string,
  opts: {
    status?: number;
    kind?: "ok" | "bad" | "warn";
    action?: { href: string; label: string };
    /** Extra response headers, e.g. cookies to set or clear. */
    headers?: Headers;
  } = {},
): Response {
  const body = `<div class="card"><h1>${escapeHtml(title)}</h1>
<div class="notice ${opts.kind ?? "bad"}">${escapeHtml(message)}</div>
${opts.action ? `<div class="actions"><a class="button primary" href="${escapeHtml(opts.action.href)}">${escapeHtml(opts.action.label)}</a></div>` : ""}</div>`;
  return htmlResponse(layout(title, body), { status: opts.status ?? 400, headers: opts.headers });
}

const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;

/**
 * "An update is available", with how to get it. `repo` is this copy's GitHub repository when the
 * build knew it (only shown to the signed-in owner).
 */
function updateNotice(update: UpdateAvailable, repo?: string): string {
  const actions = repo ? link(`https://github.com/${repo}/actions/workflows/update-from-upstream.yml`, "Update from upstream") : "<b>Update from upstream</b>";
  const copy = repo ? link(`https://github.com/${repo}`, "your copy on GitHub") : "your copy on GitHub";
  return `<div class="notice warn update"><b>An update is available.</b> ${escapeHtml(update.upstream)} has changes newer than the version running here (${link(update.compareUrl, "what changed")}, or ${link(update.commitsUrl, "its latest changes")}).
<span class="how">To update, open ${copy}: if it's a fork, press <b>Sync fork → Update branch</b>; otherwise open <b>Actions → ${actions} → Run workflow</b>. Cloudflare redeploys by itself a minute or two later.</span></div>`;
}

const versionFooter = (version: string) => `<p class="muted version">Version ${escapeHtml(version)}</p>`;

function copyRow(value: string): string {
  return `<div class="copy"><code>${escapeHtml(value)}</code><button type="button" data-copy="${escapeHtml(value)}">Copy</button></div>`;
}

/** The domain Google wants under "Authorized domains": the host minus its first label (e.g. you.workers.dev). */
export function authorizedDomain(origin: string): string {
  const labels = new URL(origin).hostname.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : labels.join(".");
}

/** Google Cloud console pages, one per setup step. Google may add ?project=… or ask which project to use. */
export const GOOGLE_CONSOLE = {
  createProject: "https://console.cloud.google.com/projectcreate",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  branding: "https://console.cloud.google.com/auth/branding",
  scopes: "https://console.cloud.google.com/auth/scopes",
  audience: "https://console.cloud.google.com/auth/audience",
  createClient: "https://console.cloud.google.com/auth/clients/create",
};

/**
 * The Cloudflare dashboard page with this Worker's variables, when the address shows the Worker's
 * name (name.subdomain.workers.dev); otherwise the list of Workers.
 */
export function cloudflareSettingsUrl(origin: string): string {
  const labels = new URL(origin).hostname.split(".");
  if (labels.length === 4 && labels.slice(-2).join(".") === "workers.dev" && /^[a-z0-9-]+$/.test(labels[0])) {
    return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${labels[0]}/production/settings`;
  }
  return "https://dash.cloudflare.com/?to=/:account/workers-and-pages";
}

type CheckState = "ok" | "todo" | "bad" | "unknown";

const CHECK_MARK: Record<CheckState, string> = { ok: "✓", todo: "○", bad: "✗", unknown: "?" };

/** One live check: a mark, a label, and (unless it passed) what to do. */
function checkItem(state: CheckState, label: string, detail = ""): string {
  return `<li class="check ${state}"><span class="mark" aria-hidden="true">${CHECK_MARK[state]}</span><span><b>${escapeHtml(label)}</b>${
    detail ? `<span class="detail">${escapeHtml(detail)}</span>` : ""
  }</span></li>`;
}

/** A step's status chip, beside its heading. */
const chip = (state: CheckState, text: string) => `<span class="status ${state}">${CHECK_MARK[state]} ${escapeHtml(text)}</span>`;

/** "Open …" link to the exact page a step happens on. */
const openLink = (href: string, label: string) =>
  `<p><a class="button open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a></p>`;

const labelled = (label: string, value: string) => `<p class="muted label">${escapeHtml(label)}</p>${copyRow(value)}`;

/** What the person should see once a step worked. */
const expect = (text: string) => `<p class="expect"><b>You should see:</b> ${text}</p>`;

/** For steps this page can't check: what goes wrong when they're skipped. */
const unchecked = (text: string) => `<p class="unchecked">This page can't check this step. ${text}</p>`;

export function statusPage(opts: {
  origin: string;
  googleConfigured: boolean;
  /** Google's answer about the configured client (absent when none is configured). */
  clientCheck?: ClientCheck;
  /** Whether ALLOWED_EMAILS is set (its addresses aren't shown: this page is public). */
  allowedEmailsSet: boolean;
  claimed: boolean;
  /** The scopes the connector asks Google for. */
  scopes: readonly string[];
  /** "owner/repo" of the repository with the setup instructions. */
  upstream: string;
  /** This response's script nonce (the page has copy buttons). */
  nonce: string;
  version: string;
  update?: UpdateAvailable;
}): string {
  const mcpUrl = `${opts.origin}/mcp`;
  const callback = `${opts.origin}/google/callback`;
  const check = opts.clientCheck;
  const accepted: CheckState = !opts.googleConfigured ? "todo" : check?.state === "ok" ? "ok" : check?.state === "bad" ? "bad" : "unknown";
  const acceptedDetail = !opts.googleConfigured
    ? "Checked once the client is added (step 7)."
    : check?.state === "bad"
      ? `${check.problem} (Google said ${check.code}.)`
      : check?.state === "unknown"
        ? `Couldn't check: ${check.reason}`
        : "";
  const owner: CheckState = opts.allowedEmailsSet || opts.claimed ? "ok" : "todo";
  const allDone = opts.googleConfigured && accepted === "ok" && owner === "ok" && opts.claimed;
  const readme = `https://github.com/${opts.upstream}#setting-up-a-copy-for-a-friend`;

  const body = `${opts.update ? updateNotice(opts.update) : ""}<div class="card"><h1>${allDone ? "Your Gmail connector is ready" : "Your Gmail connector is running"}</h1>
<p class="muted">${
    allDone
      ? "Everything below is done. Manage your linked accounts at any time from the accounts page."
      : "Finish setting it up from this page: each step links to the exact page in Google Cloud or Cloudflare, with the values to paste beside it. It takes about 15 minutes and works on a phone."
  }</p>
<ul class="checks" aria-label="Live checks">
${checkItem(opts.googleConfigured ? "ok" : "todo", "Google client configured", opts.googleConfigured ? "" : "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET aren't set yet (step 7).")}
${checkItem(accepted, "Client ID and secret accepted by Google", acceptedDetail)}
${checkItem(owner, "ALLOWED_EMAILS set", owner === "ok" ? "" : "Required before anyone can sign in (step 8).")}
${checkItem(opts.claimed ? "ok" : "todo", "Owner signed in", opts.claimed ? "" : "Happens when you connect from Claude (step 9).")}
</ul>
<div class="actions"><a class="button" href="/">Check again</a>${opts.claimed ? `<a class="button" href="/accounts">Manage accounts</a>` : ""}</div>
</div>

<div class="card"><h2 class="part">Part 1 · Google Cloud</h2>
<p class="muted">Sign in to Google Cloud with any Google account (it doesn't have to be the Gmail you'll link). If a page asks you to select a project, pick the one from step 1.</p>
<ol class="steps">
<li><h2>Create a project</h2>
${openLink(GOOGLE_CONSOLE.createProject, "Open: New project")}
<p>Give it any name (e.g. <i>Gmail connector</i>) and press <b>Create</b>.</p>
${expect("a notification that the project was created, and its name in the project picker at the top.")}</li>
<li><h2>Turn on the Gmail API</h2>
${openLink(GOOGLE_CONSOLE.gmailApi, "Open: Gmail API")}
<p>Press <b>Enable</b>.</p>
${expect("<b>API Enabled</b> on the Gmail API page, and a <b>Manage</b> button where Enable was.")}</li>
<li><h2>Describe the app (Branding)</h2>
${openLink(GOOGLE_CONSOLE.branding, "Open: Branding")}
<p>The first time, press <b>Get started</b>: any app name, your email as support email, Audience <b>External</b>, your email as contact, agree, <b>Create</b>. Then, on the Branding page under <b>App domain</b>, paste these and press <b>Save</b>. Google needs them before you can publish the app (step 5).</p>
${labelled("Application home page", `${opts.origin}/`)}
${labelled("Application privacy policy link", `${opts.origin}/privacy`)}
${labelled("Authorized domains → Add domain", authorizedDomain(opts.origin))}
${expect("your app name on the Branding page, and these three values after reloading it.")}</li>
<li><h2>Allow Gmail access (Data access)</h2>
${openLink(GOOGLE_CONSOLE.scopes, "Open: Data access")}
<p>Press <b>Add or remove scopes</b>, paste ${opts.scopes.length === 1 ? "this scope" : "these scopes, one at a time,"} under <b>Manually add scopes</b>, press <b>Add to table</b>, then <b>Update</b> and <b>Save</b>.</p>
${opts.scopes.map((scope) => copyRow(scope)).join("\n")}
${expect("the Gmail scope under <b>Your restricted scopes</b>.")}
${unchecked("If the scope is missing, Google can block the sign-in (\"Access blocked\") or leave Gmail access out, and the connector then says Gmail access wasn't granted.")}</li>
<li><h2>Publish the app (Audience)</h2>
${openLink(GOOGLE_CONSOLE.audience, "Open: Audience")}
<p>Press <b>Publish app</b>, then <b>Confirm</b>. You don't need Google's verification for your own use: when you sign in, Google warns that it hasn't verified the app; tap <b>Advanced → Go to …</b>.</p>
${expect("Publishing status <b>In production</b>.")}
${unchecked("If the app stays in <b>Testing</b>, Google signs every account out after 7 days (Claude loses access each week until you re-link), and only addresses listed as test users can sign in; everyone else sees \"Access blocked\".")}</li>
<li><h2>Create the OAuth client</h2>
${openLink(GOOGLE_CONSOLE.createClient, "Open: Create client")}
<p>Application type <b>Web application</b>, any name. Under <b>Authorized redirect URIs</b>, press <b>Add URI</b> and paste:</p>
${copyRow(callback)}
<p>Press <b>Create</b>.</p>
${expect("a window with the <b>Client ID</b> and <b>Client secret</b>. Copy both now (or <b>Download JSON</b>): Google shows the secret only once.")}</li>
</ol></div>

<div class="card"><h2 class="part">Part 2 · Cloudflare</h2>
<ol class="steps" start="7">
<li><h2>Give this connector the client ${chip(accepted === "ok" ? "ok" : accepted === "bad" ? "bad" : "todo", accepted === "ok" ? "Accepted by Google" : accepted === "bad" ? "Rejected by Google" : opts.googleConfigured ? "Added" : "To do")}</h2>
${openLink(cloudflareSettingsUrl(opts.origin), "Open: this Worker's settings")}
<p>Under <b>Variables and Secrets</b>, press <b>Add</b> (or edit the empty ones the Deploy button made). Type <b>Secret</b>, name:</p>
${copyRow("GOOGLE_CLIENT_ID")}
<p>value: the Client ID. Then again, name:</p>
${copyRow("GOOGLE_CLIENT_SECRET")}
<p>value: the Client secret. Press <b>Deploy</b> if Cloudflare asks.</p>
${expect("the first two checks at the top turn ✓ when you reload this page (allow a minute).")}</li>
<li><h2>Say who owns it ${chip(owner, owner === "ok" ? "Done" : "To do")}</h2>
<p>If you entered your Gmail address when deploying, this is done. Otherwise add one more variable, named</p>${copyRow("ALLOWED_EMAILS")}
<p>with your Gmail address as its value (several addresses: separate them with commas), then deploy.</p>
<p class="muted">Only these Google accounts can sign in. The connector refuses every sign-in until this is set, so nobody else who finds this page can claim it.</p></li>
</ol></div>

<div class="card"><h2 class="part">Part 3 · Claude</h2>
<ol class="steps" start="9">
<li><h2>Add it to Claude ${chip(opts.claimed ? "ok" : "todo", opts.claimed ? "Signed in" : "Not signed in yet")}</h2>
${openLink("https://claude.ai/settings/connectors", "Open: Claude's connector settings")}
<p>Press <b>Add custom connector</b>, name it (e.g. <i>Gmail (all accounts)</i>) and paste this URL:</p>${copyRow(mcpUrl)}
<p class="muted">Then press <b>Connect</b> and sign in with Google, using an address from <code>ALLOWED_EMAILS</code>. The first one to sign in becomes this connector's owner.</p></li>
<li><h2>Link more Gmail accounts</h2>
<p>While connecting, tap <b>Link another Gmail account</b> for each extra inbox. You can also manage them, and give them nicknames like <i>work</i>, at any time at:</p>${copyRow(`${opts.origin}/accounts`)}</li>
</ol></div>

<div class="card"><h2>Setting up a copy for a friend</h2>
<p class="muted">Each person runs their own copy, on their own Cloudflare account with their own Google client, so nobody can see anyone else's mail. Send them the instructions: ${link(readme, "Setting up a copy for a friend")}.</p></div>
${versionFooter(opts.version)}`;
  return layout("Gmail connector setup", body, { nonce: opts.nonce });
}

export function privacyPage(origin: string): string {
  const body = `<div class="card"><h1>Privacy policy</h1>
<p class="muted">For the Gmail connector at ${escapeHtml(origin)}.</p>
<p>This is a personal connector that lets its owner use their own Gmail accounts from Claude. It is run by that owner on their own Cloudflare account, not by a company.</p>
<h2>What it accesses</h2>
<p>With your permission, it uses Google's Gmail API (the <code>gmail.modify</code> scope) to search, read, draft, send, label and trash email in the Gmail accounts you link, only when you ask Claude to.</p>
<h2>What it stores</h2>
<p>For each linked account it stores the email address and a Google sign-in token, in the owner's Cloudflare storage. It does not keep copies of your email. Email content passes through only while answering a request.</p>
<h2>Sharing</h2>
<p>Data is sent only to Google (to carry out your requests) and to Claude (to show you the results). It is never sold, used for advertising, or shared with anyone else.</p>
<p>When you ask Claude to unsubscribe you from a sender, the connector sends that sender's standard unsubscribe request to the unsubscribe address given in its emails, or sends an unsubscribe email from your account; it does this only when you ask.</p>
<h2>Removing access</h2>
<p>Remove an account at <a href="${escapeHtml(origin)}/accounts">${escapeHtml(origin)}/accounts</a>, which also revokes its token, or revoke access at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. The same page can disconnect Claude, which ends Claude's access to the connector.</p>
<p class="muted">Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>
</div>`;
  return layout("Privacy policy", body);
}

export function consentPage(opts: {
  clientName: string;
  redirectHost: string;
  /** Where the form posts: the authorization URL itself, so the request is parsed again on POST. */
  action: string;
  csrf: string;
  local: boolean;
}): string {
  const body = `<div class="card"><h1>Connect your Gmail to ${escapeHtml(opts.clientName)}</h1>
<p><b>${escapeHtml(opts.clientName)}</b> is asking to read, send and organize email in the Gmail accounts you link here.</p>
<p class="muted">Access will be sent to <b>${escapeHtml(opts.redirectHost)}</b>. Next you'll sign in with Google. You'll choose which Gmail accounts to share on the next page.</p>
<p class="muted">Only continue if you just started connecting from your own Claude account.</p>
${opts.local ? `<div class="notice warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</div>` : ""}
<form method="post" action="${escapeHtml(opts.action)}" class="actions">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<button class="primary" name="decision" value="approve">Continue with Google</button>
<button name="decision" value="deny">Cancel</button>
</form></div>`;
  return layout("Connect Gmail", body);
}

/** How the accounts page describes an account's Google access. */
function healthLine(health: AccountHealth | undefined): string {
  if (!health) return "";
  if (health.state === "working") return `<div class="health ok">Working</div>`;
  if (health.state === "relink") {
    return `<div class="health bad">Needs re-link <span class="reason">Google no longer accepts its sign-in (password changed, access removed, or it expired).</span></div>`;
  }
  return `<div class="health warn">Couldn't check <span class="reason">${escapeHtml(health.reason)}</span></div>`;
}

/** "2026-11-02 14:05 UTC" for an ISO time (the page has no script to show the viewer's local time). */
function utcTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The accounts page's "Recent activity" card: what Claude changed, newest first, and a button to clear it. */
function activityCard(entries: HistoryEntry[], csrf: string): string {
  const rows = entries
    .map((e) => {
      const status =
        e.outcome === "error"
          ? ` <span class="failed">Failed${e.error ? `: ${escapeHtml(e.error)}` : ""}</span>`
          : e.outcome === "partial"
            ? ` <span class="failed">Partly done${e.error ? `: ${escapeHtml(e.error)}` : ""}</span>`
            : "";
      const undone = e.undone ? `<span class="tag">undone</span>` : "";
      const accounts = e.accounts.length ? ` · ${escapeHtml(e.accounts.join(", "))}` : "";
      return `<li><span class="meta">${escapeHtml(utcTime(e.time))}${accounts}</span>${escapeHtml(e.summary)}${undone}${status}</li>`;
    })
    .join("");
  return `<div class="card"><h2>Recent activity</h2>
<p class="muted">What Claude changed through this connector, newest first. Archiving, labeling, trash and spam changes can be undone: ask Claude to undo one.</p>
${entries.length ? `<ul class="activity">${rows}</ul>` : `<p class="muted">Nothing yet.</p>`}
${entries.length ? `<form method="post" action="/accounts/clear-activity" class="actions">${csrf}<button>Clear activity</button></form>` : ""}</div>`;
}

export function accountsPage(opts: {
  accounts: { email: string; alias?: string; health?: AccountHealth }[];
  owner?: string;
  csrf: string;
  connecting?: { clientName: string; redirectHost: string };
  notice?: { kind: "ok" | "bad" | "warn"; text: string; link?: { href: string; label: string } };
  version: string;
  update?: UpdateAvailable;
  /** This copy's GitHub repository, when the build knew it. */
  repo?: string;
  /** The latest activity log entries, newest first (absent while connecting Claude, or when unreadable). */
  activity?: HistoryEntry[];
}): string {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">`;
  const rows = opts.accounts
    .map(({ email, alias, health }) => {
      const owner = opts.owner && email.toLowerCase() === opts.owner.toLowerCase() ? `<span class="tag">owner</span>` : "";
      const emailField = `<input type="hidden" name="email" value="${escapeHtml(email)}">`;
      // Re-linking is the usual link flow, with this address preselected at Google.
      const relink =
        health?.state === "relink"
          ? `<form method="post" action="/accounts/link">${csrf}${emailField}<button class="primary small" aria-label="Re-link ${escapeHtml(email)}">Re-link</button></form>`
          : "";
      // A nickname ("work", "personal") can be used instead of the address when talking to Claude.
      const nickname = `<form class="nickname" method="post" action="/accounts/nickname">${csrf}${emailField}
<label>Nickname <input name="nickname" value="${escapeHtml(alias ?? "")}" maxlength="32" placeholder="e.g. work" autocomplete="off" aria-label="Nickname for ${escapeHtml(email)}"></label>
<button class="small" aria-label="Save the nickname for ${escapeHtml(email)}">Save</button></form>`;
      return `<li><div class="account"><span class="email">${escapeHtml(email)}${owner}</span>${healthLine(health)}${nickname}</div>
<div class="row-actions">${relink}<form method="post" action="/accounts/remove">${csrf}${emailField}
<button class="link" aria-label="Remove ${escapeHtml(email)}">Remove</button></form></div></li>`;
    })
    .join("");
  const title = opts.connecting ? `Choose the Gmail accounts for ${opts.connecting.clientName}` : "Linked Gmail accounts";
  const body = `<div class="card"><h1>${escapeHtml(title)}</h1>
${
  opts.notice
    ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}${
        opts.notice.link ? ` <a href="${escapeHtml(opts.notice.link.href)}">${escapeHtml(opts.notice.link.label)}</a>` : ""
      }</div>`
    : ""
}
${opts.accounts.length ? `<ul class="accounts">${rows}</ul>` : `<p class="muted">No accounts linked yet.</p>`}
<div class="actions">
<form method="post" action="/accounts/link">${csrf}<button${opts.connecting ? "" : ` class="primary"`}>＋ Link ${opts.accounts.length ? "another" : "a"} Gmail account</button></form>
${
  opts.connecting
    ? `<form method="post" action="/accounts/done">${csrf}<button class="primary"${opts.accounts.length ? "" : " disabled"}>Done — connect to ${escapeHtml(opts.connecting.clientName)}</button></form>`
    : ""
}
</div>
${
  opts.connecting
    ? `<p class="muted">Access goes to <b>${escapeHtml(opts.connecting.redirectHost)}</b>. Every account listed here will be available to Claude.</p>
<form method="post" action="/accounts/cancel">${csrf}<button class="link">Cancel</button></form>`
    : `<p class="muted">Changes apply to Claude right away (allow up to a minute). A nickname lets you say "my work account" to Claude instead of the address.</p>`
}
</div>
${
  opts.connecting
    ? ""
    : `<div class="card"><h2>Claude's access</h2>
<p class="muted">Disconnecting signs Claude out of this connector everywhere it's connected (every Claude account and app). Your linked Gmail accounts stay linked; connect again from Claude's connector settings to use them.</p>
<form method="post" action="/accounts/disconnect" class="actions">${csrf}<button>Disconnect Claude</button></form></div>
${opts.activity ? activityCard(opts.activity, csrf) : ""}
${opts.update ? updateNotice(opts.update, opts.repo) : ""}`
}${versionFooter(opts.version)}`;
  return layout("Gmail accounts", body);
}
