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

* 🐛 Fix cart state inconsistency — cart badge can show an item while basket renders empty
* ✨ Make Forage Fund interactive — clicking the ₴2,000 pill opens balance/spend information
* 🧪 Collection navigation regression suite — Wishlist, Reading List and Gift Cabinet, including empty-state transitions
* 🔐 Phase 2 frontend hardening — reduce inline handlers/innerHTML, improve escaping/CSP readiness
* 🗂️ Catalog semantic cleanup — stop making waxed-canvas ramen pots and porcelain watches 😂
* 🎁 Continue Gift Cabinet — recipient, occasion, notes and gift lifecycle
* 📚 Continue Books/Reading List — real books, formats, Amazon handoff and discovery improvements