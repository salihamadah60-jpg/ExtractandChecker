# Link Checker Pro — WhatsApp & Telegram Link Checker

## Project Overview
A full-stack web app that extracts WhatsApp and Telegram links from a DOCX file, deduplicates them, allows downloading them as separate DOCX files, and checks WhatsApp link validity using an authenticated Baileys (WhatsApp Web) session.

## Tech Stack
- **Frontend**: React 18, Vite, TanStack Query, shadcn/ui, Tailwind CSS, Wouter
- **Backend**: Express 5, TypeScript, tsx (dev), Node.js
- **WhatsApp**: @whiskeysockets/baileys (WhatsApp Web API, no Puppeteer)
- **DOCX parsing**: mammoth
- **DOCX generation**: docx
- **File upload**: multer

## App Flow (5 Steps)
1. **رفع الملف** — Upload a DOCX file with WhatsApp/Telegram links
2. **الروابط** — View extracted link counts, download WhatsApp/Telegram files separately, or start checking
3. **ربط واتساب** — Connect via QR code scan or pairing code (in-app)
4. **الفحص** — Live progress as each WhatsApp link is checked (2–5s anti-ban delays)
5. **النتائج** — Summary + download valid links as DOCX

## Key Files
- `server/baileys-manager.ts` — Baileys WhatsApp connection singleton (QR, pairing, link checking)
- `server/link-store.ts` — In-memory store for extracted links and check session
- `server/routes.ts` — All API routes (upload, download, WhatsApp connect/check/results)
- `client/src/pages/home.tsx` — Full 5-step UI
- `client/src/index.css` — WhatsApp green theme

## API Routes
- `POST /api/upload` — Accept DOCX, extract links, deduplicate
- `GET /api/download/whatsapp` — Download WhatsApp links as DOCX
- `GET /api/download/telegram` — Download Telegram links as DOCX
- `POST /api/whatsapp/connect` — Start QR-based WhatsApp connection
- `POST /api/whatsapp/pair` — Start pairing-code-based connection
- `POST /api/whatsapp/disconnect` — Disconnect
- `GET /api/whatsapp/status` — Status + QR code + pairing code
- `POST /api/whatsapp/check` — Start checking WhatsApp links
- `GET /api/whatsapp/progress` — Live check progress
- `GET /api/whatsapp/download-valid` — Download valid links as DOCX

## Running
The "Start application" workflow runs `npm run dev` which starts the Express+Vite server on port 5000.

## Theme
WhatsApp green: primary `142 70% 38%` (light) / `142 60% 45%` (dark)

## Notes
- Baileys auth state is persisted in `.baileys-auth/` folder
- Anti-ban: random 2–5 second delays between link checks
- Max links supported per session: unlimited (but practical limit ~100 to avoid bans)
- Link extraction uses regex on mammoth's HTML + raw text output
