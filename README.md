# Forage

Forage is a fictional shopping playground: hunt, inspect, wishlist, add to basket, purchase with imaginary currency, and anticipate fictional deliveries.

## Easiest deployment: Netlify Drop
1. Unzip `forage_webapp.zip`.
2. On a computer, open Netlify Drop in a browser.
3. Drag the entire `forage_webapp` folder onto the page.
4. Netlify gives you an HTTPS address.
5. Open that address in Safari on iPad.
6. Safari Share → Add to Home Screen.

## GitHub Pages
Upload these files to the root of a repository, then enable Pages for the repository's main branch/root.

## Cloudflare Pages
Create a Pages project and upload this folder as a static site. No build command is needed.

## Notes
- No real payment system exists.
- Purchases use fictional Ƶ currency.
- Cart, wishlist, orders, and balance are stored locally in the browser.
- Once hosted over HTTPS, Forage registers a service worker so previously visited content can work offline.
- Product photography is AI-generated/illustrative; see `images/PROVENANCE.json` for the source/method behind each asset.
