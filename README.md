# Crescent Pharma Compliance Platform

A single compliance platform for laboratory instruments (TLC, pH, spectrophotometer, vision, environmental and stability monitoring). It is designed to meet FDA 21 CFR Part 11, EU Annex 11, GAMP 5, GMP, ALCOA+ and CSV.

The full specification is in `docs/master-specification-v1.0.docx`.

## Structure

| Path | Stack | Purpose |
|---|---|---|
| `apps/web` | Next.js + React + TS | UI |
| `apps/server` | NestJS | API and Compliance Core (audit, e-signatures, licensing, etc.) |
| `apps/desktop` | Electron | Desktop shell for standalone mode |
| `packages/shared` | TypeScript | Types shared by all apps |

## Getting started

```bash
npm install
cp .env.example .env
npm run db:up          # Postgres via Docker (or point DATABASE_URL at a local install)
npm run build -w @crescent/shared
npm run dev:server     # http://localhost:4000
npm run dev:web        # http://localhost:3000
npm run dev:desktop    # Electron window loading the web app
```
