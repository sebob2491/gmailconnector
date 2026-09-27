import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function configDir(): string {
  if (process.env.GMAIL_MCP_CONFIG_DIR) return process.env.GMAIL_MCP_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gmail-multi-mcp");
}

export class AccountError extends Error {}

/**
 * Persists linked accounts (refresh tokens) to accounts.json in the config dir.
 * The file is re-read on every access so accounts linked with the CLI while the
 * server is running show up without a restart.
 */
export class AccountStore {
  constructor(readonly dir: string = configDir()) {}

  get file(): string {
    return path.join(this.dir, "accounts.json");
  }

  async load(): Promise<AccountsFile> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8")) as AccountsFile;
      return { version: 1, defaultAccount: data.defaultAccount, accounts: data.accounts ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, accounts: [] };
      throw err;
    }
  }

  async save(data: AccountsFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async list(): Promise<LinkedAccount[]> {
    return (await this.load()).accounts;
  }

  async upsert(account: LinkedAccount): Promise<void> {
    const data = await this.load();
    const existing = data.accounts.findIndex((a) => sameEmail(a.email, account.email));
    if (account.alias) assertAliasFree(data, account.alias, account.email);
    if (existing >= 0) {
      data.accounts[existing] = { ...account, alias: account.alias ?? data.accounts[existing].alias };
    } else {
      data.accounts.push(account);
    }
    await this.save(data);
  }

  async remove(ref: string): Promise<LinkedAccount> {
    const data = await this.load();
    const account = findAccount(data, ref);
    data.accounts = data.accounts.filter((a) => a !== account);
    if (data.defaultAccount && sameEmail(data.defaultAccount, account.email)) delete data.defaultAccount;
    await this.save(data);
    return account;
  }

  async setDefault(ref: string): Promise<LinkedAccount> {
    const data = await this.load();
    const account = findAccount(data, ref);
    data.defaultAccount = account.email;
    await this.save(data);
    return account;
  }

  async setAlias(ref: string, alias: string): Promise<LinkedAccount> {
    const data = await this.load();
    const account = findAccount(data, ref);
    assertAliasFree(data, alias, account.email);
    account.alias = alias;
    await this.save(data);
    return account;
  }
}

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

function assertAliasFree(data: AccountsFile, alias: string, ownerEmail: string): void {
  if (alias.toLowerCase() === "all") throw new AccountError(`"all" is reserved and cannot be used as an alias.`);
  if (alias.includes("@")) throw new AccountError(`Aliases cannot contain "@".`);
  const clash = data.accounts.find(
    (a) => !sameEmail(a.email, ownerEmail) && a.alias?.toLowerCase() === alias.toLowerCase(),
  );
  if (clash) throw new AccountError(`Alias "${alias}" is already used by ${clash.email}.`);
}
