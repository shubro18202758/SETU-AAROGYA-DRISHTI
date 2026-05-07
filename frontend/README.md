# Frontend

Next.js App Router console for the local OSINT operator experience. The app uses Tailwind CSS v4 and code-owned registry UI primitives under `src/components/ui` rather than black-box dashboard component packages.

The console is now routed rather than a single anchor-based page. The persistent shell links to dedicated OSINT workspaces for Overview, GraphRAG, Streams, Alerts, Entities, Database, Reports, and Settings.

## Routes

- `/` - operational overview with WebGL globe, runtime fabric, and live signals.
- `/graphrag` - local graph retrieval workbench.
- `/streams` - Redpanda topic flow and EVENT stream monitor.
- `/alerts` - analyst triage rule tuning.
- `/entities` - entity resolution search surface.
- `/database` - ArcadeDB schema and service health view.
- `/reports` - intelligence brief builder.
- `/settings` - 8 GB VRAM startup sequence and runtime constraints.

## Local Development

```powershell
npm install
npm run dev
```

The dev server listens on `http://localhost:3000`. The frontend proxies intelligence API calls to `http://localhost:8000` by default.
