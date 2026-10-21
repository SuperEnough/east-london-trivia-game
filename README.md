# East London Trivia

East London trivia game hosted on Vercel. The shared leaderboard and one-attempt-per-browser rule are handled by the `/api/leaderboard` serverless function.

## Vercel setup

1. Import this repository as a Vercel project.
2. Connect a Vercel KV-compatible Redis store to the project and configure `KV_REST_API_URL` and `KV_REST_API_TOKEN` in the project's environment variables.
3. Redeploy after adding the variables.

The app starts with an empty leaderboard; no sample scores are seeded or loaded from browser storage. Scores are stored centrally and sorted by score, then completion time. The first play reserves the browser's attempt in storage; refreshing or entering a different name does not create another attempt.

The attempt identifier is held in a persistent, HttpOnly browser cookie. Clearing browser cookies/site data or playing in another browser/device can create a new identifier; preventing that requires account-based identity or another verified identity system.
