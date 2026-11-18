# Transport System

Browser-based transport management: routes, vehicles, trip scheduling, seat booking and cancellation.
No dependencies, no build step. Data is stored in the browser (localStorage).

## Run locally
- Open `index.html` directly, or serve the folder: `npx serve .` (or `python3 -m http.server 8000`).
- Click **Load sample data** to try it.

## Test
Node.js 20+ required: `npm test` (15 tests, built-in `node:test`).

## Deploy to Vercel
Push these files to the root of a GitHub repo, import it in Vercel, keep Framework Preset = Other,
no build command, output directory = root. Deploys as a static site.

## Files
- `index.html` - page markup
- `styles.css` - styling
- `transport.js` - domain logic and validation (pure functions, unit-tested)
- `app.js` - UI wiring and storage
- `transport.test.js` - unit tests
- `vercel.json` - security headers
