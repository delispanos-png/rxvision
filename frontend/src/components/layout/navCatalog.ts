/** Ο ΚΑΤΑΛΟΓΟΣ ΤΟΥ ΜΕΝΟΥ — ΜΙΑ λίστα, δύο καταναλωτές: το ίδιο το μενού (Sidebar) και η
 *  οθόνη «Μενού ανά ρόλο». Χωρίς αυτό θα υπήρχαν δύο λίστες που αποκλίνουν με τον καιρό.
 *  Τα κλειδιά που αποθηκεύονται στον server είναι τα `title` των ομάδων.
 *  Δομή = το μενού του ιδιοκτήτη (22/10/2026, «RxVision menu.xlsx»). */

import {
  Activity, BarChart3, Boxes, CalendarClock, LayoutDashboard, Mail, Megaphone, Salad, PackageSearch,
  Settings, Sparkles, Stethoscope, TrendingUp, Target, Users, Brain, ShieldCheck, Tags, Syringe, Bot,
  Gift, BookOpen, ScrollText, Truck, Lock, UserPlus, Ticket, SlidersHorizontal, Heart, FileText,
  MessageSquare, PackageCheck, ArrowRightLeft, Compass, Handshake, Home, Inbox, Send, RefreshCw,
  Store, LifeBuoy, ShoppingBag, Building2, Eye, Headset, Wallet, type LucideIcon } from "lucide-react";

// A leaf (direct link). `module` gates visibility (shown only when enabled/trial).
export type Leaf = { href: string; label: string; en: string; module?: string | string[];
  /** Tooltip μενού για ΑΥΤΟ το στοιχείο (υπερισχύει της βοήθειας σελίδας). */
  tip?: string; tip_en?: string };
/** A node is either a direct link (href) or an expandable parent (children).
 *  `section`: ενδιάμεσο, πτυσσόμενο επίπεδο ΜΕΣΑ στην ομάδα (π.χ. «Ανάλυση εκτελέσεων» στη
 *  «Διαχείριση φαρμακείου»). Συνεχόμενοι κόμβοι με την ίδια `section` εμφανίζονται κάτω από αυτήν. */
export type Node = { label: string; en: string; icon: LucideIcon; href?: string; module?: string | string[];
  tip?: string; tip_en?: string;
  children?: Leaf[]; section?: { label: string; en: string } };
export type Group = { title: string; en: string; icon: LucideIcon; items: Node[] };
export type Me = { modules?: Record<string, "enabled" | "trial" | "locked">; country?: string };

const EXEC = { label: "Ανάλυση εκτελέσεων", en: "Execution analysis" };

export const NAV_GROUPS: Group[] = [
  // Ο Σύμβουλος — ξεχωριστό κύκλωμα που αγοράζεται ως extra (module `daily_coach`,
  // σε ΚΑΝΕΝΑ πακέτο). Πρώτο στο μενού: είναι η οθόνη που ανοίγεις το πρωί.
  { title: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, items: [
    { label: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, href: "/coach", module: "daily_coach" },
  ] },
  // Ό,τι χρειάζεται ο φαρμακοποιός με τον πελάτη ΜΠΡΟΣΤΑ του.
  { title: "Εξυπηρέτηση πάγκου", en: "Counter service", icon: Store, items: [
    { label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, href: "/intelligence", tip: "Ποιοι πελάτες σου χρειάζονται προσοχή και γιατί: επαναλήψεις που πλησιάζουν, όσοι σταμάτησαν να έρχονται, ρίσκο, VIP.", tip_en: "Which customers need attention and why: upcoming repeats, lapsed customers, risk, VIPs.", module: "patient_analytics" },
    { label: "Προχορηγήσεις", en: "Advance dispensings", icon: ArrowRightLeft, href: "/patients/advance", tip: "Φάρμακα που δίνεις πριν φέρει ο πελάτης τη συνταγή — ποιος χρωστάει τι και πότε ξεχρεώνεται.", tip_en: "Medicines given before the prescription arrives — who owes what and when it is settled.", module: "advance_dispensing" },
    { label: "Διατροφή", en: "Nutrition", icon: Salad, href: "/nutrition", module: ["nutrition", "ai_assistant"] },
  ] },
  { title: "Έλεγχος συνταγών", en: "Prescription control", icon: ShieldCheck, items: [
    { label: "Συνταγές", en: "Prescriptions", icon: BarChart3, module: "prescription_analytics", children: [
      { href: "/prescriptions", label: "Λίστα", en: "List" },
      { href: "/rx-types", label: "Δείκτες", en: "Indicators" },
    ] },
    { label: "Έλεγχος συνταγών", en: "Rx Audit", icon: ShieldCheck, href: "/reimbursement", module: "monthly_closing" },
  ] },
  { title: "Παραγγελία", en: "Ordering", icon: PackageSearch, items: [
    { label: "βάσει πρόβλεψης", en: "by forecast", icon: TrendingUp, href: "/order-advisor", module: "order_suggestions" },
    { label: "βάσει εκτελέσεων", en: "by executions", icon: PackageSearch, href: "/orders", module: "order_suggestions" },
    // η σελίδα έχει δικές της καρτέλες (Κάλυψη περιόδου / Πρόβλεψη κάλυψης)
    { label: "Μελλοντικές συνταγές", en: "Upcoming prescriptions", icon: CalendarClock, href: "/future", module: "future_prescriptions" },
  ] },
  // Στοχευμένη Προώθηση + επικοινωνία + τα κυκλώματα επανάληψης (εμβόλια/θεραπείες) — ό,τι
  // φέρνει τον πελάτη ΞΑΝΑ στο φαρμακείο. Κάθε επιλογή κρατά το δικό της module.
  { title: "Marketing", en: "Marketing", icon: Megaphone, items: [
    { label: "Dashboard", en: "Dashboard", icon: Megaphone, href: "/marketing", module: "marketing" },
    { label: "Θεραπευτικές κατηγορίες", en: "Therapeutic categories", icon: Target, href: "/marketing/categories", module: "marketing" },
    { label: "Ομάδες πελατών", en: "Customer groups", icon: Users, href: "/communications/audiences", tip: "Έτοιμες και δικές σου ομάδες πελατών για στοχευμένα μηνύματα, με πραγματικά πλήθη.", tip_en: "Ready-made and custom customer groups for targeted messages, with live counts.", module: "patient_analytics" },
    { label: "Καμπάνιες", en: "Campaigns", icon: Mail, module: "patient_analytics", children: [
      { href: "/communications", tip: "Στείλε SMS, Viber ή email σε μια ομάδα πελατών.", tip_en: "Send SMS, Viber or email to a group of customers.", label: "Νέα καμπάνια", en: "New campaign" },
      { href: "/communications/automations", tip: "Μηνύματα που φεύγουν μόνα τους τη σωστή στιγμή για τον καθένα.", tip_en: "Messages sent automatically at the right moment for each customer.", label: "Αυτοματοποιημένες", en: "Automated" },
      { href: "/communications/calendar", tip: "Πόσα μηνύματα στέλνεις και πότε — για να μην κουράζεις τους πελάτες σου.", tip_en: "How many messages you send and when — so you don't tire your customers.", label: "Ημερολόγιο", en: "Calendar" },
    ] },
    // Φαίνεται με ΟΠΟΙΟΔΗΠΟΤΕ από τα δύο: ένα πληρωμένο add-on δεν επιτρέπεται να μένει αόρατο.
    { label: "Εμβολιασμοί", en: "Vaccinations", icon: Syringe, href: "/vaccinations",
      module: ["prescription_analytics", "vaccination_programs"] },
    // Δικό του κύκλωμα, δική του γλώσσα: όποιος παρακολουθεί Prolia δεν διαβάζει «εμβόλιο».
    { label: "Περιοδικές θεραπείες", en: "Periodic therapies", icon: RefreshCw, href: "/therapies", module: "therapy_programs" },
    { label: "Κουπόνια", en: "Coupons", icon: Ticket, href: "/marketing/coupons", module: "marketing" },
  ] },
  // Πύλη + πιστότητα μαζί· κάθε καρτέλα = αυτόνομο entry (URL hash).
  { title: "Πύλη πελατών & Πιστότητα", en: "Portal & Loyalty", icon: Heart, items: [
    { label: "Πελάτες πύλης", en: "Portal customers", icon: Heart, href: "/portal-admin#customers", tip: "Οι πελάτες με λογαριασμό στην πύλη: εγγραφή, πρόσκληση, στοιχεία σύνδεσης.", tip_en: "Customers with a portal account: sign-up, invitation, login details.", module: "patient_portal" },
    { label: "Συνταγές", en: "Rx requests", icon: FileText, href: "/portal-admin#rx", tip: "Συνταγές που σου στέλνουν οι πελάτες από την πύλη για να τις ετοιμάσεις.", tip_en: "Prescriptions customers send you from the portal to prepare.", module: "patient_portal" },
    { label: "Διαθεσιμότητα", en: "Availability", icon: MessageSquare, href: "/portal-admin#availability", tip: "Ερωτήσεις πελατών «το έχετε;» και οι απαντήσεις σου.", tip_en: "Customer \"do you have it?\" questions and your answers.", module: "patient_portal" },
    { label: "Ραντεβού", en: "Appointments", icon: CalendarClock, href: "/portal-admin#appointments", tip: "Ραντεβού που κλείνουν οι πελάτες για υπηρεσίες του φαρμακείου.", tip_en: "Appointments customers book for pharmacy services.", module: "patient_portal" },
    { label: "Μεταφορά πελάτη", en: "Patient transfer", icon: ArrowRightLeft, href: "/patients/transfers", tip: "Ζήτα να αναλάβεις πελάτη από άλλο φαρμακείο (εγκρίνει ο ίδιος) και δες ποιοι δικοί σου άλλαξαν φαρμακείο.", tip_en: "Ask to take over a customer from another pharmacy (they approve) and see who of yours moved.", module: "patient_analytics" },
    // ΠΡΟΣΩΡΙΝΗ θέση — δεν υπάρχει στο Excel (22/10/2026), περιμένει απόφαση ιδιοκτήτη
    { label: "Ποιος βλέπει ποιον", en: "Who sees whom", icon: Eye, href: "/patients/access", tip: "Ποιος έχει πρόσβαση στον λογαριασμό πύλης ποιου: γονείς για ανήλικα και εξουσιοδοτημένοι φροντιστές.", tip_en: "Who can access whose portal account: parents of minors and authorised carers.", module: "patient_portal" },
    { label: "Μέλη πιστότητας", en: "Loyalty members", icon: Users, href: "/loyalty#members", tip: "Τα μέλη του προγράμματος πιστότητας και οι πόντοι τους.", tip_en: "Loyalty programme members and their points.", module: "loyalty" },
    // ΠΡΟΣΩΡΙΝΗ θέση — δεν υπάρχει στο Excel· η σελίδα δεν έχει άλλη είσοδο προς αυτή την καρτέλα
    { label: "Εγγραφή μέλους", en: "Enrol member", icon: UserPlus, href: "/loyalty#enroll", tip: "Γράψε νέο μέλος στο πρόγραμμα πιστότητας.", tip_en: "Enrol a new member in the loyalty programme.", module: "loyalty" },
    { label: "Εξαργυρώσεις", en: "Redemptions", icon: Ticket, href: "/loyalty#redemptions", tip: "Εξαργυρώσεις πόντων: τι ζητήθηκε και τι δόθηκε.", tip_en: "Point redemptions: what was requested and given.", module: "loyalty" },
    { label: "Ρυθμίσεις", en: "Settings", icon: SlidersHorizontal, module: ["patient_portal", "loyalty"], children: [
      { href: "/portal-admin#services", tip: "Οι υπηρεσίες που προσφέρεις στην πύλη και για ραντεβού.", tip_en: "The services you offer on the portal and for appointments.", label: "Υπηρεσίες", en: "Services", module: "patient_portal" },
      { href: "/loyalty#rewards", tip: "Τα δώρα που μπορούν να πάρουν τα μέλη με τους πόντους τους.", tip_en: "Rewards members can get with their points.", label: "Δώρα και εξαργυρώσεις", en: "Rewards", module: "loyalty" },
      { href: "/loyalty#settings", tip: "Οι κανόνες του προγράμματος: πόσοι πόντοι, πότε και για τι.", tip_en: "Programme rules: how many points, when and for what.", label: "Πρόγραμμα πιστότητας", en: "Loyalty program", module: "loyalty" },
    ] },
  ] },
  { title: "Ηλεκτρονικό κατάστημα", en: "e-shop", icon: ShoppingBag, items: [
    { label: "Ενεργές παραγγελίες", en: "Active orders", icon: Truck, href: "/orders-delivery#orders", tip: "Παραγγελίες σε εξέλιξη: ετοιμασία, αποστολή, παράδοση.", tip_en: "Orders in progress: preparation, shipping, delivery.", module: "order_delivery" },
    { label: "Ολοκληρωμένες", en: "Completed", icon: PackageCheck, href: "/orders-delivery#done", tip: "Παραδομένες και κλειστές παραγγελίες.", tip_en: "Delivered and closed orders.", module: "order_delivery" },
    { label: "Προσφορές", en: "Promotions", icon: Tags, href: "/eshop-offers", module: "order_delivery" },
    { label: "Ρυθμίσεις", en: "Settings", icon: SlidersHorizontal, module: "order_delivery", children: [
      { href: "/eshop-categories", label: "Κατηγορίες e-shop", en: "e-shop categories" },
      { href: "/orders-delivery#settings", tip: "Τρόποι και κόστος αποστολής.", tip_en: "Shipping methods and costs.", label: "Ρυθμίσεις αποστολής", en: "Delivery settings" },
      { href: "/eshop-fees", label: "Προμήθειες συναλλαγών", en: "Transaction fees" },
    ] },
  ] },
  { title: "Διαχείριση φαρμακείου", en: "Pharmacy management", icon: Building2, items: [
    { section: EXEC, label: "Dashboard", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    // Τα ΙΔΙΑ modules με πριν: όποιος έβλεπε τη λίστα ασθενών δεν τη χάνει με την αναδιάταξη.
    { section: EXEC, label: "Ασφαλισμένοι", en: "Patients", icon: Users,
      module: ["patient_analytics", "advance_dispensing", "family_groups", "patient_portal"], children: [
      { href: "/patients#list", tip: "Αναζήτηση πελάτη και άνοιγμα της καρτέλας του.", tip_en: "Find a customer and open their profile.", label: "Λίστα", en: "List" },
      { href: "/patients#kpi", tip: "Δείκτες διατήρησης πελατών: νέοι, ενεργοί, όσοι χάθηκαν.", tip_en: "Customer retention indicators: new, active, lapsed.", label: "Δείκτες", en: "Indicators" },
      { href: "/patients/deceased", tip: "Θανόντες ασθενείς και ό,τι εκκρεμεί γι' αυτούς: ανεκτέλεστες συνταγές και ανοιχτές παραγγελίες.", tip_en: "Deceased patients and anything pending: unexecuted prescriptions and open orders.", label: "Θανόντες και εκκρεμότητες", en: "Deceased & balances" },
      { href: "/patients/verify-contacts", tip: "Πελάτες με ανεπιβεβαίωτα ή παλιά στοιχεία επικοινωνίας — και εισαγωγή στοιχείων από το εμπορικό σου.", tip_en: "Customers with unconfirmed or old contact details — and import from your pharmacy system.", label: "Επιβεβαίωση στοιχείων", en: "Confirm contacts" },
    ] },
    { section: EXEC, label: "Οικογένειες", en: "Families", icon: Users, href: "/patients/families", tip: "Οικογένειες πελατών: τι πήρε και τι εκκρεμεί για κάθε μέλος, σε μία οθόνη.", tip_en: "Customer families: what each member got and what is pending, on one screen.", module: "family_groups" },
    { section: EXEC, label: "Δομές φροντίδας", en: "Care structures", icon: Home, href: "/care", module: "care_homes" },
    { section: EXEC, label: "Ιατροί", en: "Doctors", icon: Stethoscope, module: "doctor_analytics", children: [
      { href: "/doctors#list", tip: "Οι γιατροί που συνταγογραφούν στους πελάτες σου, ανά ειδικότητα.", tip_en: "Doctors prescribing to your customers, by specialty.", label: "Λίστα", en: "List" },
      { href: "/doctors#kpi", tip: "Ποιος γιατρός σου στέλνει δουλειά και πώς αλλάζει στον χρόνο.", tip_en: "Which doctor sends you work and how it changes over time.", label: "Δείκτες", en: "Indicators" },
    ] },
    { section: EXEC, label: "Διαγνώσεις", en: "Diagnoses", icon: Activity, module: "icd10_analytics", children: [
      { href: "/icd10#list", tip: "Οι διαγνώσεις των συνταγών σου, με το όνομά τους.", tip_en: "The diagnoses on your prescriptions, by name.", label: "Λίστα", en: "List" },
      { href: "/icd10#kpi", tip: "Δείκτες ανά κεφάλαιο διαγνώσεων.", tip_en: "Indicators per diagnosis chapter.", label: "Δείκτες", en: "Indicators" },
    ] },
    // ΑΠΟΘΗΚΗ = βασική για όλους (21/10/2026), ΧΩΡΙΣΤΑ από το e-shop. «ή order_delivery» →
    // όσοι είναι ήδη συνδεδεμένοι με παλιό token τη βλέπουν χωρίς διακοπή.
    { label: "Αποθήκη", en: "Warehouse", icon: Boxes, href: "/warehouse", module: ["warehouse", "order_delivery"] },
  ] },
  { title: "AI σύμβουλοι", en: "AI advisors", icon: Sparkles, items: [
    { label: "Επιχειρησιακά", en: "Business", icon: Sparkles, href: "/advisor" },
    { label: "AI σύμβουλος", en: "AI Assistant", icon: Bot, module: "ai_assistant", children: [
      { href: "/copilot", label: "Συνομιλία", en: "Chat" },
      { href: "/copilot/routines", label: "Ρουτίνες", en: "Routines" },
    ] },
    { label: "Κερδοφορία", en: "Profitability", icon: TrendingUp, href: "/profitability", module: "profitability" },
  ] },
  // RxVision Connect — δίκτυα συνεργασίας φαρμακείων (module `connect`, πληρωμένο πρόσθετο).
  { title: "Connect", en: "Connect", icon: Handshake, items: [
    { label: "Πίνακας", en: "Dashboard", icon: Handshake, href: "/connect#dashboard", tip: "Η εικόνα της συνεργασίας σου με το δίκτυο: αιτήματα, κινήσεις, υπόλοιπα.", tip_en: "Your network collaboration at a glance: requests, movements, balances.", module: "connect" },
    { label: "Αιτήματα δικτύου", en: "Network requests", icon: Inbox, href: "/connect#inbox", tip: "Αιτήματα συναδέλφων για σκευάσματα που μπορείς να δώσεις.", tip_en: "Colleagues' requests for products you can supply.", module: "connect" },
    { label: "Τα αιτήματά μου", en: "My requests", icon: Send, href: "/connect#requests", tip: "Όσα ζήτησες εσύ από το δίκτυο και οι προσφορές που πήρες.", tip_en: "What you asked the network for and the offers you got.", module: "connect" },
    { label: "Κινήσεις και υπόλοιπα", en: "Movements & balances", icon: ArrowRightLeft, href: "/connect#movements", tip: "Τι δώσατε και τι πήρατε μεταξύ σας — ποιος χρωστάει σε ποιον.", tip_en: "What you gave and received — who owes whom.", module: "connect" },
    { label: "Τα δίκτυά μου", en: "My networks", icon: Users, href: "/connect#networks", tip: "Τα δίκτυα φαρμακείων στα οποία συμμετέχεις.", tip_en: "The pharmacy networks you belong to.", module: "connect" },
    { label: "Πόσο διαθέτω", en: "Availability policy", icon: SlidersHorizontal, href: "/connect#settings", tip: "Πόσο απόθεμα διαθέτεις στο δίκτυο, ώστε να απαντά αυτόματα το σύστημα.", tip_en: "How much stock you offer the network, so the system can answer automatically.", module: "connect" },
  ] },
  // Μονές επιλογές (ομάδα με ΕΝΑ φύλλο → απευθείας link στο μενού). PharmaCat και Chat ΔΕΝ
  // μπαίνουν στο μενού (απόφαση ιδιοκτήτη 22/10/2026) — ανοίγουν από την πάνω μπάρα.
  { title: "Ρυθμίσεις", en: "Settings", icon: Settings, items: [
    { label: "Ρυθμίσεις", en: "Settings", icon: Settings, href: "/settings/users", tip: "Σύνδεση με ΗΔΥΚΑ, χρήστες, χρέωση και κανάλια επικοινωνίας.", tip_en: "ΗΔΥΚΑ connection, users, billing and messaging channels." },
  ] },
  { title: "Βοήθεια", en: "Help", icon: LifeBuoy, items: [
    // PharmacyOne is a back-office INTEGRATION (data source), not a user-facing capability → not in the menu.
    { label: "Εγχειρίδιο χρήσης", en: "User manual", icon: FileText, href: "/manual" },
    { label: "Οδηγός δεικτών", en: "Indicators guide", icon: BookOpen, href: "/guide" },
    { label: "Ζωντανή υποστήριξη", en: "Live support", icon: Headset, href: "/support-live" },
    { label: "Όροι χρήσης", en: "Terms of Use", icon: ScrollText, href: "/terms-of-use" },
    { label: "GDPR", en: "GDPR", icon: Lock, href: "/gdpr" },
  ] },
];

/** ΜΕΝΟΥ ΚΥΠΡΙΑΚΟΥ ΦΑΡΜΑΚΕΙΟΥ (`/auth/me` → country "CY").
 *  Κανόνας: εμφανίζεται ΜΟΝΟ ό,τι δουλεύει πλήρως με τα δεδομένα ΓεΣΥ. Τα κοινά κυκλώματα της
 *  πλατφόρμας μπαίνουν αυτούσια (ίδια αντικείμενα — όχι αντίγραφα που αποκλίνουν), ένα-ένα,
 *  όταν επιβεβαιωθεί ότι δουλεύουν χωρίς ελληνικά δεδομένα. Οι επιτρεπτές διαδρομές ζουν στο
 *  CountryGate (`CY_ALLOWED`) — κράτα τα δύο συγχρονισμένα. */
const SHARED_FOR_CY = new Set(["Connect", "Ρυθμίσεις", "Βοήθεια"]);
/** Μεμονωμένες επιλογές ελληνικών ομάδων που δουλεύουν ΑΥΤΟΥΣΙΕΣ στην Κύπρο (δεν θέλουν δεδομένα ΗΔΥΚΑ).
 *  Έλεγχος 17/11/2026: κουπόνια, e-shop (προσφορές/κατηγορίες/προμήθειες), αποθήκη (ΦΠΑ ανά χώρα). */
const CY_PICK = new Set(["/marketing/coupons", "/eshop-offers", "/eshop-categories", "/eshop-fees", "/warehouse",
  // e-shop: οι Κύπριοι πελάτες της πύλης παραγγέλνουν → το φαρμακείο πρέπει να βλέπει τις παραγγελίες
  "/orders-delivery#orders", "/orders-delivery#done", "/orders-delivery#settings",
  // πύλη & πιστότητα (17/11/2026): ΧΩΡΙΣ «Πελάτες πύλης»/«Συνταγές» (ΑΜΚΑ/ΗΔΥΚΑ)· η πρόσκληση
  // και η εγγραφή στην πιστότητα γίνονται από την Καρτέλα πελάτη ΓεΣΥ
  "/portal-admin#availability", "/portal-admin#appointments", "/portal-admin#services",
  "/loyalty#members", "/loyalty#redemptions", "/loyalty#rewards", "/loyalty#settings"]);
const pickFrom = (titles: string[]): Node[] => NAV_GROUPS
  .filter((g) => titles.includes(g.title))
  .flatMap((g) => g.items.flatMap((n): Node[] => {
    if (n.href && CY_PICK.has(n.href)) return [n];
    const kids = (n.children ?? []).filter((c) => CY_PICK.has(c.href));
    return kids.length ? [{ ...n, children: kids }] : [];
  }));
export const CY_NAV_GROUPS: Group[] = [
  // «Ο Σύμβουλός σου»: ίδια οθόνη, σήματα ΓεΣΥ (backend repositories/cy_daily_coach.py)
  ...NAV_GROUPS.filter((g) => g.title === "Ο Σύμβουλός σου"),
  // ΙΔΙΕΣ ομάδες με το ελληνικό μενού (ίδιοι τίτλοι → ο φαρμακοποιός που ξέρει το ένα βρίσκει το άλλο)
  { title: "Εξυπηρέτηση πάγκου", en: "Counter service", icon: Store, items: [
    { label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, href: "/intelligence", module: "patient_analytics", tip: "Ποιοι πελάτες σου χρειάζονται προσοχή και γιατί: ποιοι αναμένονται, ποιοι δεν είναι συνεπείς, ποιοι χάνονται, οι VIP.", tip_en: "Which customers need attention and why: who is due, who is not on track, who is being lost, your VIPs." },
    { label: "Προχορηγήσεις", en: "Advance dispensings", icon: ArrowRightLeft, href: "/cy/loans", module: "advance_dispensing", tip: "Σκευάσματα που δίνεις πριν εκτελεστεί η συνταγή ΓεΣΥ, και η ξεχρέωσή τους όταν εκτελεστεί.", tip_en: "Products you give before the GHS prescription is dispensed, and clearing them once it is." },
    { label: "Διατροφή", en: "Nutrition", icon: Salad, href: "/nutrition", module: ["nutrition", "ai_assistant"], tip: "Πρόταση διατροφής από τα φάρμακα και τις μετρήσεις του πελάτη.", tip_en: "A nutrition proposal from the customer's medicines and measurements." },
    { label: "Ανοιχτές συνταγές", en: "Open prescriptions", icon: CalendarClock, href: "/cy/open", tip: "Ποιος πρέπει να έρθει για την επόμενη φάση της συνταγής του και πότε.", tip_en: "Who should come for the next step of their prescription, and when." },
    { label: "Χαμένοι πελάτες", en: "Lost customers", icon: UserPlus, href: "/cy/lost", tip: "Πελάτες που δεν ήρθαν για συνταγή που έπρεπε να συνεχιστεί, και πόσο αξίζουν.", tip_en: "Customers who did not come back for a prescription that should have continued, and what they are worth." },
    { label: "Θεραπείες με Επανάληψη", en: "Repeat therapies", icon: RefreshCw, href: "/therapies", module: "therapy_programs", tip: "Θεραπείες που επαναλαμβάνονται κάθε λίγους μήνες (π.χ. Prolia): ποιος καθυστέρησε και πόσο, από τις εκτελέσεις ΓεΣΥ.", tip_en: "Therapies repeated every few months (e.g. Prolia): who is overdue and by how much, from GHS dispensings." },
    { label: "Αναλώσιμα & διαβητικοί", en: "Consumables & diabetics", icon: Activity, href: "/cy/consumables", tip: "Ποιοι παίρνουν ταινίες/σκαρφιστήρες και ποιοι άργησαν για τα επόμενα.", tip_en: "Who receives strips/lancets and who is late for the next supply." },
  ] },
  { title: "Έλεγχος συνταγών", en: "Prescription control", icon: ShieldCheck, items: [
    { label: "Εκτελέσεις", en: "Dispensings", icon: BarChart3, href: "/cy/dispensings", tip: "Όλες οι εκτελέσεις ΓεΣΥ της περιόδου, με αναζήτηση και λεπτομέρεια ανά εκτέλεση.", tip_en: "All GHS dispensings in the period, with search and per-dispensing detail." },
    { label: "Είδη που δεν δόθηκαν", en: "Items not dispensed", icon: PackageSearch, href: "/cy/not-dispensed", tip: "Σκευάσματα της συνταγής που δεν δόθηκαν: πιθανή έλλειψη ή χαμένη πώληση.", tip_en: "Prescribed products that were not given: likely stock-out or lost sale." },
    { label: "Μηνιαία απαίτηση ΟΑΥ", en: "Monthly HIO claim", icon: Wallet, href: "/cy/claim", tip: "Πόσα περιμένεις να πληρωθείς από τον ΟΑΥ κάθε μήνα, με τη λίστα εκτελέσεων για έλεγχο της εκκαθάρισης.", tip_en: "What you expect from the HIO each month, with the dispensing list to check the settlement." },
    { label: "Διαφορά τιμής (PC2)", en: "Price difference (PC2)", icon: Tags, href: "/cy/pc2", tip: "Όσα πληρώνουν οι πελάτες πάνω από την τιμή αναφοράς του ΟΑΥ.", tip_en: "What customers pay above the HIO reference price." },
    { label: "Ανάκληση παρτίδας", en: "Batch recall", icon: ShieldCheck, href: "/cy/recall", tip: "Ποιοι πελάτες πήραν μια συγκεκριμένη παρτίδα.", tip_en: "Which customers received a specific batch." },
    { label: "Εισαγωγή XML", en: "XML import", icon: Inbox, href: "/cy/import", tip: "Ανέβασε τα XML εκτελέσεων από την πύλη ΓεΣΥ (ένα-ένα ή σε ZIP).", tip_en: "Upload dispensing XML files from the GHS portal (one by one or as a ZIP)." },
  ] },
  { title: "Παραγγελία", en: "Ordering", icon: PackageSearch, items: [
    { label: "Πρόταση παραγγελίας", en: "Reorder suggestion", icon: PackageSearch, href: "/cy/reorder", tip: "Τι θα ζητηθεί τις επόμενες ημέρες από τις ανοιχτές συνταγές, τι έλειψε, και τι απόθεμα έχεις.", tip_en: "What will be asked for in the coming days from open prescriptions, what ran out, and your stock." },
  ] },
  { title: "Διαχείριση φαρμακείου", en: "Pharmacy management", icon: Building2, items: [
    { section: EXEC, label: "Dashboard", en: "Dashboard", icon: LayoutDashboard, href: "/cy", tip: "Η εικόνα του φαρμακείου: εκτελέσεις, αξία, ΟΑΥ, πελάτες, ώρες αιχμής, με σύγκριση με πέρσι.", tip_en: "Your pharmacy at a glance: dispensings, value, HIO, customers, peak hours, compared with last year." },
    { section: EXEC, label: "Πελάτες", en: "Customers", icon: Users, href: "/cy/patients", tip: "Αναζήτηση πελάτη και άνοιγμα της καρτέλας του.", tip_en: "Find a customer and open their card." },
    { section: EXEC, label: "Ιατροί", en: "Doctors", icon: Stethoscope, href: "/cy/doctors", tip: "Ποιοι γιατροί συνταγογραφούν στους πελάτες σου και τι αξία φέρνουν.", tip_en: "Which doctors prescribe for your customers and what value they bring." },
    { section: EXEC, label: "Οικογένειες", en: "Families", icon: Users, href: "/patients/families", tip: "Οικογένειες πελατών: τι πήρε και τι εκκρεμεί για κάθε μέλος, σε μία οθόνη.", tip_en: "Customer families: what each member got and what is pending, on one screen.", module: "family_groups" },
    { section: EXEC, label: "Δομές φροντίδας", en: "Care structures", icon: Home, href: "/care", module: "care_homes", tip: "Γηροκομεία και δομές: τι ανοίγει για κάθε τρόφιμο, οδηγίες λήψης και λογαριασμός συμμετοχών.", tip_en: "Care homes: what is due for each resident, intake instructions and the copay account." },
    { section: EXEC, label: "Κερδοφορία", en: "Profitability", icon: TrendingUp, href: "/cy/profitability", module: "profitability", tip: "Κέρδος ανά σκεύασμα: έσοδα χωρίς ΦΠΑ μείον χονδρική από την Αποθήκη.", tip_en: "Profit per product: revenue excl. VAT minus wholesale from the Warehouse." },
    { section: EXEC, label: "Υπάλληλοι", en: "Staff", icon: Users, href: "/cy/staff", tip: "Εκτελέσεις ανά χρήστη της πύλης ΓεΣΥ.", tip_en: "Dispensings per GHS portal user." },
    ...pickFrom(["Διαχείριση φαρμακείου"]),
  ] },
  // Copilot & Ρουτίνες: ίδιες οθόνες, εργαλεία δεδομένων ΓεΣΥ (backend services/cy/copilot.py)
  { title: "AI σύμβουλοι", en: "AI advisors", icon: Sparkles, items: [
    { label: "AI σύμβουλος", en: "AI Assistant", icon: Bot, module: "ai_assistant", children: [
      { href: "/copilot", label: "Συνομιλία", en: "Chat", tip: "Ρώτα για εκτελέσεις, γιατρούς, φάσεις, παραγγελία — απαντά με τα δικά σου δεδομένα ΓεΣΥ.", tip_en: "Ask about dispensings, doctors, steps, ordering — answered from your own GHS data." },
      { href: "/copilot/routines", label: "Ρουτίνες", en: "Routines", tip: "Αναφορές ή μηνύματα που φεύγουν μόνα τους σε πρόγραμμα.", tip_en: "Reports or messages sent on a schedule." },
    ] },
  ] },
  { title: "Marketing", en: "Marketing", icon: Megaphone, items: [
    // ΙΔΙΕΣ οθόνες με την Ελλάδα, δεδομένα ΓεΣΥ (backend services/cy/marketing.py)
    { label: "Dashboard", en: "Dashboard", icon: Megaphone, href: "/marketing", module: "marketing", tip: "Τι έστειλες, σε πόσους, και έτοιμες προτάσεις: ποιους να θυμίσεις, ποιους να φροντίσεις, ποιους να φέρεις πίσω.", tip_en: "What you sent, to how many, and ready suggestions: whom to remind, care for, or win back." },
    { label: "Θεραπευτικές κατηγορίες", en: "Therapeutic categories", icon: Target, href: "/marketing/categories", module: "marketing", tip: "Πόσοι πελάτες σου ανά θεραπεία (διαβήτης, πίεση, χοληστερίνη…), από τα φάρμακα που παίρνουν.", tip_en: "How many customers per therapy (diabetes, blood pressure, cholesterol…), from the medicines they take." },
    { label: "Καμπάνιες", en: "Campaigns", icon: Mail, href: "/cy/campaigns", tip: "Στείλε SMS, Viber, email ή ειδοποίηση πύλης σε μια ομάδα πελατών, μόνο σε όσους έδωσαν συγκατάθεση.", tip_en: "Send SMS, Viber, email or a portal notification to a group of customers, only to those who consented." },
    { label: "Αυτοματοποιημένες", en: "Automated", icon: RefreshCw, href: "/communications/automations", tip: "Μηνύματα που φεύγουν μόνα τους τη σωστή στιγμή για τον καθένα.", tip_en: "Messages sent automatically at the right moment for each customer." },
    { label: "Ημερολόγιο", en: "Calendar", icon: CalendarClock, href: "/communications/calendar", tip: "Πόσα μηνύματα στέλνεις και πότε — για να μην κουράζεις τους πελάτες σου.", tip_en: "How many messages you send and when — so you don't tire your customers." },
    ...pickFrom(["Marketing"]),
  ] },
  { title: "Πύλη πελατών & Πιστότητα", en: "Portal & Loyalty", icon: Heart, items: pickFrom(["Πύλη πελατών & Πιστότητα"]) },
  { title: "Ηλεκτρονικό κατάστημα", en: "e-shop", icon: ShoppingBag, items: pickFrom(["Ηλεκτρονικό κατάστημα"]) },
  ...NAV_GROUPS.filter((g) => SHARED_FOR_CY.has(g.title)).map((g) => g.title === "Βοήθεια"
    // ο «Οδηγός δεικτών» εξηγεί ελληνικούς δείκτες (ΕΟΠΥΥ) → όχι στην Κύπρο
    ? { ...g, items: g.items.filter((n) => n.href !== "/guide") }
    : g.title !== "Ρυθμίσεις" ? g : {
    ...g, items: g.items.map((n) => ({ ...n,
      tip: "Χρήστες, ρόλοι, ωράριο, μηνύματα, χρέωση και GDPR.",
      tip_en: "Users, roles, opening hours, messaging, billing and GDPR." })) }),
];
