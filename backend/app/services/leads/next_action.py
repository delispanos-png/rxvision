"""«Τι κάνω τώρα με αυτό το φαρμακείο;» — κανόνες, όχι μαντεψιά.

Κάθε πρόταση λέει ΚΑΙ τον λόγο της, γιατί ο πωλητής πρέπει να μπορεί να διαφωνήσει. Εργαλείο
που δεν σε αφήνει να πεις «όχι» το κλείνεις.

Οι κανόνες εξετάζονται με σειρά· ο πρώτος που ταιριάζει κερδίζει. Πρώτα ό,τι έχει ρητή
ημερομηνία (υπόσχεση σε άνθρωπο), μετά ό,τι είναι επείγον, μετά τα υπόλοιπα.
"""

from __future__ import annotations

from app.services.leads.projection import (CHURNED, CUSTOMER, SIGNUP_ABANDONED,
                                           TRIAL_ACTIVE, TRIAL_ENDING, TRIAL_EXPIRED,
                                           TRIAL_PURGED)

CALL, OFFER, REENGAGE, REMIND, WAIT, NOTHING = (
    "call", "offer", "reengage", "remind", "wait", "nothing")


def _d(lead: dict, *path, default=None):
    cur = lead
    for p in path:
        cur = (cur or {}).get(p)
    return cur if cur is not None else default


def suggest(lead: dict) -> dict:
    """→ {action, title, why, urgency: high|normal|low, buttons: [...]}"""
    stage = lead.get("stage")
    status = lead.get("status") or "new"
    score = int(_d(lead, "score", "value", default=0))
    since = _d(lead, "trial", "days_since_expiry")
    left = _d(lead, "trial", "days_left")
    idle = _d(lead, "activity", "days_since_activity")
    returned = _d(lead, "activity", "returned_after_days")
    has_phone, has_email = bool(lead.get("phone")), bool(lead.get("email"))

    def out(action, title, why, urgency="normal"):
        buttons = {
            CALL: ["call", "remind"], OFFER: ["offer", "call"],
            REENGAGE: ["reengage", "lost"], REMIND: ["remind", "call"],
            WAIT: ["remind"], NOTHING: [],
        }[action]
        if action in (OFFER, REENGAGE) and not has_email:
            # Πρόταση που δεν μπορεί να εκτελεστεί δεν είναι πρόταση.
            return {"action": CALL, "title": "Πάρ' τον τηλέφωνο — δεν έχουμε email",
                    "why": why + " Δεν υπάρχει διεύθυνση email, οπότε μήνυμα δεν μπορεί να σταλεί.",
                    "urgency": urgency, "buttons": ["call", "remind"]}
        return {"action": action, "title": title, "why": why, "urgency": urgency,
                "buttons": buttons}

    # 0) Τελείωσε η κουβέντα
    if status in ("do_not_contact", "lost"):
        return out(NOTHING, "Δεν το κυνηγάμε",
                   "Έχει σημειωθεί ότι δεν προχωράει. Άλλαξέ το αν κάτι άλλαξε.", "low")
    if stage == CUSTOMER:
        return out(NOTHING, "Είναι πελάτης", "Δεν χρειάζεται ενέργεια πωλήσεων.", "low")

    # 1) Υπάρχει ανοιχτή υπόσχεση με ημερομηνία
    na = lead.get("next_action") or {}
    if na.get("due_at"):
        return out(CALL, na.get("title") or "Έχεις υπενθύμιση γι' αυτόν",
                   "Έχει προγραμματιστεί ενέργεια. Μην την προσπεράσεις.", "high")

    # 2) Η δοκιμή τελειώνει — το παράθυρο κλείνει
    if stage == TRIAL_ENDING:
        if score >= 51:
            return out(CALL, "Πάρ' τον τηλέφωνο πριν λήξει",
                       f"Η δοκιμή του τελειώνει σε {left} ημέρες και το χρησιμοποιεί κανονικά. "
                       "Τώρα είναι η στιγμή που αποφασίζει.", "high")
        return out(REMIND, "Ρώτα τον αν τα κατάφερε",
                   f"Η δοκιμή τελειώνει σε {left} ημέρες αλλά δεν το έχει δουλέψει πολύ. "
                   "Ίσως κόλλησε κάπου στην αρχή.", "normal")

    # 3) Μόλις έληξε
    if stage == TRIAL_EXPIRED and since is not None:
        if returned:
            return out(CALL, "Πάρ' τον τηλέφωνο σήμερα",
                       f"Η δοκιμή του έληξε πριν {since} ημέρες, αλλά ξαναμπήκε μετά από "
                       f"{int(returned)} ημέρες σιωπής. Δεν έφυγε — σκέφτεται.", "high")
        if since <= 7 and score >= 51:
            return out(CALL, "Πάρ' τον τηλέφωνο",
                       f"Έληξε πριν {since} ημέρες και το είχε δουλέψει σοβαρά "
                       f"(δραστηριότητα {score}). Αξίζει προσωπική επαφή πριν κρυώσει.", "high")
        if since <= 7:
            return out(REMIND, "Ρώτα τον τι τον σταμάτησε",
                       f"Έληξε πριν {since} ημέρες και δεν το δούλεψε. Η απάντηση αξίζει "
                       "περισσότερο από την πώληση.", "normal")
        if since <= 30 and score >= 51:
            return out(OFFER, "Στείλε του συγκεκριμένη προσφορά",
                       f"Έληξε πριν {since} ημέρες, το χρησιμοποίησε σοβαρά και δεν αγόρασε. "
                       "Το τηλέφωνο έχει ήδη γίνει ή δεν απάντησε — δώσ' του λόγο να γυρίσει.")
        if since <= 30:
            return out(REENGAGE, "Στείλε του επαναπροσέγγιση",
                       f"Έληξε πριν {since} ημέρες με μικρή χρήση. Δείξ' του τι έχασε.")
        if since <= 90:
            return out(REENGAGE, "Επαναπροσέγγιση — όχι τηλέφωνο",
                       f"Έληξε πριν {since} ημέρες. Το τηλέφωνο τώρα ενοχλεί· ένα μήνυμα με "
                       "κάτι νέο δουλεύει καλύτερα.", "low")
        return out(REENGAGE, "Μόνο αν έχει βγει κάτι νέο",
                   f"Έληξε πριν {since} ημέρες. Χωρίς νέα αφορμή, δεν υπάρχει λόγος επαφής.",
                   "low")

    # 4) Ο λογαριασμός διαγράφηκε
    if stage == TRIAL_PURGED:
        if not has_email and not has_phone:
            return out(NOTHING, "Δεν έχουμε πώς να τον βρούμε",
                       "Δεν κρατήθηκε ούτε email ούτε τηλέφωνο όταν διαγράφηκε ο λογαριασμός.",
                       "low")
        return out(REENGAGE, "Επαναπροσέγγιση με νέα αφορμή",
                   "Ο λογαριασμός του έχει διαγραφεί. Χρειάζεται καθαρή αφορμή — νέα "
                   "δυνατότητα ή προσφορά — όχι υπενθύμιση.", "low")

    # 5) Ημιτελής εγγραφή — έφτασε στο ταμείο
    if stage == SIGNUP_ABANDONED:
        return out(CALL, "Πάρ' τον τηλέφωνο — κόλλησε στο ταμείο",
                   "Ξεκίνησε την εγγραφή και δεν την ολοκλήρωσε. Συνήθως φταίει κάτι μικρό "
                   "στην πληρωμή, όχι η απόφαση.", "high")

    # 6) Ήταν πελάτης
    if stage == CHURNED:
        return out(CALL, "Πάρ' τον τηλέφωνο — ήταν πελάτης",
                   "Η συνδρομή του έληξε. Ένας πελάτης που έφυγε αξίζει τηλέφωνο, όχι μήνυμα.",
                   "high")

    # 7) Δοκιμάζει τώρα
    if stage == TRIAL_ACTIVE:
        if idle is not None and idle >= 7:
            return out(REMIND, "Δες γιατί σταμάτησε",
                       f"Δοκιμάζει ακόμη αλλά έχει {int(idle)} ημέρες να μπει. Μια δοκιμή που "
                       "σταματά στη μέση σπάνια καταλήγει σε συνδρομή.", "normal")
        return out(WAIT, "Άφησέ τον να δουλέψει",
                   "Η δοκιμή του τρέχει κανονικά. Θα τον δεις όταν πλησιάσει η λήξη.", "low")

    return out(WAIT, "Τίποτα επείγον", "Δεν υπάρχει αφορμή επαφής αυτή τη στιγμή.", "low")
