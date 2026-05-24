import { Request, Response, NextFunction } from "express";
import { workspaceStore } from "../modules/workspace.js";
import type { WorkspaceDoc } from "../modules/workspace.js";

declare global {
  namespace Express {
    interface Request {
      workspaceId: string;
      workspace: WorkspaceDoc;
    }
  }
}

const PUBLIC_PATHS = new Set([
  "/api/workspaces/create",
  "/api/workspaces/login",
  "/api/workspaces/list",
  "/api/health",
  "/ping",
]);

export async function workspaceAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Admin routes have their own auth (X-Admin-Key) — bypass workspace auth
  if (!req.path.startsWith("/api") || PUBLIC_PATHS.has(req.path) || req.path.startsWith("/api/admin")) {
    return next();
  }

  const key = (req.headers["x-workspace-key"] as string) ?? "";
  if (!key) {
    res.status(401).json({ error: "مطلوب مفتاح الوصول (X-Workspace-Key)" });
    return;
  }

  try {
    const workspace = await workspaceStore.findByKey(key);
    if (!workspace) {
      res.status(401).json({ error: "مفتاح الوصول غير صالح" });
      return;
    }
    req.workspaceId = workspace._id;
    req.workspace = workspace;
    next();
  } catch {
    res.status(500).json({ error: "خطأ في التحقق من مساحة العمل" });
  }
}
