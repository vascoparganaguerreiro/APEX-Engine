# APEX Engine (web)

Next.js + TypeScript on Vercel, with Supabase for login and data (same database as the Streamlit app).

## Deploy (no local install needed)
1. Create a GitHub repository (e.g. `apex-web`) and upload everything in this folder.
2. In Vercel: **Add New > Project**, import the repository. Framework: Next.js (detected automatically).
3. Before deploying, add two **Environment Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key)
4. (For the AI summaries) also add this **server-only** variable, with no `NEXT_PUBLIC_` prefix:
   - `GEMINI_API_KEY` = your Google AI Studio key
   Optional: `GEMINI_MODEL` (force a model) and `SUMMARY_DAILY_LIMIT` (summaries per user per day, default 30).
5. Deploy. Open the address Vercel gives you and sign in with your existing APEX account.

## Run locally (optional, needs Node.js 20.9+)
```
npm install
cp .env.example .env.local   # then fill in the two values
npm run dev
npm test                     # engine tests (Node 22+)
```

## Database
Run `04_activity_notes.sql` once in the Supabase SQL Editor (adds activity notes, AI summaries and weekly summaries).
