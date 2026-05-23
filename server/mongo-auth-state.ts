import { MongoClient, type Db } from "mongodb";

const MONGO_URI = process.env.MONGODB_URI || "";
let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  if (!MONGO_URI) throw new Error("MONGODB_URI environment variable not set");
  _client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 30_000,   // 30s to find/select a server
    connectTimeoutMS:         30_000,   // 30s initial TCP connect
    socketTimeoutMS:          60_000,   // 60s per operation socket idle
    retryWrites:              true,     // auto-retry failed writes once
    retryReads:               true,     // auto-retry failed reads once
    maxPoolSize:              10,
    minPoolSize:              1,
    waitQueueTimeoutMS:       10_000,
    heartbeatFrequencyMS:     10_000,   // check server health every 10s
  });
  await _client.connect();
  // Reset cached references if the topology closes unexpectedly
  _client.on("topologyClosed", () => {
    _db     = null;
    _client = null;
  });
  _db = _client.db();
  return _db;
}

export async function initMongo(): Promise<void> {
  const db = await getDb();
  await db
    .collection("wa_auth_state")
    .createIndex({ sessionId: 1, keyType: 1, keyId: 1 }, { unique: true, background: true } as any);
  console.log("[MongoDB] Connected and ready");
}

export async function useMongoAuthState(sessionId: string) {
  const baileys = await import("@whiskeysockets/baileys");
  const { initAuthCreds, BufferJSON } = baileys as any;
  const db = await getDb();
  const col = db.collection("wa_auth_state");

  const credsDoc = await col.findOne({ sessionId, keyType: "creds", keyId: "creds" });
  const creds = credsDoc?.data
    ? JSON.parse(credsDoc.data, BufferJSON.reviver)
    : initAuthCreds();

  const saveCreds = async () => {
    await col.updateOne(
      { sessionId, keyType: "creds", keyId: "creds" },
      { $set: { data: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date() } },
      { upsert: true }
    );
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const docs = await col.find({ sessionId, keyType: type, keyId: { $in: ids } }).toArray();
          const result: Record<string, any> = {};
          for (const doc of docs) {
            result[doc.keyId] = JSON.parse(doc.data, BufferJSON.reviver);
          }
          return result;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const ops: any[] = [];
          for (const [type, items] of Object.entries(data)) {
            for (const [id, value] of Object.entries(items)) {
              if (value != null) {
                ops.push({
                  updateOne: {
                    filter: { sessionId, keyType: type, keyId: id },
                    update: {
                      $set: {
                        data: JSON.stringify(value, BufferJSON.replacer),
                        updatedAt: new Date(),
                      },
                    },
                    upsert: true,
                  },
                });
              } else {
                ops.push({ deleteOne: { filter: { sessionId, keyType: type, keyId: id } } });
              }
            }
          }
          if (ops.length) await col.bulkWrite(ops);
        },
      },
    },
    saveCreds,
  };
}

export async function deleteMongoSession(sessionId: string): Promise<void> {
  const db = await getDb();
  await db.collection("wa_auth_state").deleteMany({ sessionId });
  console.log(`[MongoDB] Deleted auth for session: ${sessionId}`);
}

export async function mongoSessionHasCreds(sessionId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const doc = await db
      .collection("wa_auth_state")
      .findOne({ sessionId, keyType: "creds", keyId: "creds" });
    return !!doc;
  } catch {
    return false;
  }
}

export async function extractPhoneFromCreds(sessionId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const doc = await db
      .collection("wa_auth_state")
      .findOne({ sessionId, keyType: "creds", keyId: "creds" });
    if (!doc?.data) return null;
    const baileys = await import("@whiskeysockets/baileys");
    const { BufferJSON } = baileys as any;
    const creds = JSON.parse(doc.data, BufferJSON.reviver);
    const jid: string = creds.me?.id ?? "";
    const phone = jid.split(":")[0].split("@")[0];
    return phone || null;
  } catch {
    return null;
  }
}

// ── Sessions metadata ────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  displayName: string;
  createdAt: string;
  phoneNumber?: string;
  workspaceId?: string;
}

export interface AppMeta {
  activeSessionId: string | null;
  sessions: SessionMeta[];
}

const APP_META_ID = "app_meta";

export async function loadAppMeta(): Promise<AppMeta> {
  try {
    const db = await getDb();
    const doc = await db.collection("wa_app_meta").findOne({ _id: APP_META_ID as any });
    if (!doc) return { activeSessionId: null, sessions: [] };
    return {
      activeSessionId: doc.activeSessionId ?? null,
      sessions: (doc.sessions ?? []) as SessionMeta[],
    };
  } catch {
    return { activeSessionId: null, sessions: [] };
  }
}

export async function saveAppMeta(meta: AppMeta): Promise<void> {
  const db = await getDb();
  await db.collection("wa_app_meta").updateOne(
    { _id: APP_META_ID as any },
    { $set: { activeSessionId: meta.activeSessionId, sessions: meta.sessions, updatedAt: new Date() } },
    { upsert: true }
  );
}
