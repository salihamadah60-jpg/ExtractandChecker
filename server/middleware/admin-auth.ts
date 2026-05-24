import { Request, Response, NextFunction } from "express";
import { adminStore } from "../modules/admin.js";
import type { AdminDoc } from "../modules/admin.js";

declare global {
  namespace Express {
    interface Request {
      admin?: AdminDoc;
    }
  }
}

export async function adminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const key = (req.headers["x-admin-key"] as string) ?? "";
  if (!key) {
    res.status(401).json({ error: "مطلوب مفتاح المشرف (X-Admin-Key)" });
    return;
  }
  try {
    const admin = await adminStore.findByKey(key);
    if (!admin) {
      res.status(401).json({ error: "مفتاح المشرف غير صالح" });
      return;
    }
    req.admin = admin;
    next();
  } catch {
    res.status(500).json({ error: "خطأ في التحقق من صلاحيات المشرف" });
  }
}
