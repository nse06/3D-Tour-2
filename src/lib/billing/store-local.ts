import "server-only";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { localDataDir } from "@/lib/data/config";
import type { BillingStore, Grant, NewGrant, SubscriptionRecord } from "./store";

// Local mode: billing records in a JSON file next to the listings (db.json).

interface BillingDb {
  customers: Record<string, string>;
  subscriptions: SubscriptionRecord[];
  grants: Grant[];
}

const empty = (): BillingDb => ({ customers: {}, subscriptions: [], grants: [] });

let queue: Promise<unknown> = Promise.resolve();

function file() {
  return path.join(localDataDir(), "billing.json");
}

async function read(): Promise<BillingDb> {
  try {
    return { ...empty(), ...JSON.parse(await fs.readFile(file(), "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

/** Serialize read-modify-write cycles within this process; writes are atomic renames. */
function mutate<T>(fn: (db: BillingDb) => T): Promise<T> {
  const run = queue.then(async () => {
    const db = await read();
    const result = fn(db);
    await fs.mkdir(localDataDir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, file());
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

export class LocalBillingStore implements BillingStore {
  async customerId(userId: string) {
    return (await read()).customers[userId] ?? null;
  }

  async saveCustomer(userId: string, customerId: string) {
    await mutate((db) => {
      db.customers[userId] ??= customerId;
    });
  }

  async userForCustomer(customerId: string) {
    return Object.entries((await read()).customers).find(([, id]) => id === customerId)?.[0] ?? null;
  }

  async subscriptions(userId: string) {
    return (await read()).subscriptions.filter((s) => s.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveSubscription(sub: SubscriptionRecord) {
    await mutate((db) => {
      db.subscriptions = [...db.subscriptions.filter((s) => s.id !== sub.id), sub];
    });
  }

  async grants(userId: string, filter: { propertyId?: string; kind?: Grant["kind"] } = {}) {
    return (await read()).grants
      .filter((g) => g.userId === userId && (!filter.propertyId || g.propertyId === filter.propertyId) && (!filter.kind || g.kind === filter.kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addGrant(grant: NewGrant) {
    return mutate((db) => {
      if (db.grants.some((g) => g.reference === grant.reference)) return false;
      db.grants.push({ ...grant, id: randomUUID(), createdAt: new Date().toISOString() });
      return true;
    });
  }

  async start() {
    // Local mode has one realtor and no database roles: nothing to guard or carry over.
  }
}
