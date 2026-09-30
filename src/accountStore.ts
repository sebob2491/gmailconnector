import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertAliasFree,
  findAccount,
  normalizeAlias,
  sameEmail,
  upsertAccount,
  type AccountSource,
  type AccountsFile,
  type LinkedAccount,
} from "./accounts.js";

export * from "./accounts.js";

export function configDir(): string {
  if (process.env.GMAIL_MCP_CONFIG_DIR) return process.env.GMAIL_MCP_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gmail-multi-mcp");
}

/**
 * Persists linked accounts (refresh tokens) to accounts.json in the config dir.
 * The file is re-read on every access so accounts linked with the CLI while the
 * server is running show up without a restart.
 */
export class AccountStore implements AccountSource {
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
    upsertAccount(data, account);
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
    account.alias = normalizeAlias(alias);
    await this.save(data);
    return account;
  }
}
