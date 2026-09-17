let PRODUCTS=[];
const CATS=["All", "Moto", "Pottery", "Craft", "Korea", "Music", "Style", "Home", "Kitchen", "Travel", "Adventure", "Cats", 'Books','Stationery & Paper','Gifts & Curiosities'];
async function loadCatalog(){const r=await fetch('catalog.json',{cache:'no-store'});if(!r.ok)throw new Error('catalog.json could not be loaded');PRODUCTS=await r.json();}
function forageStars(n){return'★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n))}
function forageStock(p){if(p.stock<=3)return`Only ${p.stock} left today`;if(p.limited)return`Limited batch · ${p.stock} available`;if(p.stock<=8)return`${p.stock} available`;return'In stock'}
function photo(p,big=false){const src=p.image||null;if(src)return `<div class="photo real-photo ${big?'big':''}"><img src="${esc(src)}" alt="${esc(p.name)}" loading="lazy"></div>`;const rr=((p.seed%9)-4)*1.7;return `<div class="photo" style="--r:${rr}deg"><div class="product-object" style="font-size:${big?110:66}px">${p.emoji}</div><div class="photo-label">Photo coming to Forage · ${esc(p.cat)}</div></div>`}
const DEFAULT_STATE={balance:2000,cart:[],wishlist:[],orders:[],purchases:0,spent:0,filter:'All',query:'',sort:'daily',pageNo:1,readingList:[],giftIdeas:[]};
const VALID_SORTS=['daily','rating','low','high'];
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
function sanitizeOrders(raw){return Array.isArray(raw)?raw.filter(o=>o&&typeof o==='object').map(o=>({...o,items:Array.isArray(o.items)?o.items:[]})):[]}
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
function money(n){return 'Ƶ '+Number(n).toLocaleString()}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1700)}
function deliveryDate(days=3){const d=new Date();d.setDate(d.getDate()+days);return d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}
function daySeed(){const d=new Date();return Number(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`)}
function dailyScore(p){return ((p.seed*9301+daySeed()*49297)%233280)/233280}
function renderHeader(){
  document.getElementById('balanceBox').textContent=money(state.balance);
  const items=[['shop','Discover'],['cart','Cart'],['orders','Orders'],['stats','Stats'],['gifts','🎁 Gift Cabinet'],['wishlist','Wishlist'],['reading','📚 Reading List'],['profile','Profile']];
  document.getElementById('nav').innerHTML=items.map(([id,label])=>`<button class="${page===id?'active':''} ${id==='gifts'?'nav-spacer':''}" data-action="go" data-page="${id}">${label}${id==='cart'&&state.cart.length?`<span class="badge">${state.cart.reduce((s,x)=>s+x.qty,0)}</span>`:''}</button>`).join('');
}

function go(p){page=p;selected=null;render();window.scrollTo({top:0,behavior:'smooth'})}

function productCard(p){const wished=state.wishlist.includes(p.id);return `<article class="card" data-action="open-product" data-id="${esc(p.id)}"><div class="art">${photo(p)}<div class="art-label">${esc(p.cat)}</div><button class="heart ${wished?'on':''}" data-action="toggle-wish" data-id="${esc(p.id)}">${wished?'♥':'♡'}</button></div><div class="cardbody"><div><span class="discovery-badge">${esc(p.marketBadge)}</span>${p.limited?'<span class="discovery-badge">Limited</span>':''}</div><h3>${esc(p.name)}</h3><div class="rating">${forageStars(p.rating)} ${p.rating.toFixed(1)} · ${p.reviews.toLocaleString()} reviews</div><p>${esc(p.desc)}</p><div class="stockline">${forageStock(p)}</div><div class="actions" style="margin-top:10px"><button class="secondary" data-action="open-product" data-id="${esc(p.id)}">Details →</button></div><div class="price">${money(p.price)} ${p.oldPrice?`<span class="old">${money(p.oldPrice)}</span>`:''}</div></div></article>`}
function toggleWish(id){const i=state.wishlist.indexOf(id);if(i>=0){state.wishlist.splice(i,1);toast('Removed from wishlist')}else{state.wishlist.push(id);toast('Saved for later')}save();render()}
function viewProduct(id){selected=PRODUCTS.find(p=>p.id===id);page='detail';render();window.scrollTo({top:0,behavior:'smooth'})}
function selectedOption(p){if(p.sizes?.length)return document.getElementById('sizeSelect')?.value||p.sizes[0];if(p.variants?.length)return document.getElementById('variantSelect')?.value||p.variants[0];return null}
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
  return `<section class="hero"><div><div class="eyebrow" style="color:#e7efe9">Morning expedition</div><h1>Find something worth hunting for.</h1><p>One thousand fictional objects. Search, compare, inspect reviews, choose variants, and buy only what wins.</p></div><div class="hero-card"><strong>Today’s forage fund</strong><div style="font-size:38px;font-weight:900;margin:8px 0">${money(state.balance)}</div><div style="opacity:.85">Today’s Finds rotate every morning.</div></div></section><div id="shopArea"></div>`;
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
 const q=encodeURIComponent(`${p.name} ${p.author||''}`);
 window.open(`https://www.amazon.com/s?k=${q}`,'_blank','noopener,noreferrer');
}

function saveReading(id){
 const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
 state.readingList=state.readingList||[];
 if(state.readingList.some(x=>x.id===id)){toast("Already in Reading List");return;}
 state.readingList.unshift({id,name:p.name,format:(p.formats||["Any"])[0],formats:p.formats||["Any"],status:"Want to Read"});
 save();toast("Saved to Reading List");
}
function saveGiftIdea(id){
 const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
 state.giftIdeas=state.giftIdeas||[];
 if(state.giftIdeas.some(x=>x.id===id)){toast("Already in Gift Cabinet");return;}
 state.giftIdeas.unshift({id,name:p.name,person:'',occasion:'',note:'',status:'Idea'});
 save();toast("Saved to Gift Cabinet");
}
function normalizeReadingList(){
  if(!Array.isArray(state.readingList))state.readingList=[];
  state.readingList=state.readingList.map(x=>{
    if(typeof x==='string'){
      const p=PRODUCTS.find(p=>p.id===x);
      return p?{id:p.id,name:p.name,format:(p.formats||['Any'])[0],formats:p.formats||['Any'],status:'Want to Read'}:null;
    }
    if(!x||typeof x!=='object')return null;
    const p=PRODUCTS.find(p=>p.id===x.id);
    const formats=Array.isArray(x.formats)&&x.formats.length?x.formats:(p?.formats||['Any']);
    return {id:x.id||p?.id||'',name:x.name||p?.name||'Untitled book',format:x.format||formats[0]||'Any',formats,status:x.status||'Want to Read'};
  }).filter(Boolean);
}
function renderReading(){
 normalizeReadingList();
 const xs=state.readingList;
 return `<div class="section-head"><div><h2>📚 Reading List</h2><p>Books worth keeping within reach.</p></div></div>${xs.length?xs.map((x,i)=>`<div class="cartline"><div class="miniart">📚</div><div><strong>${esc(x.name)}</strong><div class="eyebrow">${esc(x.status)} · ${esc(x.format)}</div></div><div><select data-action="reading-format" data-index="${i}">${x.formats.map(f=>`<option ${x.format===f?'selected':''}>${esc(f)}</option>`).join('')}</select><select data-action="reading-status" data-index="${i}"><option ${x.status==='Want to Read'?'selected':''}>Want to Read</option><option ${x.status==='Already Own'?'selected':''}>Already Own</option><option ${x.status==='Know & Love'?'selected':''}>Know & Love</option><option ${x.status==='Used Regularly'?'selected':''}>Used Regularly</option><option ${x.status==='Fictionally Purchased'?'selected':''}>Fictionally Purchased</option><option ${x.status==='Read'?'selected':''}>Read</option></select><button class="danger" data-action="remove-reading" data-index="${i}">Remove</button></div></div>`).join(''):`<div class="empty">No books saved yet. The shelves are waiting.</div>`}`;
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
  if(x.person)parts.push(`For ${esc(x.person)}`);
  if(x.occasion)parts.push(esc(x.occasion));
  return parts.length?parts.join(' · '):'No details yet — add them below';
}
function renderGifts(){
 normalizeGiftIdeas();
 const xs=state.giftIdeas||[];
 return `<div class="section-head"><div><h2>🎁 Gift Cabinet</h2><p>Things that made you think of someone.</p></div></div>${xs.length?xs.map((x,i)=>{
   const editing=openGiftEdits.has(x.id);
   return `<div class="cartline"${x.status==='Given'?' style="opacity:.6"':''}><div class="miniart">🎁</div><div><strong>${esc(x.name)}</strong><div class="eyebrow">${giftSummary(x)}</div>${!editing&&x.note?`<p>${esc(x.note)}</p>`:''}<button class="size-link" data-action="gift-edit-toggle" data-id="${esc(x.id)}">${editing?'Hide details':'Edit details →'}</button>${editing?`<div class="form-grid" style="margin-top:8px"><label class="full">Recipient<input value="${esc(x.person)}" placeholder="Who's it for?" data-action="gift-recipient" data-index="${i}"></label><label class="full">Occasion<input value="${esc(x.occasion)}" placeholder="Birthday, just because…" data-action="gift-occasion" data-index="${i}"></label><label class="full">Notes<textarea placeholder="Why you saved this" data-action="gift-note" data-index="${i}">${esc(x.note)}</textarea></label></div>`:''}</div><div><select data-action="gift-status" data-index="${i}">${GIFT_STATUSES.map(s=>`<option ${x.status===s?'selected':''}>${s}</option>`).join('')}</select><button class="danger" data-action="remove-gift" data-index="${i}">Remove</button></div></div>`;
 }).join(''):`<div class="empty">No gift ideas yet.</div>`}`;
}
function renderDetail(){const p=selected;if(!p)return'';const optionControl=p.sizes?.length?`<div><label>Size<select id="sizeSelect">${p.sizes.map(s=>`<option>${esc(s)}</option>`).join('')}</select></label><button class="size-link" data-action="show-size-guide">Size guide →</button></div>`:p.variants?.length?`<div><label>Variant<select id="variantSelect">${p.variants.map(s=>`<option>${esc(s)}</option>`).join('')}</select></label></div>`:'';const maxQty=Math.max(1,Math.min(5,p.stock));return `<button class="secondary" data-action="go" data-page="shop" style="margin-bottom:14px">← Back to hunting</button><div class="detail">${photo(p,true)}<div><div class="eyebrow">${esc(displayCat(p))}${p.rarity?` · ${esc(p.rarity)}`:''}</div><div><span class="discovery-badge">${esc(p.marketBadge)}</span>${p.limited?'<span class="discovery-badge">Limited batch</span>':''}</div><h1>${esc(p.name)}</h1>${p.realBook?`<p class="sub"><strong>${esc(p.author)}</strong> · ${esc(p.bookTopic)}</p>`:''}<div style="font-size:26px;font-weight:900">${money(p.price)}${p.oldPrice?`<span class="old">${money(p.oldPrice)}</span>`:''}</div><div class="rating" style="margin-top:6px">${forageStars(p.rating)} ${p.rating.toFixed(1)} · ${p.reviews.toLocaleString()} ratings</div><div class="stockline">${forageStock(p)}</div><p>${esc(p.desc)}</p>${fieldNotes(p)}<div class="specs">${Object.entries(p.specs).map(([k,v])=>`<div class="spec"><div class="eyebrow">${esc(k)}</div><strong>${esc(v)}</strong></div>`).join('')}</div><div class="selectors">${optionControl}<div><label>Quantity<select id="qtySelect">${Array.from({length:maxQty},(_,i)=>i+1).map(q=>`<option value="${q}">${q}</option>`).join('')}</select></label></div></div><div class="actions">${p.realBook?`<button class="secondary" data-action="save-reading" data-id="${esc(p.id)}">📚 Reading List</button><button class="secondary" data-action="amazon-book">↗ View on Amazon</button>`:''}<button class="secondary" data-action="save-gift-idea" data-id="${esc(p.id)}">🎁 Gift idea</button><button class="secondary" data-action="toggle-wish" data-id="${esc(p.id)}">${state.wishlist.includes(p.id)?'♥ Saved':'♡ Save'}</button><button class="primary" data-action="add-cart" data-id="${esc(p.id)}">Add to basket</button></div><section style="margin-top:24px"><div class="section-head" style="margin-bottom:4px"><div><h2 style="font-size:20px">What foragers are saying</h2><p>Fictional reviews · comparison is part of the hunt.</p></div></div>${p.deepReviews.map(r=>`<div class="review-card"><div class="review-head"><strong>${esc(r.title)}</strong><span>${forageStars(r.stars)}</span></div><div><strong>${esc(r.name)}</strong> <span class="verified">✓ Verified fictional purchase</span></div><p>${esc(r.text)}</p></div>`).join('')}</section></div></div>`}
function renderWishlist(){const items=state.wishlist.map(id=>PRODUCTS.find(p=>p.id===id)).filter(Boolean);return `<div class="section-head"><div><h2>Wishlist</h2><p>The promising ones you were not ready to commit to.</p></div></div>${items.length?`<div class="grid">${items.map(productCard).join('')}</div>`:`<div class="empty">Nothing saved yet.</div>`}`}
function addressText(a){return [a.recipient,a.line1,a.line2,a.city,a.region,a.postal].filter(Boolean).join(', ')}
function renderCart(){
  const items=state.cart.map((line,i)=>({line,p:PRODUCTS.find(p=>p.id===line.id),i})).filter(x=>x.p),total=items.reduce((s,x)=>s+x.p.price*x.line.qty,0);
  const methods=state.profile.paymentMethods||[];
  return `<div class="section-head"><div><h2>Your basket</h2><p>The point where interesting becomes mine.</p></div></div>
  ${items.length?items.map(({p,line,i})=>`<div class="cartline"><div class="miniart">${p.emoji}</div><div><strong>${esc(p.name)}</strong><div class="eyebrow">${esc(p.cat)}${line.option?` · ${esc(line.option)}`:''} · Qty ${line.qty}</div></div><div style="text-align:right"><strong>${money(p.price*line.qty)}</strong><br><button class="danger" data-action="remove-cart" data-index="${i}">Remove</button></div></div>`).join(''):`<div class="empty">Your basket is empty.</div>`}
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
  const validLines=state.cart.filter(line=>PRODUCTS.some(p=>p.id===line.id));
  const total=validLines.reduce((s,line)=>s+PRODUCTS.find(p=>p.id===line.id).price*line.qty,0);
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
  const order={id:'FG-'+Math.random().toString(36).slice(2,8).toUpperCase(),items:[...validLines],total,placed:new Date().toISOString(),delivery:deliveryDate(days),status:'Processing',shippingAddress,gift,giftMessage:gift?(document.getElementById('giftMessage')?.value||''):'' ,paymentId};
  state.balance-=total;state.spent+=total;state.purchases+=validLines.reduce((s,x)=>s+x.qty,0);state.orders.unshift(order);state.cart=[];save();page='orders';render();toast('Order placed ✦');
}
function renderOrders(){return `<div class="section-head"><div><h2>Orders</h2><p>The anticipation shelf.</p></div></div>${state.orders.length?state.orders.map(o=>`<div class="order"><div class="miniart">📦</div><div><strong>${esc(o.id)}</strong><div style="color:var(--muted);margin-top:4px">${o.items.map(line=>{const p=PRODUCTS.find(p=>p.id===line.id);return p?`${esc(p.name)}${line.option?` (${esc(line.option)})`:''} ×${line.qty}`:''}).filter(Boolean).join(', ')}</div><div class="eyebrow" style="margin-top:7px">${esc(o.status)} · Estimated ${esc(o.delivery)}</div></div><strong>${money(o.total)}</strong></div>`).join(''):`<div class="empty">No orders yet.</div>`}`}

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

function resetFunds(){state.balance=2000;save();render();toast('Monthly forage funds refreshed')}
function renderStats(){return `<div class="section-head"><div><h2>Forage stats</h2><p>Quietly tracking your fictional collecting habits.</p></div></div><div class="statgrid"><div class="stat"><span class="eyebrow">Available</span><strong>${money(state.balance)}</strong>Current forage fund</div><div class="stat"><span class="eyebrow">Acquired</span><strong>${state.purchases}</strong>Items purchased</div><div class="stat"><span class="eyebrow">Spent</span><strong>${money(state.spent)}</strong>Fictional currency</div><div class="stat"><span class="eyebrow">Market</span><strong>${PRODUCTS.length.toLocaleString()}</strong>Unique finds</div></div><div class="summary"><h3 style="margin-top:0">Monthly reset</h3><p style="color:var(--muted)">Need a fresh hunt? Refill your imaginary account.</p><button class="secondary" data-action="reset-funds">Refresh to Ƶ 2,000</button></div>`}

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
  'close-size-modal':()=>document.getElementById('sizeModal')?.remove(),
  'close-modal-backdrop':(el,e)=>{if(e.target===el)el.remove()},
  'save-reading':(el)=>saveReading(el.dataset.id),
  'save-gift-idea':(el)=>saveGiftIdea(el.dataset.id),
  'amazon-book':()=>amazonBook(selected),
  'remove-reading':(el)=>{state.readingList.splice(Number(el.dataset.index),1);save();render()},
  'remove-gift':(el)=>{const idx=Number(el.dataset.index);openGiftEdits.delete(state.giftIdeas[idx]?.id);state.giftIdeas.splice(idx,1);save();render()},
  'gift-edit-toggle':(el)=>{const id=el.dataset.id;if(openGiftEdits.has(id))openGiftEdits.delete(id);else openGiftEdits.add(id);render()},
  'save-profile':()=>saveProfile(),
  'add-payment-method':()=>addPaymentMethod(),
  'set-default-payment':(el)=>setDefaultPayment(el.dataset.id),
  'remove-payment':(el)=>removePayment(el.dataset.id),
  'reset-funds':()=>resetFunds()
};
const CHANGE_ACTIONS={
  'toggle-gift':()=>toggleGift(),
  'reading-format':(el)=>{state.readingList[Number(el.dataset.index)].format=el.value;save();render()},
  'reading-status':(el)=>{state.readingList[Number(el.dataset.index)].status=el.value;save();render()},
  'gift-status':(el)=>{state.giftIdeas[Number(el.dataset.index)].status=el.value;save();render()},
  'gift-recipient':(el)=>{state.giftIdeas[Number(el.dataset.index)].person=el.value;save();render()},
  'gift-occasion':(el)=>{state.giftIdeas[Number(el.dataset.index)].occasion=el.value;save();render()},
  'gift-note':(el)=>{state.giftIdeas[Number(el.dataset.index)].note=el.value;save();render()}
};
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-action]');
  if(!el)return;
  const handler=CLICK_ACTIONS[el.dataset.action];
  if(handler)handler(el,e);
});
document.addEventListener('change',e=>{
  const el=e.target.closest('[data-action]');
  if(!el)return;
  const handler=CHANGE_ACTIONS[el.dataset.action];
  if(handler)handler(el,e);
});
loadCatalog().then(()=>render()).catch(err=>{document.getElementById('main').innerHTML=`<div class="empty"><strong>Forage couldn't load its catalog.</strong><br>${err.message}</div>`});
