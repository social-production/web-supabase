# Production performance capture

Use this checklist after deploying the gateway instrumentation. Never paste an
access token, refresh token, cookie, service-role key, or raw user data into an
issue or chat.

## 1. Identify the regions

1. Open Supabase Dashboard → Project Settings → Infrastructure.
2. Record the project region.
3. Record the tester's country/region and connection type.
4. Vercel's function region is not on the API data path for this client-rendered
   app, but record it if server-side rendering is enabled later.

## 2. Capture a browser trace

Use a logged-in test account with representative memberships and conversations.

1. Open production in a private browser window with extensions disabled.
2. Open DevTools → Network, enable **Preserve log**, and clear the list.
3. Record each scenario separately:
   - hard refresh the home feed;
   - switch a feed tab;
   - cast a vote and wait until the UI settles;
   - open a project or event;
   - open Messages, then open Linked chats.
4. Export a HAR. Redact `Authorization`, `apikey`, cookies, and token response
   bodies before sharing it.
5. Record a browser Performance profile for the same scenarios. Include at least
   five seconds before and after the slow interaction.

For opt-in console timings, run:

```js
localStorage.setItem('sp_perf_debug', '1');
location.reload();
```

The console then reports gateway duration, `Server-Timing`, request IDs, layout
phases, vote mutations, and browser long tasks. Disable it with:

```js
localStorage.removeItem('sp_perf_debug');
```

## 3. Correlate Supabase logs

1. Open Supabase Dashboard → Edge Functions → `gateway` → Logs.
2. Filter to the UTC window of the browser capture.
3. Match `gateway_request.requestId` to the browser `x-request-id` response
   header.
4. Export `gateway_request` and `gateway_span` JSON log lines. They contain no
   user ID or request body.

## 4. Capture database evidence

1. Open Supabase Dashboard → Reports → Query Performance.
2. Use the same UTC window.
3. Export the top queries by total time and mean time.
4. Include query templates for `messages`, `comments`, `conversation_members`,
   `content_votes`, feeds, reports, and tag tables; exclude row data.
5. Verify the production migration list includes the inbox/feed performance
   migrations in this repository.

## 5. Record the baseline

For each scenario record:

- browser total time and long tasks over 50 ms;
- gateway total duration from `Server-Timing`;
- slowest named gateway span;
- response payload size;
- cold request and immediate warm repeat.

Initial targets:

- bootstrap p95 below 500 ms;
- first feed page p95 below 800 ms;
- vote mutation-to-settled p95 below 500 ms;
- Messages conversations p95 below 500 ms;
- linked-chat hydration p95 below 800 ms;
- no browser task over 200 ms during ordinary navigation.
