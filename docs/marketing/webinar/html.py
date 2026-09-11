import json
slides = json.load(open("/tmp/claude-0/slides.json"))

HEAD = r"""<title>RxVision — Τα Κυκλώματα</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Commissioner:wght@300;500;700;800&family=Noto+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ink:#0A0E1C; --ink-2:#121935; --line:#26305A;
  --paper:#F2F5FF; --muted:#9AA6CE;
  --accent:#6C63FF; --accent-soft:#A8A2FF; --mint:#2FD9A8;
  --display:"Commissioner",system-ui,sans-serif;
  --body:"Noto Sans",system-ui,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--ink);color:var(--paper);font-family:var(--body);
  overflow:hidden;-webkit-font-smoothing:antialiased;
}
/* ── σκηνή ───────────────────────────────────────────── */
.stage{position:fixed;inset:0;display:grid;grid-template-rows:auto 1fr auto;gap:0}
.bar{height:4px;background:var(--line);position:relative;flex:none}
.bar i{position:absolute;inset:0 auto 0 0;width:0;background:linear-gradient(90deg,var(--accent),var(--accent-soft));
  box-shadow:0 0 18px rgba(108,99,255,.8)}
.bar i.run{animation:fill var(--dur) linear forwards}
@keyframes fill{from{width:0}to{width:100%}}

.body{position:relative;overflow:hidden}
.shot{position:absolute;inset:0;opacity:0;transition:opacity .7s ease}
.shot.on{opacity:1}
.shot img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block;
  transform:scale(1.01);transition:transform 15.6s linear}
.shot.on img{transform:scale(1.055)}
.scrim{position:absolute;inset:0;
  background:linear-gradient(90deg,rgba(10,14,28,.985) 0%,rgba(10,14,28,.96) 38%,rgba(10,14,28,.40) 60%,rgba(10,14,28,.12) 100%),
             linear-gradient(0deg,rgba(10,14,28,.85) 0%,rgba(10,14,28,0) 40%)}

.copy{position:absolute;left:clamp(28px,4.5vw,88px);top:50%;transform:translateY(-50%);
  width:min(43vw,620px);display:flex;flex-direction:column;gap:clamp(10px,1.3vh,20px)}
.eyebrow{font-family:var(--display);font-weight:700;font-size:clamp(11px,1.05vw,15px);
  letter-spacing:.22em;color:var(--accent-soft)}
h1{font-family:var(--display);font-weight:800;margin:0;line-height:1.02;text-wrap:balance;
  font-size:clamp(34px,4.4vw,68px);letter-spacing:-.02em}
.tag{font-family:var(--display);font-weight:500;font-size:clamp(16px,1.75vw,27px);
  color:var(--mint);line-height:1.25;text-wrap:balance}
.lead{font-size:clamp(14px,1.15vw,19px);line-height:1.6;color:var(--muted);max-width:60ch}
ul{list-style:none;margin:clamp(2px,.6vh,10px) 0 0;padding:0;display:flex;flex-direction:column;gap:clamp(6px,.9vh,12px)}
li{display:flex;align-items:flex-start;gap:11px;font-size:clamp(13px,1.05vw,18px);line-height:1.4;color:var(--paper)}
li svg{flex:none;margin-top:.28em;width:1em;height:1em;color:var(--mint)}

/* ── υποσέλιδο ───────────────────────────────────────── */
.foot{display:flex;align-items:center;gap:clamp(14px,2vw,30px);
  padding:clamp(12px,1.6vh,22px) clamp(24px,4vw,80px);
  background:var(--ink);border-top:1px solid var(--line)}
.brand{display:flex;align-items:baseline;gap:10px;font-family:var(--display)}
.brand b{font-weight:800;font-size:clamp(17px,1.5vw,25px);letter-spacing:-.01em}
.brand span{font-weight:500;font-size:clamp(9px,.72vw,12px);letter-spacing:.2em;
  text-transform:uppercase;color:var(--muted)}
.dots{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.dots i{width:7px;height:7px;border-radius:99px;background:var(--line);display:block;transition:.35s}
.dots i.on{background:var(--accent-soft);width:22px}
.count{font-family:var(--display);font-weight:700;font-variant-numeric:tabular-nums;
  font-size:clamp(12px,1vw,16px);color:var(--muted);letter-spacing:.04em}
.hint{font-size:clamp(10px,.8vw,13px);color:var(--muted);opacity:.75}

@media (max-aspect-ratio:1/1){
  .copy{width:auto;right:clamp(28px,5vw,60px);top:auto;bottom:4vh;transform:none}
  .scrim{background:linear-gradient(0deg,rgba(10,14,28,.97) 0%,rgba(10,14,28,.9) 46%,rgba(10,14,28,.2) 100%)}
  .shot img{object-position:top center}
}
@media (prefers-reduced-motion:reduce){
  .shot img,.shot.on img{transform:none;transition:none}
  .bar i.run{animation:none;width:100%}
}
</style>"""

BODY = r"""<div class="stage">
  <div class="bar"><i id="prog"></i></div>
  <div class="body" id="body"></div>
  <div class="foot">
    <div class="brand"><b>RxVision</b><span>Pharmacy Analytics</span></div>
    <div class="hint">Ξεκινάμε σε λίγο — καλώς ήρθατε 👋</div>
    <div class="count" id="count"></div>
    <div class="dots" id="dots"></div>
  </div>
</div>
<script>
const SLIDES = __DATA__;
const DUR = 15000;
const TICK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';
const body = document.getElementById('body'), dots = document.getElementById('dots'),
      prog = document.getElementById('prog'), count = document.getElementById('count');
document.documentElement.style.setProperty('--dur', DUR + 'ms');

SLIDES.forEach((s, i) => {
  const el = document.createElement('div');
  el.className = 'shot';
  el.innerHTML =
    '<img src="data:image/jpeg;base64,' + s.img + '" alt="' + s.title + '">' +
    '<div class="scrim"></div>' +
    '<div class="copy">' +
      '<div class="eyebrow">ΚΥΚΛΩΜΑ</div>' +
      '<h1>' + s.title + '</h1>' +
      '<div class="tag">' + s.tag + '</div>' +
      '<p class="lead">' + s.lead + '</p>' +
      '<ul>' + s.bullets.map(b => '<li>' + TICK + '<span>' + b + '</span></li>').join('') + '</ul>' +
    '</div>';
  body.appendChild(el);
  const d = document.createElement('i');
  dots.appendChild(d);
});

const shots = [...body.children], pips = [...dots.children];
let i = -1;
function show(n){
  if (i >= 0) { shots[i].classList.remove('on'); pips[i].classList.remove('on'); }
  i = n;
  shots[i].classList.add('on'); pips[i].classList.add('on');
  count.textContent = (i + 1) + ' / ' + SLIDES.length;
  prog.classList.remove('run'); void prog.offsetWidth; prog.classList.add('run');
}
show(0);
setInterval(() => show((i + 1) % SLIDES.length), DUR);
// Πλήκτρα για χειροκίνητο έλεγχο αν χρειαστεί (δεξί/αριστερό βέλος)
addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') show((i + 1) % SLIDES.length);
  if (e.key === 'ArrowLeft') show((i - 1 + SLIDES.length) % SLIDES.length);
});
</script>"""

html = HEAD + "\n" + BODY.replace("__DATA__", json.dumps(slides, ensure_ascii=False))
open("/opt/rxvision/docs/marketing/webinar/rxvision-loop.html", "w").write(html)
print("γράφτηκε")
