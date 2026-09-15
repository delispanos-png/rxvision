"""Η ΦΩΝΗ του Συμβούλου — ανθρώπινη γλώσσα, όχι ξερά νούμερα.

Αυτό το module ΔΕΝ αγγίζει τη βάση. Παίρνει ένα «εύρημα» (finding) και το μετατρέπει σε
κουβέντα που θα έλεγε ένας έμπειρος συνάδελφος: τι έγινε, τι κοστίζει, τι να κάνεις τώρα.

Τρεις τόνοι, ανάλογα με το πόσες συνεχόμενες μέρες επαναλαμβάνεται το ΙΔΙΟ λάθος:
  · «ήπιος»    (1η μέρα)   — παρατήρηση
  · «αυστηρός» (2–3 μέρες) — προειδοποίηση
  · «ξύλο»     (4+ μέρες)  — δεν είναι πια αβλεψία, είναι συνήθεια

Και μία τέταρτη φωνή που μετράει εξίσου: η ΕΠΙΒΡΑΒΕΥΣΗ. Ο σύμβουλος που βλέπει μόνο λάθη
τον κλείνεις σε μία εβδομάδα.
"""

from __future__ import annotations


from app.utils.format import eur_gr

# ── τόνοι ────────────────────────────────────────────────────────────────────
TONE_SOFT = "soft"      # 1η φορά
TONE_FIRM = "firm"      # 2–3 μέρες στη σειρά
TONE_HARD = "hard"      # 4+ μέρες — «τρώνε ξύλο»


def tone_for(streak: int) -> str:
    """streak = συνεχόμενες μέρες που το ίδιο θέμα μένει ανοιχτό / επαναλαμβάνεται."""
    s = int(streak or 0)
    if s >= 4:
        return TONE_HARD
    if s >= 2:
        return TONE_FIRM
    return TONE_SOFT


# Το προοίμιο που μπαίνει ΜΠΡΟΣΤΑ από το εύρημα όταν επαναλαμβάνεται.
# ΥΦΟΣ: ο σύμβουλος σοβαρεύει, δεν επιπλήττει. Λέει το γεγονός («τρίτη μέρα ανοιχτό»)
# και αφήνει το βάρος να το κουβαλήσει το ίδιο το γεγονός — αυτό είναι που ενοχλεί σωστά.
_REPEAT_OPENER = {
    TONE_FIRM: [
        "Το είχαμε δει και χθες, και παραμένει ανοιχτό.",
        "Τρίτη μέρα που το βρίσκω ανοιχτό.",
    ],
    TONE_HARD: [
        "Είναι η {n}η συνεχόμενη μέρα που το βρίσκω ανοιχτό.",
        "Το βλέπω {n} μέρες στη σειρά — και θα συνεχίσω να στο θυμίζω.",
        "{n} μέρες τώρα, χωρίς καμία κίνηση.",
    ],
}


def repeat_opener(streak: int) -> str:
    t = tone_for(streak)
    if t == TONE_SOFT:
        return ""
    # ντετερμινιστική επιλογή ανά streak → δεν αλλάζει φράση σε κάθε refresh της σελίδας
    opts = _REPEAT_OPENER[t]
    idx = max(0, int(streak) - 2)
    return opts[idx % len(opts)].format(n=int(streak))


# ── ανθρώπινοι αριθμοί ───────────────────────────────────────────────────────
_WORDS = {1: "ένας", 2: "δύο", 3: "τρεις", 4: "τέσσερις", 5: "πέντε", 6: "έξι",
          7: "εφτά", 8: "οχτώ", 9: "εννιά", 10: "δέκα"}
_WORDS_F = {1: "μία", 2: "δύο", 3: "τρεις", 4: "τέσσερις", 5: "πέντε", 6: "έξι",
            7: "εφτά", 8: "οχτώ", 9: "εννιά", 10: "δέκα"}
_WORDS_N = {1: "ένα", 2: "δύο", 3: "τρία", 4: "τέσσερα", 5: "πέντε", 6: "έξι",
            7: "εφτά", 8: "οχτώ", 9: "εννιά", 10: "δέκα"}


def count_word(n: int, *, feminine: bool = False, neuter: bool = False) -> str:
    """1→«ένας»/«μία»/«ένα», 7→«εφτά», 23→«23». Μικροί αριθμοί με λέξεις = ανθρώπινος λόγος.
    Το γένος μετράει: «τρεις πράγματα» ακούγεται σαν μηχανή, όχι σαν συνάδελφος."""
    tbl = _WORDS_N if neuter else (_WORDS_F if feminine else _WORDS)
    return tbl.get(int(n), str(int(n)))


def people(n: int) -> str:
    n = int(n)
    if n == 1:
        return "ένας άνθρωπος"
    return f"{count_word(n)} άνθρωποι" if n <= 10 else f"{n} άνθρωποι"


def ago_phrase(days: int) -> str:
    """«πότε έγινε» — μπαίνει μετά από ρήμα: «Ήρθε ΠΡΙΝ ΑΠΟ ΤΡΕΙΣ ΜΕΡΕΣ»."""
    d = int(days or 0)
    if d <= 0:
        return "σήμερα"
    if d == 1:
        return "χθες"
    if d == 2:
        return "προχθές"
    if d < 7:
        return f"πριν από {count_word(d, feminine=True)} μέρες"
    if d < 14:
        return "πριν από πάνω από μία εβδομάδα"
    if d < 31:
        return f"πριν από {d} μέρες"
    return "πριν από πάνω από έναν μήνα"


def days_phrase(days: int) -> str:
    d = int(days or 0)
    if d <= 0:
        return "σήμερα"
    if d == 1:
        return "από χθες"
    if d == 2:
        return "δύο μέρες τώρα"
    if d < 7:
        return f"{count_word(d, feminine=True)} μέρες τώρα"
    if d < 14:
        return "πάνω από μία εβδομάδα"
    if d < 31:
        return f"{d} μέρες — σχεδόν έναν μήνα"
    return "πάνω από έναν μήνα"


def money(cents: int | float | None) -> str:
    """Λεπτά → «€128». Χωρίς δεκαδικά: ο σύμβουλος μιλάει, δεν τιμολογεί."""
    return f"€{eur_gr(cents, 0)}"


def first_name(full: str | None) -> str:
    """«ΠΑΠΑΔΟΠΟΥΛΟΥ ΜΑΡΙΑ» → «η ΜΑΡΙΑ». Μιλάμε για ανθρώπους με το όνομά τους."""
    s = (full or "").strip()
    if not s:
        return "ο πελάτης"
    parts = [p for p in s.split() if p]
    return parts[-1] if len(parts) > 1 else parts[0]


# ── γένος: ο σύμβουλος δεν λέει «ΚΩΝΣΤΑΝΤΙΝΟΣ… της μένουν» ───────────────────
def g(sex: str | None, masc: str, fem: str) -> str:
    """Διάλεξε τύπο ανάλογα με το φύλο· άγνωστο φύλο → αρσενικό (ουδέτερη χρήση στα ελληνικά)."""
    return fem if str(sex or "").upper().startswith("F") else masc


def the(sex: str | None, *, cap: bool = True) -> str:
    """Το άρθρο πριν από το όνομα: «Ο ΓΙΩΡΓΟΣ» / «Η ΜΑΡΙΑ». Χωρίς αυτό κάθε πρόταση
    ξεκινά με κεφαλαία σκέτα και ακούγεται σαν λίστα, όχι σαν κουβέντα."""
    a = "Η" if str(sex or "").upper().startswith("F") else "Ο"
    return a if cap else a.lower()


def doses(n: int) -> str:
    """«μία εκτέλεση» / «τρεις εκτελέσεις» — ο ενικός δεν είναι λεπτομέρεια."""
    n = int(n)
    return "μία εκτέλεση" if n == 1 else f"{count_word(n, feminine=True)} εκτελέσεις"


def product(name: str | None) -> str:
    """Ονομασία ΗΔΥΚΑ → κάτι που λέγεται. «TOUJEO (SOLOSTAR) IN.SO.PF.P 300 Units/ml
    BTx3 PF.PENS (Solostar) x1,5ml» → «TOUJEO (SOLOSTAR)»."""
    s = (name or "").strip()
    if not s:
        return ""
    s = s.split(",")[0]
    parts, out = s.split(), []
    for w in parts:
        # σταμάτα στην πρώτη «φαρμακοτεχνική» λέξη (μορφή/περιεκτικότητα/συσκευασία)
        if any(ch.isdigit() for ch in w) or w.upper() in {
                "TAB", "F.C.TAB", "CAPS", "INJ.SOL", "IN.SO.PF.P", "SYR", "EFF.GRAN",
                "S.R.F.C.TA", "C.S.SOL", "OR.SO.D", "CR", "GEL", "BT", "BTX"}:
            break
        out.append(w)
        if len(out) >= 4:
            break
    return " ".join(out) or parts[0]


def person(full: str | None) -> str:
    """Ολόκληρο το όνομα όπως θα το έλεγε άνθρωπος — πρώτο το μικρό αν το ξέρουμε."""
    s = (full or "").strip()
    return s or "Πελάτης χωρίς όνομα"


# ── χαιρετισμός της ημέρας ───────────────────────────────────────────────────
def greeting(name: str | None, *, hour: int, open_misses: int, wins: int,
             clean_streak: int) -> str:
    who = (name or "").strip().split()[0] if (name or "").strip() else ""
    hello = "Καλημέρα" if hour < 12 else "Καλησπέρα"
    head = f"{hello}{', ' + who if who else ''}."

    if open_misses == 0 and clean_streak >= 5:
        return (f"{head} Έχουν περάσει {count_word(clean_streak, feminine=True)} συνεχόμενες μέρες "
                f"χωρίς να εντοπίσω κάτι που να ξέφυγε. Δεν είναι τύχη — είναι ο τρόπος "
                f"που δουλεύεις, και αξίζει να το ξέρεις.")
    if open_misses == 0:
        return (f"{head} Κοίταξα όλα τα σημεία και σήμερα δεν υπάρχει κάτι που να χρειάζεται "
                f"την προσοχή σου. Καλή σου μέρα.")
    if open_misses == 1:
        return (f"{head} Ένα μόνο θέμα θα ήθελα να δεις σήμερα — δεν θα σου πάρει "
                f"πάνω από δύο λεπτά.")
    if open_misses <= 3:
        return (f"{head} {count_word(open_misses, neuter=True).capitalize()} πράγματα τράβηξαν "
                f"την προσοχή μου από χθες. Δες τα με τη σειρά που στα βάζω — "
                f"το πρώτο είναι και το πιο επείγον.")
    if wins:
        return (f"{head} Χθες έγιναν αρκετά σωστά πράγματα και θα στα πω παρακάτω. "
                f"Έχω όμως και {count_word(open_misses, neuter=True)} θέματα που θέλουν "
                f"την προσοχή σου σήμερα.")
    return (f"{head} Εντόπισα {count_word(open_misses, neuter=True)} θέματα που δεν "
            f"εξελίχθηκαν όπως θα έπρεπε. Κανένα δεν είναι σοβαρό από μόνο του — "
            f"αλλά μαζεύονται, και γι' αυτό στα λέω μαζεμένα.")


# ── κλείσιμο της ημέρας ──────────────────────────────────────────────────────
def closing(*, open_misses: int, wins: int, hard: int) -> str:
    if hard:
        return ("Μία τελευταία σκέψη: τα σημειωμένα με κόκκινο τα βλέπω αρκετές μέρες τώρα. "
                "Μη δοκιμάσεις να τα κλείσεις όλα σήμερα — διάλεξε ένα και τελείωσέ το. "
                "Την επόμενη μέρα θα είναι ένα λιγότερο.")
    if open_misses == 0 and wins:
        return "Δεν έχω κάτι άλλο για σήμερα. Καλή συνέχεια."
    if open_misses == 0:
        return "Καθαρή μέρα — τα λέμε αύριο."
    return "Ό,τι κλείσεις σήμερα δεν θα το ξαναδείς αύριο. Αυτή είναι όλη η ιδέα εδώ."


# ── επιβράβευση ──────────────────────────────────────────────────────────────
_PRAISE_OPENERS = [
    "Μπράβο.", "Αυτό αξίζει να ειπωθεί.", "Το πρόσεξα και το λέω.",
    "Εδώ τα πήγες σωστά.", "Να το ξέρεις:",
]


def praise_opener(seed: int = 0) -> str:
    return _PRAISE_OPENERS[int(seed) % len(_PRAISE_OPENERS)]


def shuffle_seed(day: str) -> int:
    """Σταθερό «τυχαίο» ανά ημέρα — ίδια σελίδα, ίδιες φράσεις όλη μέρα."""
    return sum(ord(c) for c in (day or "")) % 997


__all__ = ["TONE_SOFT", "TONE_FIRM", "TONE_HARD", "tone_for", "repeat_opener", "count_word",
           "people", "days_phrase", "ago_phrase", "money", "first_name", "person", "greeting",
           "closing", "g", "the", "doses", "product",
           "praise_opener", "shuffle_seed"]
