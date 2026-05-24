/**
 * admin.ts — Admin user management
 *
 * Admins are stored in the "Admins" MongoDB collection.
 * Authentication is done via a UUID adminKey (similar to workspace accessKey).
 * A default admin is pre-seeded on first startup.
 */

import { getDb } from "../mongo-auth-state.js";
import { randomUUID } from "crypto";

export interface AdminDoc {
  _id: string;
  phoneNumber: string;
  name?: string;
  adminKey: string;
  createdAt: Date;
  createdBy?: string;
}

const COL = "Admins";
const SEED_PHONE = "772951869";

async function col() {
  const db = await getDb();
  return db.collection<AdminDoc>(COL);
}

export const adminStore = {
  async init(): Promise<void> {
    const c = await col();
    await (c.createIndex as any)({ phoneNumber: 1 }, { unique: true, background: true });
    await (c.createIndex as any)({ adminKey: 1 }, { unique: true, background: true });

    const exists = await c.findOne({ phoneNumber: SEED_PHONE });
    if (!exists) {
      const doc: AdminDoc = {
        _id: randomUUID(),
        phoneNumber: SEED_PHONE,
        name: "المشرف الرئيسي",
        adminKey: randomUUID(),
        createdAt: new Date(),
      };
      await (c.insertOne as any)(doc);
      console.log(`[AdminStore] ✅ Seeded default admin | phone: ${SEED_PHONE} | adminKey: ${doc.adminKey}`);
    } else {
      console.log(`[AdminStore] Default admin already exists | key: ${exists.adminKey}`);
    }
    console.log("[AdminStore] Ready");
  },

  async findByKey(adminKey: string): Promise<AdminDoc | null> {
    const c = await col();
    return c.findOne({ adminKey }) as Promise<AdminDoc | null>;
  },

  async findByPhone(phoneNumber: string): Promise<AdminDoc | null> {
    const c = await col();
    const norm = phoneNumber.replace(/\D/g, "");
    return c.findOne({ $or: [{ phoneNumber: norm }, { phoneNumber: phoneNumber }] }) as Promise<AdminDoc | null>;
  },

  async list(): Promise<AdminDoc[]> {
    const c = await col();
    return c.find({}).sort({ createdAt: 1 }).toArray() as Promise<AdminDoc[]>;
  },

  async create(phoneNumber: string, name?: string, createdBy?: string): Promise<AdminDoc> {
    const c = await col();
    const norm = phoneNumber.replace(/\D/g, "");
    const doc: AdminDoc = {
      _id: randomUUID(),
      phoneNumber: norm,
      name: name?.trim() || undefined,
      adminKey: randomUUID(),
      createdAt: new Date(),
      createdBy,
    };
    await (c.insertOne as any)(doc);
    return doc;
  },

  async delete(id: string): Promise<void> {
    const c = await col();
    await (c.deleteOne as any)({ _id: id });
  },

  async updateName(id: string, name: string): Promise<void> {
    const c = await col();
    await (c.updateOne as any)({ _id: id }, { $set: { name } });
  },
};
