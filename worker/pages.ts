/** Server-rendered HTML for the connector's setup, consent and account pages. */

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
.tag{display:inline-block;white-space:nowrap;font-size:.75rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:500;vertical-align:middle}
.notice{border-radius:10px;padding:10px 12px;margin:12px 0;font-size:.95rem}
.notice.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.notice.bad{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.notice.warn{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.copy{display:flex;gap:8px;align-items:stretch;margin:6px 0 2px}
.copy code{flex:1;min-width:0;overflow-wrap:anywhere;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.copy button{min-height:auto;padding:6px 12px;font-size:.9rem}
ol.steps{margin:0;padding-left:22px}
ol.steps li{margin:14px 0}
.status{font-weight:600}
.status.ok{color:var(--ok)}
.status.todo{color:var(--warn)}
`;

const LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 6l9 7 9-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

const COPY_SCRIPT = `<script>
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;
navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1500)})});
</script>`;

export function layout(title: string, body: string, opts: { script?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main><div class="brand">${LOGO}<span>Gmail · multiple accounts</span></div>${body}</main>${opts.script ? COPY_SCRIPT : ""}</body></html>`;
}

export function htmlResponse(html: string, init: { status?: number; headers?: Headers } = {}): Response {
  const headers = init.headers ?? new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
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

function copyRow(value: string): string {
  return `<div class="copy"><code>${escapeHtml(value)}</code><button type="button" data-copy="${escapeHtml(value)}">Copy</button></div>`;
}

/** The domain Google wants under "Authorized domains": the host minus its first label (e.g. you.workers.dev). */
export function authorizedDomain(origin: string): string {
  const labels = new URL(origin).hostname.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : labels.join(".");
}

export function statusPage(opts: { origin: string; googleConfigured: boolean; claimed: boolean }): string {
  const mcpUrl = `${opts.origin}/mcp`;
  const callback = `${opts.origin}/google/callback`;
  const check = (done: boolean, doneText = "Done", todoText = "To do") =>
    `<span class="status ${done ? "ok" : "todo"}">${done ? `✓ ${doneText}` : `○ ${todoText}`}</span>`;
  const body = `<div class="card"><h1>Your Gmail connector is running</h1>
<p class="muted">Finish these steps to use it in Claude. This page updates as you go.</p>
<ol class="steps">
<li><h2>Connect Google ${check(opts.googleConfigured)}</h2>
<p>In Google Cloud's <b>Branding</b> page, under <b>App domain</b>, use these. Google needs them before you can publish the app.</p>
<p class="muted">Application home page</p>${copyRow(`${opts.origin}/`)}
<p class="muted">Application privacy policy link</p>${copyRow(`${opts.origin}/privacy`)}
<p class="muted">Authorized domain</p>${copyRow(authorizedDomain(opts.origin))}
<p>Then create an OAuth client of type <b>Web application</b> and add this <b>Authorized redirect URI</b>:</p>${copyRow(callback)}
<p class="muted">Then add its Client ID and Client secret to this Worker as the secrets <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.</p></li>
<li><h2>Add it to Claude ${check(opts.claimed, "Signed in", "Not signed in yet")}</h2>
<p>In Claude, open <b>Customize → Connectors → Add custom connector</b> and paste this URL:</p>${copyRow(mcpUrl)}
<p class="muted">Then press <b>Connect</b> and sign in with Google. The first Google account that signs in becomes this connector's owner.</p></li>
<li><h2>Link more Gmail accounts</h2>
<p>While connecting, tap <b>Link another Gmail account</b> for each extra inbox. You can also manage them any time at:</p>${copyRow(`${opts.origin}/accounts`)}</li>
</ol></div>`;
  return layout("Gmail connector setup", body, { script: true });
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
<h2>Removing access</h2>
<p>Remove an account at <a href="${escapeHtml(origin)}/accounts">${escapeHtml(origin)}/accounts</a>, which also revokes its token, or revoke access at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
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
<p class="muted">Access will be sent to <b>${escapeHtml(opts.redirectHost)}</b>. Next you'll sign in with Google; you can link more accounts after that.</p>
${opts.local ? `<div class="notice warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</div>` : ""}
<form method="post" action="${escapeHtml(opts.action)}" class="actions">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<button class="primary" name="decision" value="approve">Continue with Google</button>
<button name="decision" value="deny">Cancel</button>
</form></div>`;
  return layout("Connect Gmail", body);
}

export function accountsPage(opts: {
  accounts: string[];
  owner?: string;
  csrf: string;
  connecting?: { clientName: string; redirectHost: string };
  notice?: { kind: "ok" | "bad"; text: string };
}): string {
  const rows = opts.accounts
    .map(
      (email) => `<li><span class="email">${escapeHtml(email)}${opts.owner && email.toLowerCase() === opts.owner.toLowerCase() ? `<span class="tag">owner</span>` : ""}</span>
<form method="post" action="/accounts/remove"><input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}"><input type="hidden" name="email" value="${escapeHtml(email)}">
<button class="link" aria-label="Remove ${escapeHtml(email)}">Remove</button></form></li>`,
    )
    .join("");
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">`;
  const title = opts.connecting ? `Choose the Gmail accounts for ${opts.connecting.clientName}` : "Linked Gmail accounts";
  const body = `<div class="card"><h1>${escapeHtml(title)}</h1>
${opts.notice ? `<div class="notice ${opts.notice.kind}">${escapeHtml(opts.notice.text)}</div>` : ""}
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
    : `<p class="muted">Changes apply to Claude right away (allow up to a minute).</p>`
}
</div>`;
  return layout("Gmail accounts", body);
}
