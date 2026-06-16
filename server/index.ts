// ── Suppress known-harmless libsignal Signal Protocol noise ───────────────────
// libsignal (used by Baileys internally) calls console.error() directly,
// bypassing Baileys' pino logger. These messages are NOT actionable:
//   - MessageCounterError  → stale message key after reconnection (auto-skipped)
//   - Bad MAC              → mismatched encryption state after reconnection
//   - Failed to decrypt    → libsignal outer catch when all sessions fail
// Baileys already handles these gracefully (skips the message and continues).
const _origConsoleError = console.error.bind(console);
console.error = (...args: any[]) => {
  const s = args.map(a => (typeof a === "string" ? a : String(a ?? ""))).join(" ");
  if (
    s.includes("Failed to decrypt message") ||
    s.includes("Session error:")             ||
    s.includes("MessageCounterError")        ||
    s.includes("Bad MAC")                    ||
    s.includes("Key used already or never")
  ) return;
  _origConsoleError(...args);
};

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { linkStore } from "./link-store";
import { baileysManager } from "./baileys-manager";
import { linksRepository } from "./modules/links-repository";
import { systemState } from "./modules/system-state";
import { getLeaveManagerFor } from "./modules/leave-manager";
import { workspaceStore } from "./modules/workspace";
import { workspaceAuth } from "./middleware/workspace-auth";
import { adminStore } from "./modules/admin";
import { centralLinksStore } from "./modules/central-links";
import { excludedGroups } from "./modules/excluded-groups";
import { getSleepConfig, updateSleepConfigSync } from "./modules/sleep-config";
import { getJoinConfig, updateJoinConfigSync } from "./modules/join-config";
import { publishScheduler } from "./modules/publish-scheduler";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ── Keep-alive ping (for external uptime monitors on free tier) ──────────────
app.get("/ping", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  const SILENT_POLL_PATHS = new Set([
    "/api/whatsapp/status",
    "/api/whatsapp/progress",
    "/api/whatsapp/join-progress",
    "/api/previous-results",
    "/api/whatsapp/filtered-summary",
    "/api/coordinator/status",
    "/api/join/progress",
    "/api/leave/progress",
    "/api/publisher/progress",
    "/api/reader/stats",
    "/api/links-repository/counts",
  ]);

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (!path.startsWith("/api")) return;

    const isError = res.statusCode >= 400;
    const isSuccessfulPoll =
      req.method === "GET" &&
      SILENT_POLL_PATHS.has(path) &&
      !isError;
    const isNotModified = res.statusCode === 304;

    if (isSuccessfulPoll || isNotModified) return;

    let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
    if (capturedJsonResponse && isError) {
      logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
    }

    log(logLine);
  });

  next();
});

const initServer = async () => {
  // Restore saved check session and extracted links from previous run
  await linkStore.loadFromDisk();

  // Initialize MongoDB modules (skip if MONGODB_URI not set)
  if (process.env.MONGODB_URI) {
    try {
      await workspaceStore.init();
      await linksRepository.init();
      await adminStore.init();
      await centralLinksStore.init();
      await excludedGroups.init();
      await systemState.init("main");
      await getLeaveManagerFor("main").init();
      // Load sleep config from DB and update in-memory sync cache
      const sleepCfg = await getSleepConfig();
      updateSleepConfigSync(sleepCfg);
      // Load join config from DB and update in-memory sync cache
      const joinCfg = await getJoinConfig();
      updateJoinConfigSync(joinCfg);
      // Check if a function was interrupted on last restart — reset the lock
      await systemState.checkRecovery("main");
      await publishScheduler.init();
    } catch (err) {
      console.warn("[Startup] MongoDB modules init failed (continuing without):", (err as Error).message);
    }
  }

  // Workspace auth middleware — all /api/* routes (except public ones) require X-Workspace-Key
  app.use(workspaceAuth as any);

  // Auto-reconnect WhatsApp if credentials from a previous session exist
  baileysManager.autoConnect().catch(console.error);

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }
};

const initPromise = initServer();

// Start a real HTTP server when running locally (Replit, local dev, etc.)
// On Vercel, the app is served as a serverless function via the exported handler below.
if (!process.env.VERCEL) {
  initPromise.then(() => {
    const port = parseInt(process.env.PORT || "5000", 10);
    httpServer.listen(
      {
        port,
        host: "0.0.0.0",
        reusePort: true,
      },
      () => {
        log(`serving on port ${port}`);
      },
    );
  });
}

// Vercel serverless handler — each incoming request is passed directly to Express
const handler = async (req: any, res: any) => {
  await initPromise;
  return app(req, res);
};

export default handler;

// Support CommonJS environments (Vercel @vercel/node in cjs mode)
if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}


