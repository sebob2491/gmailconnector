/** The hosted connector's activity log: one KV key (see KvHistoryStore in src/history.ts). */
import { KvHistoryStore } from "../src/history.js";
import type { Env } from "./owner.js";

/** Entries the accounts page shows. */
export const RECENT_ON_PAGE = 20;

export function historyStore(env: Env): KvHistoryStore {
  return new KvHistoryStore(env.OAUTH_KV);
}
