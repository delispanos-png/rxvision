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
_REPEAT_OPENER = {
    TONE_FIRM: [
        "Δεύτερη φορά που στο λέω.",
        "Τρίτη μέρα — και δεν έχει γίνει.",
    ],
    TONE_HARD: [
        "Το λέω {n} μέρες στη σειρά και δεν έχει γίνει τίποτα.",
        "{n}η συνεχόμενη μέρα. Αυτό δεν είναι πια αβλεψία — είναι συνήθεια.",
        "Σταματάω να το λέω ευγενικά: {n} μέρες το ίδιο πράγμα.",
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
    hello = "Καλημέρα" if hour < 12 else ("Καλησπέρα" if hour < 19 else "Καλησπέρα")
    head = f"{hello}{', ' + who if who else ''}."

    if open_misses == 0 and clean_streak >= 5:
        return (f"{head} {count_word(clean_streak, feminine=True).capitalize()} μέρες στη σειρά "
                f"δεν σου έχω βρει τίποτα να σου πω. Αυτό δεν είναι τύχη — έτσι δουλεύει ένα "
                f"φαρμακείο που το προσέχουν.")
    if open_misses == 0:
        return (f"{head} Κοίταξα τα πάντα και δεν βρήκα κάτι που να ξέφυγε. "
                f"Ήρεμη μέρα — πάρε τον καφέ σου.")
    if open_misses == 1:
        return f"{head} Ένα μόνο πράγμα θέλω να δεις σήμερα. Δύο λεπτά θα σου πάρει."
    if open_misses <= 3:
        return (f"{head} {count_word(open_misses, neuter=True).capitalize()} πράγματα "
                f"μού κάνουν εντύπωση από χθες. Δες τα με τη σειρά.")
    if wins:
        return (f"{head} Χθες έγιναν και καλά πράγματα — θα σου τα πω. "
                f"Αλλά έχω και {count_word(open_misses, neuter=True)} θέματα "
                f"που θέλουν το χέρι σου.")
    return (f"{head} Έχω {count_word(open_misses, neuter=True)} πράγματα που δεν πήγαν όπως έπρεπε. "
            f"Δεν είναι καταστροφή, αλλά αν τα αφήσεις γίνονται.")


# ── κλείσιμο της ημέρας ──────────────────────────────────────────────────────
def closing(*, open_misses: int, wins: int, hard: int) -> str:
    if hard:
        return ("Ένα πράγμα μόνο: τα παραπάνω με το κόκκινο τα λέω πολλές μέρες. "
                "Διάλεξε ΕΝΑ και κλείσ' το σήμερα. Όχι όλα — ένα.")
    if open_misses == 0 and wins:
        return "Τίποτα άλλο από μένα σήμερα. Καλή δουλειά."
    if open_misses == 0:
        return "Καθαρή μέρα. Τα λέμε αύριο."
    return "Ό,τι κλείσεις σήμερα, δεν θα το ξαναδείς αύριο. Αυτή είναι όλη η ιδέα."


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
           "closing", "g", "doses", "product",
           "praise_opener", "shuffle_seed"]
