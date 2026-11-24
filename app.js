let PRODUCTS=[];
const CATS=["All", "Moto", "Pottery", "Craft", "Korea", "Music", "Style", "Home", "Kitchen", "Deli", "Travel", "Adventure", "Cats", 'Books','Stationery & Paper','Gifts & Curiosities'];
async function loadCatalog(){const r=await fetch('catalog.json',{cache:'no-store'});if(!r.ok)throw new Error('catalog.json could not be loaded');PRODUCTS=await r.json();}
function forageStars(n){return'★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n))}
function forageStock(p){if(p.stock<=3)return`Only ${p.stock} left today`;if(p.limited)return`Limited batch · ${p.stock} available`;if(p.stock<=8)return`${p.stock} available`;return'In stock'}
function photo(p,big=false){const src=p.image||null;if(src)return `<div class="photo real-photo ${big?'big':''}"><img src="${esc(src)}" alt="${esc(p.name)}" loading="lazy"></div>`;const rr=((p.seed%9)-4)*1.7;return `<div class="photo" style="--r:${rr}deg"><div class="product-object" style="font-size:${big?110:66}px">${p.emoji}</div><div class="photo-label">Photo coming to Forage · ${esc(p.cat)}</div></div>`}
const DEFAULT_STATE={balance:2000,cart:[],wishlist:[],orders:[],purchases:0,spent:0,monthlySpent:0,fundMonth:null,filter:'All',query:'',sort:'daily',pageNo:1,readingList:[],giftIdeas:[]};
const VALID_SORTS=['daily','rating','low','high'];
const MONTHLY_FUND_AMOUNT=2000;
const ORDER_STATUSES=['Processing','Shipped','Out for delivery','Delivered'];
function sanitizeNumber(v,fallback){const n=Number(v);return Number.isFinite(n)?n:fallback}
function sanitizeCart(raw){
  if(!Array.isArray(raw))return [];
  return raw.filter(line=>line&&typeof line==='object'&&typeof line.id==='string'&&line.id).map(line=>({
    id:line.id,
    qty:Math.max(1,Math.floor(sanitizeNumber(line.qty,1))),
    option:typeof line.option==='string'?line.option:null
  }));
}
function sanitizeStringArray(raw){return Array.isArray(raw)?raw.filter(x=>typeof x==='string'):[]}
// Reconstructs a real, comparable delivery-target date for an order.
// New orders (from checkout()) always carry a valid deliveryAt already.
// Legacy orders placed before deliveryAt existed only have `delivery`, a
// pre-formatted display string with no year (e.g. "Thursday, September
// 19") - not reliably parseable on its own. We pair its month/day with the
// order's own placed year, rolling forward a year if that would land
// before the order was placed (handles orders placed near a year
// boundary, e.g. placed in December with a January delivery estimate).
//
// Calendar-date comparison, not raw timestamps: a candidate parses to
// local midnight (it's a date-only string with a year spliced in), while
// `placed` carries a real time-of-day. Comparing raw getTime() values
// would wrongly reject a same-day candidate whenever the order was placed
// any time after midnight - daysBetween() (itself date-only) is used for
// both the ordering check and the sanity bound below, so only calendar
// dates are ever compared, never the specific time of day.
//
// Reconstructed dates are sanity-bounded to LEGACY_WINDOW_MAX_DAYS after
// placed. Every shipping option Forage has ever offered resolves within
// days, not weeks, so a `delivery` string that technically parses but
// lands implausibly far out (corrupted data, a parsing fluke on a
// malformed string) is treated the same as one that doesn't parse at all
// - falling through to the safe fallback below - rather than trusted
// literally.
//
// Known limitation: `delivery` strings were generated via
// toLocaleDateString(undefined, ...), i.e. in whatever locale the browser
// that originally placed the order was running in. The regex below only
// strips a Latin-alphabet weekday prefix, and the Date constructor's
// string parsing only reliably understands English month names - so a
// legacy order placed in a non-English locale (e.g. a French "jeudi 3
// janvier") fails to parse here. That's handled safely (isNaN(candidate)
// below falls through to the generic fallback rather than crashing or
// silently misreading the date), but the original display date cannot be
// recovered in that case; there is no general fix for this without
// knowing the original locale, which was never recorded.
const LEGACY_WINDOW_MAX_DAYS=30;
function deriveDeliveryAt(order){
  if(typeof order.deliveryAt==='string'){
    const existing=new Date(order.deliveryAt);
    if(!isNaN(existing))return order.deliveryAt;
  }
  const placed=new Date(order.placed);
  const placedValid=!isNaN(placed);
  if(placedValid&&typeof order.delivery==='string'&&order.delivery){
    const cleaned=order.delivery.replace(/^[A-Za-z]+,\s*/,'');
    for(const yearOffset of [0,1]){
      const candidate=new Date(`${cleaned}, ${placed.getFullYear()+yearOffset}`);
      if(isNaN(candidate))continue;
      const daysOut=daysBetween(placed,candidate);
      if(daysOut>=0&&daysOut<=LEGACY_WINDOW_MAX_DAYS)return candidate.toISOString();
    }
  }
  const fallback=placedValid?new Date(placed):new Date();
  fallback.setDate(fallback.getDate()+5);
  return fallback.toISOString();
}
function sanitizeOrders(raw){
  return Array.isArray(raw)?raw.filter(o=>o&&typeof o==='object').map(o=>{
    const base={...o,items:Array.isArray(o.items)?o.items:[]};
    base.deliveryAt=deriveDeliveryAt(base);
    if(!ORDER_STATUSES.includes(base.status))base.status='Processing';
    return base;
  }):[];
}
// Date-only comparison (ignores time-of-day) throughout, so a day boundary
// reads the same way a person reads a date, and nothing flips mid-afternoon.
function startOfLocalDay(date){const d=new Date(date);d.setHours(0,0,0,0);return d}
function daysBetween(a,b){return Math.round((startOfLocalDay(b).getTime()-startOfLocalDay(a).getTime())/86400000)}
// Status is derived purely from elapsed time vs. the order's own
// placed->deliveryAt window, split into even fractional thirds across the
// four statuses, without a separate stored "shipping speed" field, and
// recomputes correctly no matter how long the app stayed closed - there's
// no timer or polling involved, just the real clock compared against the
// order's own dates.
//
// Standard (3 days) and Slow & scenic (5 days) windows are measured in
// whole calendar days (daysBetween, date-only), so status only ever moves
// at a day boundary, matching how a person reads a delivery date. Express
// (1 day) only has a single calendar day to work with, so day-level
// granularity would only ever produce Processing or Delivered - skipping
// Shipped and Out for delivery entirely. SUB_DAY_WINDOW_MS detects any
// order whose whole placed->deliveryAt window is short enough that this
// would happen (in practice, only Express) and measures elapsed time in
// hours instead, so it still reaches all four statuses within that one
// day while arriving exactly at the promised deliveryAt - unchanged by
// this distinction, since only the status ladder leading up to it does.
//
// The result is ratcheted against whatever status is already stored so a
// device clock moving backward (or briefly glitching) can never regress an
// order from, say, Delivered back to Processing - only forward progress
// is ever applied. (A clock jumping forward is not guarded against here:
// see the limitation noted on reconcileTimeState().)
const SUB_DAY_WINDOW_MS=36*60*60*1000;
function computeOrderStatus(order,now){
  const placed=new Date(order.placed);
  const target=new Date(order.deliveryAt);
  const storedIndex=ORDER_STATUSES.indexOf(order.status);
  if(isNaN(placed)||isNaN(target))return storedIndex>=0?order.status:'Processing';
  const totalMs=target.getTime()-placed.getTime();
  let fraction;
  if(totalMs>0&&totalMs<=SUB_DAY_WINDOW_MS){
    const elapsedMs=Math.max(0,now.getTime()-placed.getTime());
    fraction=elapsedMs/totalMs;
  }else{
    const totalDays=Math.max(1,daysBetween(placed,target));
    const elapsedDays=Math.max(0,daysBetween(placed,now));
    fraction=elapsedDays/totalDays;
  }
  let computedIndex;
  if(fraction>=1)computedIndex=3;
  else if(fraction>=0.66)computedIndex=2;
  else if(fraction>=0.33)computedIndex=1;
  else computedIndex=0;
  const effectiveIndex=Math.max(computedIndex,storedIndex>=0?storedIndex:0);
  return ORDER_STATUSES[effectiveIndex];
}
// Advances any order whose elapsed time now justifies a later status.
// Idempotent: calling this repeatedly with the same (or an earlier) `now`
// never changes anything further, since computeOrderStatus never regresses.
function syncOrderStatuses(now){
  now=now||new Date();
  let changed=false;
  state.orders.forEach(o=>{
    const next=computeOrderStatus(o,now);
    if(next!==o.status){o.status=next;changed=true;}
  });
  return changed;
}
function currentMonthKey(now){now=now||new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`}
function startOfNextMonth(now){now=now||new Date();return new Date(now.getFullYear(),now.getMonth()+1,1)}
function formatMonthDate(date){return date.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'})}
// One-time migration for pre-existing installs that predate monthly fund
// tracking (no fundMonth ever stored). Their current balance is a legacy
// artifact of the old unrestricted-manual-reset system, not a trustworthy
// "this month's remaining fund" figure - so rather than carrying it
// forward as-is, we reconstruct this month's spending from orders already
// placed this calendar month (bounded on both ends: on/after the 1st of
// this month, strictly before the 1st of next month, so an order dated
// outside this month - by clock skew or any other anomaly - is never
// miscounted) and set the migrated balance to max(0, MONTHLY_FUND_AMOUNT -
// monthlySpent): what the balance would be if replenishment had been
// working correctly all along. This corrects the accumulated effect of
// the bug immediately, on this very load, rather than waiting for the
// next calendar month's natural replenishment. Lifetime `spent` and every
// other field (orders, cart, wishlist, profile, ...) are left untouched.
function migrateFundState(now){
  if(typeof state.fundMonth==='string')return false;
  now=now||new Date();
  const monthStart=new Date(now.getFullYear(),now.getMonth(),1);
  const monthEnd=startOfNextMonth(now);
  state.fundMonth=currentMonthKey(now);
  state.monthlySpent=state.orders.reduce((sum,o)=>{
    const placed=new Date(o.placed);
    const inThisMonth=!isNaN(placed)&&placed.getTime()>=monthStart.getTime()&&placed.getTime()<monthEnd.getTime();
    return inThisMonth?sum+Number(o.total||0):sum;
  },0);
  state.balance=Math.max(0,MONTHLY_FUND_AMOUNT-state.monthlySpent);
  return true;
}
// Replenishes the fund to a flat MONTHLY_FUND_AMOUNT whenever the current
// calendar month has moved past the last month the fund was set for. Flat,
// not additive, so there's never rollover or accumulation. Guarded with a
// string compare (not just !==) so a device clock that jumps backward can
// never trigger a second replenishment for a month already paid out -
// only a genuinely later month does.
function syncFundMonth(now){
  now=now||new Date();
  if(typeof state.fundMonth!=='string'){state.fundMonth=currentMonthKey(now);return false}
  const key=currentMonthKey(now);
  if(key<=state.fundMonth)return false;
  state.fundMonth=key;
  state.balance=MONTHLY_FUND_AMOUNT;
  state.monthlySpent=0;
  return true;
}
// Single entry point for both startup and foreground-return reconciliation.
// Pure w.r.t. repeated calls at the same `now` (idempotent): fund sync and
// order-status sync are each idempotent on their own, so running both
// again changes nothing further.
//
// Known limitation: everything here trusts the device clock. The
// ratchets in syncFundMonth()/computeOrderStatus() only guard against the
// clock moving *backward* (so an earlier glitch can't double-replenish
// the fund or regress an order's status once it has corrected itself).
// An accidental *forward* jump - a device clock temporarily wrong, then
// corrected - is indistinguishable from real elapsed time: it can
// trigger a genuine, un-reversed fund replenishment or order delivery a
// touch early. There's no reliable client-only fix for this (it would
// need a trusted external time source, i.e. a backend), and one isn't
// warranted for a fictional shopping app - this is accepted as a known,
// low-stakes limitation rather than something to engineer around.
function reconcileTimeState(now){
  now=now||new Date();
  const fundChanged=syncFundMonth(now);
  const statusChanged=syncOrderStatuses(now);
  return fundChanged||statusChanged;
}
function sanitizeProfile(p){
  const defaults={
    displayName:'Julz',
    defaultAddress:{label:'Home base',recipient:'Julz',line1:'123 Forage Lane',line2:'',city:'Chapel Hill',region:'NC',postal:'27514'},
    addresses:[],
    paymentMethods:[
      {id:'pm1',brand:'Visa',label:'Forage Visa',last4:'4242',default:true},
      {id:'pm2',brand:'Mastercard',label:'Trail Rewards',last4:'8841',default:false}
    ]
  };
  const src=p&&typeof p==='object'&&!Array.isArray(p)?p:{};
  const addr=src.defaultAddress&&typeof src.defaultAddress==='object'&&!Array.isArray(src.defaultAddress)?src.defaultAddress:{};
  const methods=Array.isArray(src.paymentMethods)?src.paymentMethods.filter(m=>m&&typeof m==='object'&&typeof m.id==='string'&&m.id):[];
  return {
    displayName:typeof src.displayName==='string'?src.displayName:defaults.displayName,
    defaultAddress:{...defaults.defaultAddress,...addr},
    addresses:Array.isArray(src.addresses)?src.addresses:defaults.addresses,
    paymentMethods:methods.length?methods:defaults.paymentMethods
  };
}
function loadState(){
  try{
    const raw=localStorage.getItem('forageV2State');
    const parsed=raw?JSON.parse(raw):{};
    const safe=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
    return {...DEFAULT_STATE,...safe,
      balance:sanitizeNumber(safe.balance,DEFAULT_STATE.balance),
      spent:sanitizeNumber(safe.spent,DEFAULT_STATE.spent),
      monthlySpent:sanitizeNumber(safe.monthlySpent,DEFAULT_STATE.monthlySpent),
      fundMonth:typeof safe.fundMonth==='string'?safe.fundMonth:null,
      purchases:sanitizeNumber(safe.purchases,DEFAULT_STATE.purchases),
      pageNo:Math.max(1,Math.floor(sanitizeNumber(safe.pageNo,DEFAULT_STATE.pageNo))),
      filter:typeof safe.filter==='string'&&CATS.includes(safe.filter)?safe.filter:DEFAULT_STATE.filter,
      sort:VALID_SORTS.includes(safe.sort)?safe.sort:DEFAULT_STATE.sort,
      query:typeof safe.query==='string'?safe.query:DEFAULT_STATE.query,
      cart:sanitizeCart(safe.cart),
      wishlist:sanitizeStringArray(safe.wishlist),
      orders:sanitizeOrders(safe.orders),
      readingList:Array.isArray(safe.readingList)?safe.readingList:[],
      giftIdeas:Array.isArray(safe.giftIdeas)?safe.giftIdeas:[]
    };
  }catch(e){console.warn('Forage state reset after invalid local data.',e);return {...DEFAULT_STATE};}
}
let state=loadState();

state.profile=sanitizeProfile(state.profile);
let page='shop',selected=null;
let openGiftEdits=new Set();
function save(){localStorage.setItem('forageV2State',JSON.stringify(state));renderHeader()}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function money(n){n=Number(n);const opts=Number.isInteger(n)?{}:{minimumFractionDigits:2,maximumFractionDigits:2};return 'Ƶ '+n.toLocaleString(undefined,opts)}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1700)}
function addDays(date,days){const d=new Date(date);d.setDate(d.getDate()+days);return d}
function formatDeliveryDate(date){return date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
function deliveryDate(days=3){return formatDeliveryDate(addDays(new Date(),days))}
function daySeed(){const d=new Date();return Number(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`)}
function dailyScore(p){return ((p.seed*9301+daySeed()*49297)%233280)/233280}
function renderFundPanel(){
  const panel=document.getElementById('fundPanel');
  if(!panel)return;
  const next=formatMonthDate(startOfNextMonth());
  panel.innerHTML=`<h3>Forage Fund</h3><p>Your fictional spending money for the hunt.</p><div class="fund-amount">${money(state.balance)}</div><div class="fund-row"><span>Starting fund</span><strong>${money(MONTHLY_FUND_AMOUNT)}</strong></div><div class="fund-row"><span>Spent</span><strong>${money(state.monthlySpent)}</strong></div><div class="fund-row"><span>Remaining</span><strong>${money(state.balance)}</strong></div><div class="fund-row"><span>Next refresh</span><strong>${next}</strong></div>`;
}
function toggleFund(event){
  event?.stopPropagation();
  const panel=document.getElementById('fundPanel'),button=document.getElementById('balanceBox');
  const opening=panel.hidden;
  if(opening)renderFundPanel();
  panel.hidden=!opening;
  button.setAttribute('aria-expanded',String(opening));
}
function closeFund(){const p=document.getElementById('fundPanel'),b=document.getElementById('balanceBox');if(p&&!p.hidden){p.hidden=true;b?.setAttribute('aria-expanded','false')}}

// Forage Friend (V1: "Just Wandering") — a lightweight, deterministic-testable
// discovery guide built entirely on existing catalog metadata and session
// state. No external service, no new purchasing flow, no fabricated history.
// friendSeenIds/friendCurrent/friendSessionActive are in-memory only, like
// page/selected/openGiftEdits: a "discovery session" starts on "I'm just
// wandering" and survives dismiss/reopen for the rest of the page visit —
// only an explicit restart or a page reload clears it.
let friendSessionActive=false;
let friendSeenIds=new Set();
let friendCurrent=null;
const FRIEND_MODE_ORDER=['unexpected','adjacent','change-of-scenery','rediscovery','wildcard'];
const FRIEND_MODE_WEIGHTS={unexpected:0.4,adjacent:0.3,'change-of-scenery':0.2,rediscovery:0.1,wildcard:0};
const FRIEND_MODE_COPY={
  unexpected:"Ooh — this one's part of a limited batch. I don't see those every day.",
  adjacent:"Since you've been circling that part of the market, I thought you might like this too.",
  'change-of-scenery':"Completely different corner of the market. Fancy a change of scenery?",
  rediscovery:"You tucked this one away a while back. Still curious about it?",
  wildcard:"No particular reason — I just liked the look of this one."
};
function friendValidCandidate(p){
  return !!(p&&typeof p==='object'
    &&typeof p.id==='string'&&p.id
    &&typeof p.name==='string'&&p.name
    &&typeof p.desc==='string'&&p.desc
    &&typeof p.cat==='string'&&p.cat
    &&Number.isFinite(Number(p.price))&&Number(p.price)>0
    &&Number(p.stock)>0);
}
// Categories the visitor has shown real interest in: wishlisted, carted,
// ordered, or the category they're currently browsing. Never invented.
function friendInteractedCategories(){
  const ids=new Set([
    ...state.wishlist,
    ...state.cart.map(line=>line.id),
    ...state.orders.flatMap(o=>o.items.map(line=>line.id))
  ]);
  const cats=new Set();
  PRODUCTS.forEach(p=>{if(ids.has(p.id))cats.add(p.cat)});
  if(state.filter&&state.filter!=='All')cats.add(state.filter);
  return cats;
}
function friendCandidatePools(){
  const base=PRODUCTS.filter(friendValidCandidate).filter(p=>!friendSeenIds.has(p.id));
  const cats=friendInteractedCategories();
  return {
    unexpected:base.filter(p=>p.limited===true),
    adjacent:cats.size?base.filter(p=>cats.has(p.cat)):[],
    'change-of-scenery':cats.size?base.filter(p=>!cats.has(p.cat)):[],
    rediscovery:base.filter(p=>state.wishlist.includes(p.id)),
    wildcard:base
  };
}
// Picks a mode (weighted, reallocating unavailable modes' weight to whichever
// modes still have candidates) then a candidate from that mode's pool. Takes
// an injectable rng (defaults to Math.random) so selection is deterministic
// and testable without touching global randomness.
function pickFriendSuggestion(rng){
  rng=rng||Math.random;
  const pools=friendCandidatePools();
  const available=FRIEND_MODE_ORDER.filter(mode=>pools[mode].length>0);
  if(!available.length)return null;
  const weights=available.map(mode=>FRIEND_MODE_WEIGHTS[mode]);
  const sum=weights.reduce((a,b)=>a+b,0);
  const normalized=sum>0?weights.map(w=>w/sum):weights.map(()=>1/available.length);
  let r=rng(),acc=0,chosenMode=available[available.length-1];
  for(let i=0;i<available.length;i++){
    acc+=normalized[i];
    if(r<acc){chosenMode=available[i];break}
  }
  const pool=pools[chosenMode];
  const idx=Math.min(pool.length-1,Math.floor(rng()*pool.length));
  const product=pool[idx];
  friendSeenIds.add(product.id);
  return {mode:chosenMode,product};
}
function friendThumb(p){
  return p.image?`<img src="${esc(p.image)}" alt="">`:`<span style="font-size:28px">${p.emoji}</span>`;
}
function renderFriendPanel(){
  const panel=document.getElementById('friendPanel');
  if(!panel)return;
  if(!friendSessionActive){
    panel.innerHTML=`<h3>Friend</h3><p class="friend-intro-line">Oh, lovely. No particular destination, then.</p><div class="friend-actions"><button class="primary" data-action="friend-start-wander">I'm just wandering</button><button class="secondary" data-action="friend-dismiss">Not today</button></div>`;
    return;
  }
  if(!friendCurrent){
    panel.innerHTML=`<h3>Friend</h3><p class="friend-intro-line">I think I've shown you everything I've got for now. Check back later?</p><div class="friend-actions"><button class="secondary" data-action="friend-start-wander">Start a new wander</button><button class="secondary" data-action="friend-dismiss">Alright</button></div>`;
    return;
  }
  const{mode,product}=friendCurrent;
  panel.innerHTML=`<h3>Friend</h3><p class="friend-intro-line">I noticed something interesting. Would you like to see?</p><div class="friend-card"><div class="friend-thumb">${friendThumb(product)}</div><div><strong>${esc(product.name)}</strong><div class="friend-eyebrow">${esc(displayCat(product))}</div></div></div><p class="friend-note">${esc(FRIEND_MODE_COPY[mode])}</p><div class="friend-actions"><button class="primary" data-action="friend-open-suggestion" data-id="${esc(product.id)}">Take a look</button><button class="secondary" data-action="friend-next">Show me another</button><button class="secondary" data-action="friend-dismiss">Not right now</button></div>`;
}
// The panel lives inside a position:sticky header, so once that header is
// pinned at the top of the viewport, scrolling the page can never reveal
// more of the panel - it's pinned too. Without a height cap, a tall panel
// can run off the bottom of a short viewport with no way to reach the rest.
//
// The cap is computed from the visible space below the toggle button:
// window.visualViewport.height, when available, so it tracks mobile
// Safari's dynamic toolbar (the visible area shrinks/grows as it
// collapses/expands) and the on-screen keyboard. On a real device the
// visual viewport can also be offset from the layout viewport once the
// page has scrolled (visualViewport.offsetTop) - getBoundingClientRect()
// always reports layout-viewport coordinates, so that offset has to be
// subtracted to get the anchor's position within what's actually visible.
// A desktop-Chromium simulation never introduces this offset, which is why
// an earlier version of this fix (omitting the offsetTop correction) could
// pass every automated check here and still run off-screen on a real
// iPhone, where the offset is routinely nonzero.
function positionFriendPanel(){
  const panel=document.getElementById('friendPanel'),wrap=panel?.closest('.friend-wrap');
  if(!panel||!wrap||panel.hidden)return;
  const vv=window.visualViewport;
  const rect=wrap.getBoundingClientRect();
  const viewportHeight=vv?vv.height:window.innerHeight;
  const viewportOffsetTop=vv?vv.offsetTop:0;
  const viewportOffsetLeft=vv?vv.offsetLeft:0;
  const anchorBottomInVisualViewport=rect.bottom-viewportOffsetTop;
  const anchorRightInVisualViewport=rect.right-viewportOffsetLeft;
  const margin=16;
  const availableHeight=Math.max(160,Math.floor(viewportHeight-anchorBottomInVisualViewport-margin));
  // The panel is right:0-anchored to its toggle button, so its right edge
  // already tracks the anchor's real position - the horizontal risk is its
  // own width pushing the LEFT edge past the visible area, which pinch-zoom
  // can do even though the dynamic toolbar (the vertical case above) can't
  // move horizontally. anchorRightInVisualViewport is exactly how much
  // space exists between the visual viewport's own left edge and the
  // anchor, so capping width to that (minus margin) keeps the left edge on
  // screen regardless of zoom or horizontal visual-viewport offset.
  const availableWidth=Math.max(200,Math.floor(anchorRightInVisualViewport-margin));
  panel.style.maxHeight=availableHeight+'px';
  panel.style.maxWidth=availableWidth+'px';
}
let friendPositionRaf=null;
function scheduleFriendReposition(){
  if(friendPositionRaf)return;
  friendPositionRaf=requestAnimationFrame(()=>{friendPositionRaf=null;positionFriendPanel()});
}
// resize covers the toolbar collapsing/expanding on most iOS versions;
// scroll covers offsetTop changing independently of a resize event during
// the toolbar's show/hide transition; orientationchange and the plain
// window resize are defensive fallbacks for browsers without
// visualViewport. All are cheap no-ops via positionFriendPanel()'s own
// hidden-panel guard when Friend isn't open.
window.visualViewport?.addEventListener('resize',scheduleFriendReposition);
window.visualViewport?.addEventListener('scroll',scheduleFriendReposition);
window.addEventListener('resize',scheduleFriendReposition);
window.addEventListener('orientationchange',scheduleFriendReposition);
function openFriend(){
  const panel=document.getElementById('friendPanel'),button=document.getElementById('friendToggle');
  if(!panel||!button)return;
  renderFriendPanel();
  panel.hidden=false;
  button.setAttribute('aria-expanded','true');
  positionFriendPanel();
  panel.querySelector('button')?.focus();
}
// Closing (explicit button, outside click, or Escape) only hides the panel.
// It never touches page/filter/scroll state, so the visitor's browsing
// context is left exactly as they left it, and it never resets the
// wandering session: friendSessionActive/friendSeenIds/friendCurrent persist
// so reopening Friend later in the same page visit resumes exactly where she
// left off. A session only ends via friendStartWander() (explicit restart)
// or a page reload (in-memory state is gone either way).
function closeFriend(){
  const panel=document.getElementById('friendPanel'),button=document.getElementById('friendToggle');
  if(!panel||panel.hidden)return;
  panel.hidden=true;
  button?.setAttribute('aria-expanded','false');
}
function toggleFriend(event){
  event?.stopPropagation();
  const panel=document.getElementById('friendPanel');
  if(!panel)return;
  if(panel.hidden)openFriend();else closeFriend();
}
function friendStartWander(){
  friendSessionActive=true;
  friendSeenIds=new Set();
  friendCurrent=pickFriendSuggestion();
  renderFriendPanel();
  document.getElementById('friendPanel')?.querySelector('button')?.focus();
}
function friendNext(){
  friendCurrent=pickFriendSuggestion();
  renderFriendPanel();
  document.getElementById('friendPanel')?.querySelector('button')?.focus();
}
function friendOpenSuggestion(id){
  closeFriend();
  openProduct(id);
}

function renderHeader(){
  document.getElementById('balanceBox').textContent=money(state.balance);
  renderFundPanel();
  const items=[['shop','Discover'],['cart','Cart'],['orders','Orders'],['stats','Stats'],['gifts','🎁 Gift Cabinet'],['wishlist','Wishlist'],['reading','📚 Reading List'],['profile','Profile']];
  document.getElementById('nav').innerHTML=items.map(([id,label])=>`<button class="${page===id?'active':''} ${id==='gifts'?'nav-spacer':''}" data-action="go" data-page="${id}">${label}${id==='cart'&&state.cart.length?`<span class="badge">${state.cart.reduce((s,x)=>s+x.qty,0)}</span>`:''}</button>`).join('');
}

function go(p){page=p;selected=null;render();window.scrollTo({top:0,behavior:'smooth'})}

function productCard(p){const wished=state.wishlist.includes(p.id);return `<article class="card" data-action="open-product" data-id="${esc(p.id)}"><div class="art">${photo(p)}<div class="art-label">${esc(displayCat(p))}</div><button class="heart ${wished?'on':''}" data-action="toggle-wish" data-id="${esc(p.id)}">${wished?'♥':'♡'}</button></div><div class="cardbody"><div><span class="discovery-badge">${esc(p.marketBadge)}</span>${p.limited?'<span class="discovery-badge">Limited</span>':''}</div><h3>${esc(p.name)}</h3>${p.realBook?`<p class="sub" style="margin:2px 0 8px">${esc(p.author)} · ${esc(p.bookTopic)}</p>`:''}<div class="rating">${forageStars(p.rating)} ${p.rating.toFixed(1)} · ${p.reviews.toLocaleString()} reviews</div><p>${esc(p.desc)}</p><div class="stockline">${forageStock(p)}</div><div class="actions" style="margin-top:10px"><button class="secondary" data-action="open-product" data-id="${esc(p.id)}">Details →</button></div><div class="price">${money(p.price)} ${p.oldPrice?`<span class="old">${money(p.oldPrice)}</span>`:''}</div></div></article>`}
function toggleWish(id){const i=state.wishlist.indexOf(id);if(i>=0){state.wishlist.splice(i,1);toast('Removed from wishlist')}else{state.wishlist.push(id);toast('Saved for later')}save();render()}
function viewProduct(id){selected=PRODUCTS.find(p=>p.id===id);page='detail';render();window.scrollTo({top:0,behavior:'smooth'})}
function optionLabel(v){return (v&&typeof v==='object')?v.label:v}
// Resolves the price for a selected variant/size label. Object-form entries
// ({label, price}) override the base price; plain strings and anything
// malformed or unmatched (stale persisted option, missing/non-numeric/zero
// price) fall back to the product's own base price rather than throwing or
// charging a bad amount.
function optionPrice(p,option){
  const findIn=arr=>Array.isArray(arr)?arr.find(v=>optionLabel(v)===option):null;
  const match=findIn(p.sizes)||findIn(p.variants);
  if(match&&typeof match==='object'&&Number.isFinite(Number(match.price))&&Number(match.price)>0)return Number(match.price);
  return p.price;
}
function selectedOption(p){if(p.sizes?.length)return document.getElementById('sizeSelect')?.value||optionLabel(p.sizes[0]);if(p.variants?.length)return document.getElementById('variantSelect')?.value||optionLabel(p.variants[0]);return null}
// <option> value is always the plain label (what's stored as line.option);
// only the visible text gains a price suffix for priced (object-form) entries.
function optionChoiceHtml(v){
  const label=optionLabel(v);
  const priced=v&&typeof v==='object'&&Number.isFinite(Number(v.price))&&Number(v.price)>0;
  const text=priced?`${label} — ${money(Number(v.price))}`:label;
  return `<option value="${esc(label)}">${esc(text)}</option>`;
}
function addCart(id){const p=PRODUCTS.find(x=>x.id===id),qty=Math.max(1,parseInt(document.getElementById('qtySelect')?.value||'1')),option=selectedOption(p),existing=state.cart.find(x=>x.id===id&&x.option===option);if(existing)existing.qty+=qty;else state.cart.push({id,qty,option});save();toast(`Added ${qty} to basket`);render()}
function removeCart(i){state.cart.splice(i,1);save();render()}
function filteredProducts(){
  let arr=PRODUCTS.filter(p=>{
    const categoryMatch=state.filter==='All'
      ||(state.filter==='Books'&&p.realBook)
      ||(state.filter==='Stationery & Paper'&&p.cat==='Stationery & Paper'&&!p.realBook)
      ||p.cat===state.filter;
    return categoryMatch&&(!state.query||(`${p.name} ${p.author||''} ${p.bookTopic||''} ${p.cat} ${p.desc}`).toLowerCase().includes(state.query.toLowerCase()));
  });
  if(state.sort==='daily')arr.sort((a,b)=>dailyScore(a)-dailyScore(b));
  if(state.sort==='rating')arr.sort((a,b)=>b.rating-a.rating||b.reviews-a.reviews);
  if(state.sort==='low')arr.sort((a,b)=>a.price-b.price);
  if(state.sort==='high')arr.sort((a,b)=>b.price-a.price);
  return arr;
}
function setQuery(v){
  state.query=v;state.pageNo=1;save();
  renderProductResults();
}
function setSort(v){
  state.sort=v;state.pageNo=1;save();
  renderProductResults();
}
function setFilter(c){
  state.filter=c;
  state.query='';
  state.pageNo=1;
  const search=document.getElementById('searchInput');
  if(search) search.value='';
  save();
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===c));
  renderProductResults();
}
function renderShop(){
  return `<section class="hero"><div><div class="eyebrow" style="color:#e7efe9">Morning expedition</div><h1>Explore.</h1><p>One thousand things, reshuffled every morning. Look around. Stay awhile. Take home what catches you.</p></div><div class="hero-card"><strong>Today’s forage fund</strong><div style="font-size:38px;font-weight:900;margin:8px 0">${money(state.balance)}</div><div style="opacity:.85">Today’s Finds rotate every morning.</div></div></section><div id="shopArea"></div>`;
}
function renderShopInto(){
  const root=document.getElementById('shopArea'); if(!root)return;
  root.innerHTML=`<div class="section-head"><div><h2 id="resultsTitle">Today’s finds</h2><p id="resultsMeta"></p></div></div>
  <div class="toolbar">
    <input id="searchInput" class="search" placeholder="${state.filter==='All'?`Search ${PRODUCTS.length.toLocaleString()} finds…`:`Search ${filteredProducts().length.toLocaleString()} ${state.filter} finds…`}" value="${esc(state.query)}">
    <select id="sortSelect" class="sort">
      <option value="daily" ${state.sort==='daily'?'selected':''}>Today’s order</option>
      <option value="rating" ${state.sort==='rating'?'selected':''}>Highest rated</option>
      <option value="low" ${state.sort==='low'?'selected':''}>Price: low to high</option>
      <option value="high" ${state.sort==='high'?'selected':''}>Price: high to low</option>
    </select>
  </div>
  <div class="filters" id="filterBar">${CATS.map(c=>`<button class="chip ${state.filter===c?'active':''}" data-filter="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div class="market-strip">
<div class="market-note"><strong>✦ Rare finds</strong><span>Some things surface less often.</span></div>
<div class="market-note"><strong>▣ Small batches</strong><span>Stock varies across the market.</span></div>
<div class="market-note"><strong>★ Opinionated reviews</strong><span>Not everything gets five stars.</span></div>
<div class="market-note"><strong>↻ Fresh tomorrow</strong><span>The hunt reshuffles each morning.</span></div>
</div><div id="productResults"></div>`;
  document.getElementById('searchInput').addEventListener('input',e=>setQuery(e.target.value));
  document.getElementById('sortSelect').addEventListener('change',e=>setSort(e.target.value));
  document.getElementById('filterBar').addEventListener('click',e=>{
    const b=e.target.closest('[data-filter]'); if(b)setFilter(b.dataset.filter);
  });
  renderProductResults();
}
function renderProductResults(){
  const host=document.getElementById('productResults'); if(!host)return;
  const arr=filteredProducts(),per=24,pages=Math.max(1,Math.ceil(arr.length/per));
  state.pageNo=Math.min(state.pageNo,pages);
  const subset=arr.slice((state.pageNo-1)*per,state.pageNo*per);
  const title=document.getElementById('resultsTitle'); if(title)title.textContent=state.query?'Search results':'Today’s finds';
  const meta=document.getElementById('resultsMeta'); if(meta)meta.textContent=`${arr.length.toLocaleString()} products in the market · showing ${subset.length}`;
  host.innerHTML=arr.length
    ? `<div class="grid">${subset.map(productCard).join('')}</div>${pages>1?`<div class="pager"><button class="secondary" ${state.pageNo===1?'disabled':''} data-action="page-prev">← Prev</button><span class="pill">Page ${state.pageNo} / ${pages}</span><button class="secondary" ${state.pageNo===pages?'disabled':''} data-action="page-next">Next →</button></div>`:''}`
    : `<div class="empty">No finds matched that search. Try another word, or tap a category to start a fresh browse.</div>`;
}
function openProduct(id){selected=PRODUCTS.find(p=>p.id===id)||null;if(!selected)return;page='detail';render();window.scrollTo({top:0,behavior:'smooth'})}
const FORAGE_SIZE_CHART=[['XS','31–33"','24–26"','34–36"','28"','31"'],['S','33–35"','26–28"','36–38"','29"','31"'],['M','35–38"','28–31"','38–41"','29"','32"'],['L','38–41"','31–34"','41–44"','29"','32"'],['XL','41–44"','34–38"','44–47"','29"','32"']];
function showSizeGuide(p){const rows=FORAGE_SIZE_CHART.map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('');document.body.insertAdjacentHTML('beforeend',`<div class="modalback" id="sizeModal" data-action="close-modal-backdrop"><div class="modal"><button class="secondary" style="float:right" data-action="close-size-modal">Close</button><h2>Forage size guide</h2><p>Body measurements in inches. Fictional, but internally consistent.</p><div style="overflow:auto"><table class="size-table"><tr><th>Size</th><th>Bust</th><th>Waist</th><th>Hip</th><th>Short</th><th>Regular</th></tr>${rows}</table></div>${p.fitNote?`<p><strong>Fit note:</strong> ${esc(p.fitNote)}</p>`:''}</div></div>`)}
function fieldNotes(p){if(!p.fieldNotes)return'';return `<section class="field-notes"><div class="location">Field Notes · ${esc(p.fieldNotes.location)}</div><h3>The story behind the find</h3><p>${esc(p.fieldNotes.story)}</p><div class="forage-aside">${esc(p.forageAside)}</div></section>`}




function displayCat(p){return p.realBook?'Books':p.cat}


function amazonBook(p){
 // Search handoff, not a verified product link: we only know title/author, not a
 // confirmed ASIN or listing, so a search URL is the honest representation.
 if(!p)return;
 const q=encodeURIComponent(`${p.name} ${p.author||''}`);
 window.open(`https://www.amazon.com/s?k=${q}`,'_blank','noopener,noreferrer');
}

function saveReading(id){
 const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
 state.readingList=state.readingList||[];
 if(state.readingList.some(x=>x.id===id)){toast("Already in Reading List");return;}
 state.readingList.unshift({id,name:p.name,status:"Want to Read"});
 save();toast("Saved to Reading List");
}
function saveGiftIdea(id,meta){
 const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
 state.giftIdeas=state.giftIdeas||[];
 if(state.giftIdeas.some(x=>x.id===id)){toast("Already in Gift Cabinet");return;}
 const{person='',occasion='',note=''}=meta||{};
 state.giftIdeas.unshift({id,name:p.name,person,occasion,note,status:'Idea'});
 save();toast("Saved to Gift Cabinet");
}
let giftModalReturnFocus=null;
function openGiftModal(id){
 const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
 if((state.giftIdeas||[]).some(x=>x.id===id)){toast("Already in Gift Cabinet");return;}
 giftModalReturnFocus=document.querySelector(`[data-action="open-gift-modal"][data-id="${CSS.escape(id)}"]`);
 document.body.insertAdjacentHTML('beforeend',`<div class="modalback" id="giftModal" data-action="close-modal-backdrop"><div class="modal"><h2>🎁 Save as a gift idea</h2><p style="color:var(--muted);margin-top:0">${esc(p.name)}</p><div class="form-grid" style="margin-top:14px"><label class="full">Recipient<input id="giftModalRecipient" placeholder="Who's it for? (optional)"></label><label class="full">Occasion<input id="giftModalOccasion" placeholder="Birthday, just because… (optional)"></label><label class="full">Note<textarea id="giftModalNote" placeholder="Why you saved this (optional)"></textarea></label></div><div class="actions" style="margin-top:16px;justify-content:flex-end"><button class="secondary" data-action="close-gift-modal">Cancel</button><button class="primary" data-action="confirm-gift-modal" data-id="${esc(p.id)}">Save to Gift Cabinet</button></div></div></div>`);
 document.getElementById('giftModalRecipient')?.focus();
}
function closeGiftModal(){
 document.getElementById('giftModal')?.remove();
 giftModalReturnFocus?.focus();
 giftModalReturnFocus=null;
}
function confirmGiftModal(id){
 const person=(document.getElementById('giftModalRecipient')?.value||'').trim();
 const occasion=(document.getElementById('giftModalOccasion')?.value||'').trim();
 const note=(document.getElementById('giftModalNote')?.value||'').trim();
 saveGiftIdea(id,{person,occasion,note});
 closeGiftModal();
}
const READING_STATUSES=['Want to Read','Read'];
function normalizeReadingList(){
  if(!Array.isArray(state.readingList))state.readingList=[];
  state.readingList=state.readingList.map(x=>{
    if(typeof x==='string'){
      const p=PRODUCTS.find(p=>p.id===x);
      return p?{id:p.id,name:p.name,status:'Want to Read'}:null;
    }
    if(!x||typeof x!=='object')return null;
    const p=PRODUCTS.find(p=>p.id===x.id);
    const id=typeof x.id==='string'?x.id:(p?.id||'');
    if(!id)return null;
    const name=typeof x.name==='string'&&x.name?x.name:(p?.name||'Untitled book');
    let status=typeof x.status==='string'?x.status:'Want to Read';
    if(!READING_STATUSES.includes(status))status='Want to Read';
    return {id,name,status};
  }).filter(Boolean);
}
function readingEntrySub(x,p){
  // Author/topic/format facts are read live from the catalog, never invented here.
  if(!p)return'Details no longer available';
  const parts=[esc(p.author),esc(p.bookTopic)].filter(Boolean);
  return parts.join(' · ');
}
function readingEntryFormats(p){
  if(!p||!Array.isArray(p.formats)||!p.formats.length)return'Format info not available';
  return esc(p.formats.join(' · '));
}
function renderReading(){
 normalizeReadingList();
 const xs=state.readingList;
 return `<div class="section-head"><div><h2>📚 Reading List</h2><p>Books worth keeping within reach.</p></div></div>${xs.length?xs.map((x,i)=>{
   const p=PRODUCTS.find(pr=>pr.id===x.id);
   return `<div class="cartline"><div class="miniart">📚</div><div><strong>${esc(x.name)}</strong><div class="eyebrow">${readingEntrySub(x,p)}</div><div class="eyebrow">${readingEntryFormats(p)}</div></div><div><select data-action="reading-status" data-index="${i}"><option ${x.status==='Want to Read'?'selected':''}>Want to Read</option><option ${x.status==='Read'?'selected':''}>Read</option></select>${p?`<button class="secondary" data-action="open-product" data-id="${esc(p.id)}">Details →</button><button class="secondary" data-action="amazon-book" data-id="${esc(p.id)}">↗ Amazon</button>`:''}<button class="danger" data-action="remove-reading" data-index="${i}">Remove</button></div></div>`;
 }).join(''):`<div class="empty">No books saved yet. The shelves are waiting.</div>`}`;
}
const GIFT_STATUSES=['Idea','Purchased','Given'];
function normalizeGiftIdeas(){
  if(!Array.isArray(state.giftIdeas))state.giftIdeas=[];
  state.giftIdeas=state.giftIdeas.map(x=>{
    if(!x||typeof x!=='object')return null;
    const p=PRODUCTS.find(p=>p.id===x.id);
    const name=typeof x.name==='string'&&x.name?x.name:(p?.name||'Untitled find');
    if(!p&&typeof x.id!=='string')return null;
    let status=typeof x.status==='string'?x.status:'Idea';
    if(status==='Fictionally Purchased'||status==='Actually Purchased')status='Purchased';
    if(!GIFT_STATUSES.includes(status))status='Idea';
    return {
      id:typeof x.id==='string'?x.id:(p?.id||''),
      name,
      person:typeof x.person==='string'?x.person:'',
      occasion:typeof x.occasion==='string'?x.occasion:'',
      note:typeof x.note==='string'?x.note:'',
      status
    };
  }).filter(Boolean);
}
function giftSummary(x){
  const parts=[];
  if(x.person)parts.push(`For ${x.person}`);
  if(x.occasion)parts.push(x.occasion);
  return parts.length?parts.join(' · '):'No details yet — add them below';
}
function renderGifts(){
 normalizeGiftIdeas();
 const xs=state.giftIdeas||[];
 return `<div class="section-head"><div><h2>🎁 Gift Cabinet</h2><p>Things that made you think of someone.</p></div></div>${xs.length?xs.map((x,i)=>{
   const editing=openGiftEdits.has(x.id);
   return `<div class="cartline"${x.status==='Given'?' style="opacity:.6"':''}><div class="miniart">🎁</div><div><strong>${esc(x.name)}</strong><div class="eyebrow">${esc(giftSummary(x))}</div>${!editing&&x.note?`<p>${esc(x.note)}</p>`:''}<button class="size-link" data-action="gift-edit-toggle" data-id="${esc(x.id)}">${editing?'Hide details':'Edit details →'}</button>${editing?`<div class="form-grid" style="margin-top:8px"><label class="full">Recipient<input value="${esc(x.person)}" placeholder="Who's it for?" data-action="gift-recipient" data-index="${i}"></label><label class="full">Occasion<input value="${esc(x.occasion)}" placeholder="Birthday, just because…" data-action="gift-occasion" data-index="${i}"></label><label class="full">Notes<textarea placeholder="Why you saved this" data-action="gift-note" data-index="${i}">${esc(x.note)}</textarea></label></div>`:''}</div><div><select data-action="gift-status" data-index="${i}">${GIFT_STATUSES.map(s=>`<option ${x.status===s?'selected':''}>${s}</option>`).join('')}</select><button class="danger" data-action="remove-gift" data-index="${i}">Remove</button></div></div>`;
 }).join(''):`<div class="empty">No gift ideas yet.</div>`}`;
}
function renderDetail(){const p=selected;if(!p)return'';const optionControl=p.sizes?.length?`<div><label>Size<select id="sizeSelect" data-action="option-change">${p.sizes.map(optionChoiceHtml).join('')}</select></label><button class="size-link" data-action="show-size-guide">Size guide →</button></div>`:p.variants?.length?`<div><label>Variant<select id="variantSelect" data-action="option-change">${p.variants.map(optionChoiceHtml).join('')}</select></label></div>`:'';const maxQty=Math.max(1,Math.min(5,p.stock));return `<button class="secondary" data-action="go" data-page="shop" style="margin-bottom:14px">← Back to hunting</button><div class="detail">${photo(p,true)}<div><div class="eyebrow">${esc(displayCat(p))}${p.rarity?` · ${esc(p.rarity)}`:''}</div><div><span class="discovery-badge">${esc(p.marketBadge)}</span>${p.limited?'<span class="discovery-badge">Limited batch</span>':''}</div><h1>${esc(p.name)}</h1>${p.realBook?`<p class="sub"><strong>${esc(p.author)}</strong> · ${esc(p.bookTopic)}</p>`:''}<div id="detailPrice" style="font-size:26px;font-weight:900">${money(optionPrice(p,selectedOption(p)))}${p.oldPrice?`<span class="old">${money(p.oldPrice)}</span>`:''}</div><div class="rating" style="margin-top:6px">${forageStars(p.rating)} ${p.rating.toFixed(1)} · ${p.reviews.toLocaleString()} ratings</div><div class="stockline">${forageStock(p)}</div><p>${esc(p.desc)}</p>${fieldNotes(p)}<div class="specs">${Object.entries(p.specs).map(([k,v])=>`<div class="spec"><div class="eyebrow">${esc(k)}</div><strong>${esc(v)}</strong></div>`).join('')}</div><div class="selectors">${optionControl}<div><label>Quantity<select id="qtySelect">${Array.from({length:maxQty},(_,i)=>i+1).map(q=>`<option value="${q}">${q}</option>`).join('')}</select></label></div></div><div class="actions">${p.realBook?`<button class="secondary" data-action="save-reading" data-id="${esc(p.id)}">📚 Reading List</button><button class="secondary" data-action="amazon-book">↗ View on Amazon</button>`:''}<button class="secondary" data-action="open-gift-modal" data-id="${esc(p.id)}">🎁 Gift idea</button><button class="secondary" data-action="toggle-wish" data-id="${esc(p.id)}">${state.wishlist.includes(p.id)?'♥ Saved':'♡ Save'}</button><button class="primary" data-action="add-cart" data-id="${esc(p.id)}">Add to basket</button></div><section style="margin-top:24px"><div class="section-head" style="margin-bottom:4px"><div><h2 style="font-size:20px">What foragers are saying</h2><p>Fictional reviews · comparison is part of the hunt.</p></div></div>${p.deepReviews.map(r=>`<div class="review-card"><div class="review-head"><strong>${esc(r.title)}</strong><span>${forageStars(r.stars)}</span></div><div><strong>${esc(r.name)}</strong> <span class="verified">✓ Verified fictional purchase</span></div><p>${esc(r.text)}</p></div>`).join('')}</section></div></div>`}
function renderWishlist(){const items=state.wishlist.map(id=>PRODUCTS.find(p=>p.id===id)).filter(Boolean);return `<div class="section-head"><div><h2>Wishlist</h2><p>The promising ones you were not ready to commit to.</p></div></div>${items.length?`<div class="grid">${items.map(productCard).join('')}</div>`:`<div class="empty">Nothing saved yet.</div>`}`}
function addressText(a){return [a.recipient,a.line1,a.line2,a.city,a.region,a.postal].filter(Boolean).join(', ')}
function renderCart(){
  const items=state.cart.map((line,i)=>({line,p:PRODUCTS.find(p=>p.id===line.id),i})).filter(x=>x.p),total=items.reduce((s,x)=>s+optionPrice(x.p,x.line.option)*x.line.qty,0);
  const methods=state.profile.paymentMethods||[];
  return `<div class="section-head"><div><h2>Your basket</h2><p>The point where interesting becomes mine.</p></div></div>
  ${items.length?items.map(({p,line,i})=>`<div class="cartline"><div class="miniart">${p.emoji}</div><div><strong>${esc(p.name)}</strong><div class="eyebrow">${esc(p.cat)}${line.option?` · ${esc(line.option)}`:''} · Qty ${line.qty}</div></div><div style="text-align:right"><strong>${money(optionPrice(p,line.option)*line.qty)}</strong><br><button class="danger" data-action="remove-cart" data-index="${i}">Remove</button></div></div>`).join(''):`<div class="empty">Your basket is empty.</div>`}
  ${items.length?`<div class="summary">
    <div class="summary-row"><span>Merchandise</span><strong>${money(total)}</strong></div>
    <div class="summary-row"><span>Shipping</span><strong>Ƶ 0</strong></div>
    <div class="summary-row total"><span>Total</span><span>${money(total)}</span></div>
    <div class="checkout-box">
      <div><label>Delivery speed<select id="ship"><option value="standard">Standard · arrives ${deliveryDate(3)}</option><option value="express">Express · arrives ${deliveryDate(1)}</option><option value="slow">Slow & scenic · arrives ${deliveryDate(5)}</option></select></label></div>
      <div><label>Payment method<select id="payMethod">${methods.map(m=>`<option value="${esc(m.id)}" ${m.default?'selected':''}>${esc(m.brand)} •••• ${esc(m.last4)} · ${esc(m.label)}</option>`).join('')}</select></label></div>
    </div>
    <div class="gift-box">
      <label class="checkrow"><input type="checkbox" id="giftToggle" data-action="toggle-gift"> Send as a gift</label>
      <div id="shipFields">
        <div class="form-grid">
          <label class="full">Recipient<input id="shipRecipient" value="${esc(state.profile.defaultAddress.recipient)}"></label>
          <label class="full">Address<input id="shipLine1" value="${esc(state.profile.defaultAddress.line1)}"></label>
          <label class="full">Address line 2<input id="shipLine2" value="${esc(state.profile.defaultAddress.line2)}"></label>
          <label>City<input id="shipCity" value="${esc(state.profile.defaultAddress.city)}"></label>
          <label>State / region<input id="shipRegion" value="${esc(state.profile.defaultAddress.region)}"></label>
          <label>ZIP / postal<input id="shipPostal" value="${esc(state.profile.defaultAddress.postal)}"></label>
          <label class="full" id="giftMessageWrap" style="display:none">Gift message<textarea id="giftMessage" placeholder="A little note for the recipient"></textarea></label>
        </div>
      </div>
    </div>
    <button class="primary" style="width:100%;padding:14px" data-action="checkout">Place order</button>
  </div>`:''}`;
}
function toggleGift(){
  const on=document.getElementById('giftToggle')?.checked;
  const msg=document.getElementById('giftMessageWrap'); if(msg)msg.style.display=on?'block':'none';
  if(on){document.getElementById('shipRecipient').value='';document.getElementById('shipLine1').value='';document.getElementById('shipLine2').value='';document.getElementById('shipCity').value='';document.getElementById('shipRegion').value='';document.getElementById('shipPostal').value='';}
  else{
    const a=state.profile.defaultAddress;
    document.getElementById('shipRecipient').value=a.recipient||'';
    document.getElementById('shipLine1').value=a.line1||'';
    document.getElementById('shipLine2').value=a.line2||'';
    document.getElementById('shipCity').value=a.city||'';
    document.getElementById('shipRegion').value=a.region||'';
    document.getElementById('shipPostal').value=a.postal||'';
  }
}
function checkout(){
  if(reconcileTimeState())save();
  const validLines=state.cart.filter(line=>PRODUCTS.some(p=>p.id===line.id));
  const total=validLines.reduce((s,line)=>{const p=PRODUCTS.find(p=>p.id===line.id);return s+optionPrice(p,line.option)*line.qty;},0);
  if(!validLines.length)return;
  if(total>state.balance){toast('Not enough forage funds');return}
  const ship=document.getElementById('ship').value,days=ship==='express'?1:ship==='slow'?5:3;
  const shippingAddress={
    recipient:document.getElementById('shipRecipient')?.value.trim()||'',
    line1:document.getElementById('shipLine1')?.value.trim()||'',
    line2:document.getElementById('shipLine2')?.value.trim()||'',
    city:document.getElementById('shipCity')?.value.trim()||'',
    region:document.getElementById('shipRegion')?.value.trim()||'',
    postal:document.getElementById('shipPostal')?.value.trim()||''
  };
  if(!shippingAddress.recipient||!shippingAddress.line1||!shippingAddress.city){toast('Add a delivery name and address');return}
  const gift=!!document.getElementById('giftToggle')?.checked;
  const paymentId=document.getElementById('payMethod')?.value||null;
  const deliveryTarget=addDays(new Date(),days);
  const order={id:'FG-'+Math.random().toString(36).slice(2,8).toUpperCase(),items:[...validLines],total,placed:new Date().toISOString(),delivery:formatDeliveryDate(deliveryTarget),deliveryAt:deliveryTarget.toISOString(),status:'Processing',shippingAddress,gift,giftMessage:gift?(document.getElementById('giftMessage')?.value||''):'' ,paymentId};
  state.balance-=total;state.spent+=total;state.monthlySpent+=total;state.purchases+=validLines.reduce((s,x)=>s+x.qty,0);state.orders.unshift(order);state.cart=[];save();page='orders';render();toast('Order placed ✦');
}
function orderDateLabel(o){
  const target=new Date(o.deliveryAt);
  const dateText=esc(!isNaN(target)?formatDeliveryDate(target):o.delivery);
  return o.status==='Delivered'?`Delivered ${dateText}`:`Estimated ${dateText}`;
}
function renderOrders(){return `<div class="section-head"><div><h2>Orders</h2><p>The anticipation shelf.</p></div></div>${state.orders.length?state.orders.map(o=>`<div class="order"><div class="miniart">📦</div><div><strong>${esc(o.id)}</strong><div style="color:var(--muted);margin-top:4px">${o.items.map(line=>{const p=PRODUCTS.find(p=>p.id===line.id);return p?`${esc(p.name)}${line.option?` (${esc(line.option)})`:''} ×${line.qty}`:''}).filter(Boolean).join(', ')}</div><div class="eyebrow" style="margin-top:7px">${esc(o.status)} · ${orderDateLabel(o)}</div></div><strong>${money(o.total)}</strong></div>`).join(''):`<div class="empty">No orders yet.</div>`}`}

function saveProfile(){
  state.profile.displayName=document.getElementById('profileName').value.trim()||'Forager';
  state.profile.defaultAddress={
    label:'Home base',
    recipient:document.getElementById('profileRecipient').value.trim(),
    line1:document.getElementById('profileLine1').value.trim(),
    line2:document.getElementById('profileLine2').value.trim(),
    city:document.getElementById('profileCity').value.trim(),
    region:document.getElementById('profileRegion').value.trim(),
    postal:document.getElementById('profilePostal').value.trim()
  };
  save();toast('Profile saved');
}
function addPaymentMethod(){
  const label=document.getElementById('cardLabel').value.trim();
  const brand=document.getElementById('cardBrand').value;
  const last4=document.getElementById('cardLast4').value.replace(/\D/g,'').slice(-4);
  if(!label||last4.length!==4){toast('Use a nickname and four fictional digits');return}
  state.profile.paymentMethods.push({id:'pm'+Date.now(),brand,label,last4,default:state.profile.paymentMethods.length===0});
  save();render();toast('Fictional card added');
}
function setDefaultPayment(id){
  state.profile.paymentMethods.forEach(m=>m.default=m.id===id);save();render();toast('Default card changed');
}
function removePayment(id){
  state.profile.paymentMethods=state.profile.paymentMethods.filter(m=>m.id!==id);
  if(state.profile.paymentMethods.length&&!state.profile.paymentMethods.some(m=>m.default))state.profile.paymentMethods[0].default=true;
  save();render();
}
function renderProfile(){
  const a=state.profile.defaultAddress,m=state.profile.paymentMethods||[];
  return `<div class="section-head"><div><h2>Profile</h2><p>Your fictional shopper identity, delivery settings, and wallet.</p></div></div>
  <div class="profile-grid">
    <div class="panel"><h3>Shopper profile</h3><div class="form-grid">
      <label class="full">Display name<input id="profileName" value="${esc(state.profile.displayName)}"></label>
      <label class="full">Recipient name<input id="profileRecipient" value="${esc(a.recipient)}"></label>
      <label class="full">Default address<input id="profileLine1" value="${esc(a.line1)}"></label>
      <label class="full">Address line 2<input id="profileLine2" value="${esc(a.line2)}"></label>
      <label>City<input id="profileCity" value="${esc(a.city)}"></label>
      <label>State / region<input id="profileRegion" value="${esc(a.region)}"></label>
      <label>ZIP / postal<input id="profilePostal" value="${esc(a.postal)}"></label>
      <div class="full"><button class="primary" data-action="save-profile">Save profile</button></div>
    </div></div>
    <div class="panel"><h3>Fictional wallet</h3><p style="color:var(--muted);margin-top:0">These are pretend payment methods. Do not enter real card numbers.</p>
      ${m.map(x=>`<div class="saved-row"><div><strong>${esc(x.brand)} •••• ${esc(x.last4)}</strong><small>${esc(x.label)}${x.default?' · Default':''}</small></div><div class="actions">${!x.default?`<button class="secondary" data-action="set-default-payment" data-id="${esc(x.id)}">Make default</button>`:''}<button class="danger" data-action="remove-payment" data-id="${esc(x.id)}">Remove</button></div></div>`).join('')}
      <div class="form-grid" style="margin-top:14px">
        <label>Brand<select id="cardBrand"><option>Visa</option><option>Mastercard</option><option>Amex</option><option>Discover</option></select></label>
        <label>Nickname<input id="cardLabel" placeholder="Adventure card"></label>
        <label>Last four fictional digits<input id="cardLast4" inputmode="numeric" maxlength="4" placeholder="1234"></label>
        <div style="align-self:end"><button class="secondary" data-action="add-payment-method">Add card</button></div>
      </div>
    </div>
  </div>`;
}

function renderStats(){return `<div class="section-head"><div><h2>Forage stats</h2><p>Quietly tracking your fictional collecting habits.</p></div></div><div class="statgrid"><div class="stat"><span class="eyebrow">Available</span><strong>${money(state.balance)}</strong>Current forage fund</div><div class="stat"><span class="eyebrow">Acquired</span><strong>${state.purchases}</strong>Items purchased</div><div class="stat"><span class="eyebrow">Spent</span><strong>${money(state.spent)}</strong>Lifetime fictional currency</div><div class="stat"><span class="eyebrow">Market</span><strong>${PRODUCTS.length.toLocaleString()}</strong>Unique finds</div></div><div class="summary"><h3 style="margin-top:0">Monthly reset</h3><p style="color:var(--muted)">Your forage fund refreshes automatically to Ƶ 2,000 on the first of each month — no rollover, no manual reset. See the Forage Fund panel for the exact next date.</p></div>`}

function goHome(){
  selected=null;
  page='shop';
  state.filter='All';
  state.query='';
  state.pageNo=1;
  save();
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}


function render(){
 renderHeader();
 const m=document.getElementById('main');
 try{
  if(page==='shop'){m.innerHTML=renderShop();renderShopInto()}
  else if(page==='detail')m.innerHTML=renderDetail();
  else if(page==='wishlist')m.innerHTML=renderWishlist();
  else if(page==='cart')m.innerHTML=renderCart();
  else if(page==='orders')m.innerHTML=renderOrders();
  else if(page==='reading')m.innerHTML=renderReading();
  else if(page==='gifts')m.innerHTML=renderGifts();
  else if(page==='profile')m.innerHTML=renderProfile();
  else if(page==='stats')m.innerHTML=renderStats();
 }catch(err){
  console.error('Forage render error',page,err);
  m.innerHTML=`<div class="empty"><strong>Forage hit a snag.</strong><br>${esc(err.message)}<br><button class="secondary" data-action="go-home">Return home</button></div>`;
 }
}
const CLICK_ACTIONS={
  'go':(el)=>go(el.dataset.page),
  'go-home':()=>goHome(),
  'open-product':(el)=>openProduct(el.dataset.id),
  'toggle-wish':(el)=>toggleWish(el.dataset.id),
  'add-cart':(el)=>addCart(el.dataset.id),
  'remove-cart':(el)=>removeCart(Number(el.dataset.index)),
  'checkout':()=>checkout(),
  'page-prev':()=>{state.pageNo--;save();renderProductResults();window.scrollTo({top:430,behavior:'smooth'})},
  'page-next':()=>{state.pageNo++;save();renderProductResults();window.scrollTo({top:430,behavior:'smooth'})},
  'show-size-guide':()=>showSizeGuide(selected),
  'toggle-fund':(el,e)=>toggleFund(e),
  'toggle-friend':(el,e)=>toggleFriend(e),
  'friend-start-wander':()=>friendStartWander(),
  'friend-next':()=>friendNext(),
  'friend-dismiss':()=>closeFriend(),
  'friend-open-suggestion':(el)=>friendOpenSuggestion(el.dataset.id),
  'close-size-modal':()=>document.getElementById('sizeModal')?.remove(),
  'close-modal-backdrop':(el,e)=>{if(e.target!==el)return;if(el.id==='giftModal')closeGiftModal();else el.remove()},
  'save-reading':(el)=>saveReading(el.dataset.id),
  'open-gift-modal':(el)=>openGiftModal(el.dataset.id),
  'close-gift-modal':()=>closeGiftModal(),
  'confirm-gift-modal':(el)=>confirmGiftModal(el.dataset.id),
  'amazon-book':(el)=>amazonBook(el.dataset.id?PRODUCTS.find(p=>p.id===el.dataset.id):selected),
  'remove-reading':(el)=>{state.readingList.splice(Number(el.dataset.index),1);save();render()},
  'remove-gift':(el)=>{const idx=Number(el.dataset.index);openGiftEdits.delete(state.giftIdeas[idx]?.id);state.giftIdeas.splice(idx,1);save();render()},
  'gift-edit-toggle':(el)=>{const id=el.dataset.id;if(openGiftEdits.has(id))openGiftEdits.delete(id);else openGiftEdits.add(id);render()},
  'save-profile':()=>saveProfile(),
  'add-payment-method':()=>addPaymentMethod(),
  'set-default-payment':(el)=>setDefaultPayment(el.dataset.id),
  'remove-payment':(el)=>removePayment(el.dataset.id)
};
const CHANGE_ACTIONS={
  'toggle-gift':()=>toggleGift(),
  'option-change':()=>{
    if(!selected)return;
    const el=document.getElementById('detailPrice');
    if(!el)return;
    el.innerHTML=`${money(optionPrice(selected,selectedOption(selected)))}${selected.oldPrice?`<span class="old">${money(selected.oldPrice)}</span>`:''}`;
  },
  'reading-status':(el)=>{
    state.readingList[Number(el.dataset.index)].status=el.value;save();
    const card=el.closest('.cartline');if(card)card.style.opacity=el.value==='Read'?'.6':'';
  },
  'gift-status':(el)=>{
    state.giftIdeas[Number(el.dataset.index)].status=el.value;save();
    const card=el.closest('.cartline');if(card)card.style.opacity=el.value==='Given'?'.6':'';
  },
  'gift-recipient':(el)=>{
    const idx=Number(el.dataset.index);state.giftIdeas[idx].person=el.value;save();
    const eyebrow=el.closest('.cartline')?.querySelector('.eyebrow');if(eyebrow)eyebrow.textContent=giftSummary(state.giftIdeas[idx]);
  },
  'gift-occasion':(el)=>{
    const idx=Number(el.dataset.index);state.giftIdeas[idx].occasion=el.value;save();
    const eyebrow=el.closest('.cartline')?.querySelector('.eyebrow');if(eyebrow)eyebrow.textContent=giftSummary(state.giftIdeas[idx]);
  },
  'gift-note':(el)=>{state.giftIdeas[Number(el.dataset.index)].note=el.value;save()}
};
document.addEventListener('click',e=>{
  // Captured before dispatch: a handler below may replace the panel's own
  // innerHTML (e.g. renderFriendPanel()), detaching e.target from the live
  // DOM mid-event. closest() on a detached node can no longer find these
  // ancestors, so re-checking e.target after dispatch would wrongly treat an
  // in-panel click as "outside" and close the panel it just opened.
  const insideFund=!!e.target.closest('.fund-wrap');
  const insideFriend=!!e.target.closest('.friend-wrap');
  const el=e.target.closest('[data-action]');
  if(el){
    const handler=CLICK_ACTIONS[el.dataset.action];
    if(handler)handler(el,e);
  }
  if(!insideFund)closeFund();
  if(!insideFriend)closeFriend();
});
document.addEventListener('change',e=>{
  const el=e.target.closest('[data-action]');
  if(!el)return;
  const handler=CHANGE_ACTIONS[el.dataset.action];
  if(handler)handler(el,e);
});
function focusableIn(container){
  return [...container.querySelectorAll('button, input, select, textarea, a[href]')].filter(el=>!el.disabled&&el.offsetParent!==null);
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!document.getElementById('fundPanel')?.hidden){closeFund();return}
  if(e.key==='Escape'&&!document.getElementById('friendPanel')?.hidden){closeFriend();return}
  const modal=document.querySelector('.modalback');
  if(!modal)return;
  if(e.key==='Escape'){
    e.preventDefault();
    if(modal.id==='giftModal')closeGiftModal();else modal.remove();
    return;
  }
  if(e.key==='Tab'){
    const focusable=focusableIn(modal.querySelector('.modal')||modal);
    if(!focusable.length)return;
    const first=focusable[0],last=focusable[focusable.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }
});
// Pages with uncommitted form input that a full render() would silently
// discard by rebuilding the DOM from `state` before the visitor has saved
// their edits: the Cart page's checkout form (shipping fields aren't
// written to `state` until checkout() runs) and the Profile page's own
// form (saveProfile() is likewise only called on an explicit click).
const RECONCILE_UNSAFE_PAGES=new Set(['cart','profile']);
// Reconciliation when Forage returns to the foreground (tab switch, app
// switcher, PWA resume). reconcileTimeState() is idempotent, so calling it
// here is always safe - but acting on its result is only worth doing when
// it actually changed something. If nothing changed, there's nothing new
// to show, so we skip touching the DOM entirely rather than re-rendering
// for no reason. When something did change, a full render() rebuilds the
// current page's DOM from scratch, which is exactly what we must NOT do
// on a page with unsaved form input (see RECONCILE_UNSAFE_PAGES above) -
// there, only the header/fund panel are refreshed, never the form itself.
function handleForegroundReconcile(){
  const changed=reconcileTimeState();
  if(!changed)return;
  save();
  if(RECONCILE_UNSAFE_PAGES.has(page))renderHeader();
  else render();
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')handleForegroundReconcile()});
window.addEventListener('focus',handleForegroundReconcile);

// Always persist once at startup, not just when a status/fund actually
// changes: sanitizeOrders()/migrateFundState() may have derived data (a
// legacy order's deliveryAt, a freshly-migrated fundMonth/monthlySpent)
// that isn't itself an "overdue order" or "new month" change, and that
// derived data should still be promoted from "recomputed every load" to
// "stored", exactly like a freshly-placed order's deliveryAt already is.
// Placed at the very end of the script, after every top-level let/const
// binding it touches (page, selected, etc. via render()) is initialized.
migrateFundState();
reconcileTimeState();
save();
loadCatalog().then(()=>render()).catch(err=>{document.getElementById('main').innerHTML=`<div class="empty"><strong>Forage couldn't load its catalog.</strong><br>${err.message}</div>`});
