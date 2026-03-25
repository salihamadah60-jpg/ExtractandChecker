# Link Checker Pro — WhatsApp & Telegram Link Checker

## Project Overview
A full-stack web app that extracts WhatsApp and Telegram links from a DOCX file, deduplicates them, checks their validity via WhatsApp (Baileys), then filters results into two output files: a **groups file** (>50 members, sorted) and an **ads file** (10–50 members with description). Supports multi-round checking with session persistence.

## Tech Stack
- **Frontend**: React 18, Vite, TanStack Query, shadcn/ui, Tailwind CSS, Wouter
- **Backend**: Express 5, TypeScript, tsx (dev), Node.js
- **WhatsApp**: @whiskeysockets/baileys (WhatsApp Web API, no Puppeteer)
- **DOCX parsing**: mammoth
- **DOCX generation**: docx
- **File upload**: multer

## App Flow (5 Steps)
1. **رفع الملف** — Upload a DOCX file with WhatsApp/Telegram links
2. **الروابط** — View extracted link counts, download WhatsApp/Telegram files, or start checking
3. **ربط واتساب** — Connect via QR code scan or pairing code (in-app)
4. **الفحص** — Live progress as each WhatsApp link is checked (1–1.5s anti-ban delays)
5. **النتائج** — Two filtered output files + new round upload (deduped, uses saved session)

## Filtering Logic (after checking)
- **Groups file** (`>50 members`): Valid groups sorted by name (directory grouping) then member count ascending
- **Ads file** (`10–50 members with description`): Valid groups that have non-empty description
- **Excluded** (`≤10 members` OR no description for 10–50): dropped from both files
- **Description links**: Links found in group descriptions (>50 members) are extracted and saved to `description-links.json`

## New Round Feature
- After results, user can upload a new DOCX
- Server deduplicates against ALL previously checked links
- Saves unique links to a numbered JSON file (e.g., `filename-round2.json`)
- Starts checking by EXTENDING the existing session (no WhatsApp reconnect needed)
- Session accumulates all results across rounds for unified filtering

## Key Files
- `server/baileys-manager.ts` — Baileys WhatsApp connection singleton; extracts group name, members, description
- `server/link-store.ts` — State store with filtering, dedup, new-round session management
- `server/routes.ts` — All API routes
- `client/src/pages/home.tsx` — Full 5-step UI with filtered results + new round section
- `client/src/index.css` — WhatsApp green theme

## API Routes
- `POST /api/upload` — Accept DOCX, extract links, save JSON, deduplicate
- `POST /api/upload-new-round` — Accept new DOCX, dedup against all checked links, save JSON
- `GET /api/download/whatsapp` — Download extracted WhatsApp links as DOCX
- `GET /api/download/telegram` — Download extracted Telegram links as DOCX
- `POST /api/whatsapp/connect` — Start QR-based WhatsApp connection
- `POST /api/whatsapp/pair` — Start pairing-code-based connection
- `POST /api/whatsapp/disconnect` — Disconnect
- `GET /api/whatsapp/status` — Status + QR code + pairing code
- `POST /api/whatsapp/check` — Start checking WhatsApp links
- `POST /api/whatsapp/check-new-round` — Extend existing session with new round links
- `GET /api/whatsapp/progress` — Live check progress
- `GET /api/whatsapp/filtered-summary` — Grouped results counts + description links
- `GET /api/whatsapp/download-groups` — Download groups file (>50 members, sorted)
- `GET /api/whatsapp/download-ads` — Download ads file (10–50 members + description)
- `GET /api/whatsapp/download-valid` — Download all valid links as DOCX (legacy)

## Running
The "Start application" workflow runs `npm run dev` which starts the Express+Vite server on port 5000.

## Theme
WhatsApp green: primary `142 70% 38%` (light) / `142 60% 45%` (dark)

## Notes
- Baileys auth state is persisted in `.baileys-auth/` folder
- Anti-ban: random 2–5 second delays between link checks
- Max links supported per session: unlimited (but practical limit ~100 to avoid bans)
- Link extraction uses regex on mammoth's HTML + raw text output
