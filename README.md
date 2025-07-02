# Forkable Lunch API

Convex HTTP action to fetch Forkable lunch orders.

## Setup

1. `npm install`
2. `npx convex dev` (configure new deployment)
3. Set environment variables:
   ```bash
   npx convex env set FORKABLE_EMAIL "your-email@example.com"
   npx convex env set FORKABLE_PASSWORD "your-password"
   npx convex env set FORKABLE_AUTH_TOKEN "your-secret-token"
   ```

## Usage

```bash
curl -H "Authorization: Bearer your-secret-token" \
  "https://your-deployment.convex.site/forkable"
```

Auto-selects tomorrow after 1pm PT, otherwise today. Override timezone with `TIMEZONE` env var.