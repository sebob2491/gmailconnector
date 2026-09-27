/** Runtime-neutral account types and lookup (shared by the Node CLI and the Cloudflare Worker). */

export interface LinkedAccount {
  /** Gmail address, as reported by the Gmail profile endpoint. */
  email: string;
  /** Optional short name such as "work" or "personal". */
  alias?: string;
  refreshToken: string;
  scopes: string[];
  addedAt: string;
}

export interface AccountsFile {
  version: 1;
  defaultAccount?: string;
  accounts: LinkedAccount[];
}

/** Where the MCP server reads linked accounts from (a local file, or KV when hosted). */
export interface AccountSource {
  load(): Promise<AccountsFile>;
}

export class AccountError extends Error {}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Finds an account by email address or alias (case-insensitive). */
export function findAccount(data: AccountsFile, ref: string): LinkedAccount {
  const needle = ref.trim().toLowerCase();
  const match = data.accounts.find(
    (a) => a.email.toLowerCase() === needle || (a.alias && a.alias.toLowerCase() === needle),
  );
  if (!match) {
    const known = data.accounts.map(describeAccount).join(", ") || "none";
    throw new AccountError(`No linked Gmail account matches "${ref}". Linked accounts: ${known}.`);
  }
  return match;
}

export function describeAccount(a: LinkedAccount): string {
  return a.alias ? `${a.email} (${a.alias})` : a.email;
}

/** Inserts or replaces an account (matched by email), keeping an existing alias unless a new one is given. */
export function upsertAccount(data: AccountsFile, account: LinkedAccount): void {
  if (account.alias) assertAliasFree(data, account.alias, account.email);
  const existing = data.accounts.findIndex((a) => sameEmail(a.email, account.email));
  if (existing >= 0) {
    data.accounts[existing] = { ...account, alias: account.alias ?? data.accounts[existing].alias };
  } else {
    data.accounts.push(account);
  }
}

export function assertAliasFree(data: AccountsFile, alias: string, ownerEmail: string): void {
  if (alias.toLowerCase() === "all") throw new AccountError(`"all" is reserved and cannot be used as an alias.`);
  if (alias.includes("@")) throw new AccountError(`Aliases cannot contain "@".`);
  const clash = data.accounts.find(
    (a) => !sameEmail(a.email, ownerEmail) && a.alias?.toLowerCase() === alias.toLowerCase(),
  );
  if (clash) throw new AccountError(`Alias "${alias}" is already used by ${clash.email}.`);
}
