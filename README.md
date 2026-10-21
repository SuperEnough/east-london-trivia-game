# East London Trivia

East London trivia game hosted on Vercel. The shared leaderboard and one-attempt-per-browser rule are handled by the `/api/leaderboard` serverless function.

## Supabase and Vercel setup

1. In Supabase, open **SQL Editor** and run [`supabase/schema.sql`](./supabase/schema.sql).
2. In Vercel, set `SUPABASE_URL` to your Supabase project URL and `SUPABASE_SERVICE_ROLE_KEY` to the project's service-role key.
3. Keep the service-role key server-side only; never add it to the page or commit it.
4. Redeploy after adding the environment variables.

The app starts with an empty leaderboard; no sample scores are seeded or loaded from browser storage. Scores are stored centrally and sorted by score, then completion time. The first play reserves the browser's attempt in storage; refreshing or entering a different name does not create another attempt.

The attempt identifier is held in a persistent, HttpOnly browser cookie. Clearing browser cookies/site data or playing in another browser/device can create a new identifier; preventing that requires account-based identity or another verified identity system.
