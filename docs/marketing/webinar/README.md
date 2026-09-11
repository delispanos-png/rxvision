# Webinar — οθόνη αναμονής («Τα Κυκλώματα»)

**Αρχείο:** `rxvision-loop.html` — **αυτοτελές** (οι εικόνες είναι ενσωματωμένες, ~2 MB).
Δεν χρειάζεται internet, server ή τίποτα άλλο.

## Χρήση
1. Διπλό κλικ στο `rxvision-loop.html` (ανοίγει σε οποιονδήποτε browser).
2. **F11** για πλήρη οθόνη.
3. Κάνε κοινή χρήση οθόνης — κυλά μόνο του, **15΄΄ ανά κύκλωμα**, και ξαναρχίζει από την αρχή.

**Βέλη ←/→** για χειροκίνητη εναλλαγή αν χρειαστεί.
17 κυκλώματα × 15΄΄ = **4 λεπτά 15΄΄** ανά πλήρη κύκλο.

## Πώς ξαναφτιάχνεται
Τα στιγμιότυπα είναι **πραγματικά**, από τον demo tenant (`T-C838D2E4`, `demo: true` → τα ονόματα
ασθενών είναι ήδη μασκαρισμένα — **ποτέ** μην τραβήξεις από φαρμακείο πελάτη).

```bash
# 1) token (μέσα στο api container)  → /tmp/tok.txt
# 2) στιγμιότυπα
docker run --rm --network host -v $PWD:/shots -w /shots \
  -e ACCESS=… -e REFRESH=… mcr.microsoft.com/playwright:latest \
  bash -c "npm i playwright@1.46.1 --silent; node shoot.js"
# 3) HTML
python3 build.py > slides.json && python3 html.py
```

`shoot.js` καθαρίζει cookie banner, tooltip PharmaCat και το chip «Χωρίς κάρτα» πριν από κάθε λήψη.
