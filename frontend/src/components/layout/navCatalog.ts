/** Ο ΚΑΤΑΛΟΓΟΣ ΤΟΥ ΜΕΝΟΥ — ΜΙΑ λίστα, δύο καταναλωτές: το ίδιο το μενού (Sidebar) και η
 *  οθόνη «Μενού ανά ρόλο». Χωρίς αυτό θα υπήρχαν δύο λίστες που αποκλίνουν με τον καιρό.
 *  Τα κλειδιά που αποθηκεύονται στον server είναι τα `title` των ομάδων.
 *  Δομή = το μενού του ιδιοκτήτη (22/10/2026, «RxVision menu.xlsx»). */

import {
  Activity, BarChart3, Boxes, CalendarClock, LayoutDashboard, Mail, Megaphone, Salad, PackageSearch,
  Settings, Sparkles, Stethoscope, TrendingUp, Target, Users, Brain, ShieldCheck, Tags, Syringe, Bot,
  Gift, BookOpen, ScrollText, Truck, Lock, UserPlus, Ticket, SlidersHorizontal, Heart, FileText,
  MessageSquare, PackageCheck, ArrowRightLeft, Compass, Handshake, Home, Inbox, Send, RefreshCw,
  Store, LifeBuoy, ShoppingBag, Building2, Eye, type LucideIcon } from "lucide-react";

// A leaf (direct link). `module` gates visibility (shown only when enabled/trial).
export type Leaf = { href: string; label: string; en: string; module?: string | string[] };
/** A node is either a direct link (href) or an expandable parent (children).
 *  `section`: ενδιάμεσο, πτυσσόμενο επίπεδο ΜΕΣΑ στην ομάδα (π.χ. «Ανάλυση εκτελέσεων» στη
 *  «Διαχείριση φαρμακείου»). Συνεχόμενοι κόμβοι με την ίδια `section` εμφανίζονται κάτω από αυτήν. */
export type Node = { label: string; en: string; icon: LucideIcon; href?: string; module?: string | string[];
  children?: Leaf[]; section?: { label: string; en: string } };
export type Group = { title: string; en: string; icon: LucideIcon; items: Node[] };
export type Me = { modules?: Record<string, "enabled" | "trial" | "locked"> };

const EXEC = { label: "Ανάλυση εκτελέσεων", en: "Execution analysis" };

export const NAV_GROUPS: Group[] = [
  // Ο Σύμβουλος — ξεχωριστό κύκλωμα που αγοράζεται ως extra (module `daily_coach`,
  // σε ΚΑΝΕΝΑ πακέτο). Πρώτο στο μενού: είναι η οθόνη που ανοίγεις το πρωί.
  { title: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, items: [
    { label: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, href: "/coach", module: "daily_coach" },
  ] },
  // Ό,τι χρειάζεται ο φαρμακοποιός με τον πελάτη ΜΠΡΟΣΤΑ του.
  { title: "Εξυπηρέτηση πάγκου", en: "Counter service", icon: Store, items: [
    { label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, href: "/intelligence", module: "patient_analytics" },
    { label: "Προχορηγήσεις", en: "Advance dispensings", icon: ArrowRightLeft, href: "/patients/advance", module: "advance_dispensing" },
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
    { label: "Ομάδες πελατών", en: "Customer groups", icon: Users, href: "/communications/audiences", module: "patient_analytics" },
    { label: "Καμπάνιες", en: "Campaigns", icon: Mail, module: "patient_analytics", children: [
      { href: "/communications", label: "Νέα καμπάνια", en: "New campaign" },
      { href: "/communications/automations", label: "Αυτοματοποιημένες", en: "Automated" },
      { href: "/communications/calendar", label: "Ημερολόγιο", en: "Calendar" },
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
    { label: "Πελάτες πύλης", en: "Portal customers", icon: Heart, href: "/portal-admin#customers", module: "patient_portal" },
    { label: "Συνταγές", en: "Rx requests", icon: FileText, href: "/portal-admin#rx", module: "patient_portal" },
    { label: "Διαθεσιμότητα", en: "Availability", icon: MessageSquare, href: "/portal-admin#availability", module: "patient_portal" },
    { label: "Ραντεβού", en: "Appointments", icon: CalendarClock, href: "/portal-admin#appointments", module: "patient_portal" },
    { label: "Μεταφορά πελάτη", en: "Patient transfer", icon: ArrowRightLeft, href: "/patients/transfers", module: "patient_analytics" },
    // ΠΡΟΣΩΡΙΝΗ θέση — δεν υπάρχει στο Excel (22/10/2026), περιμένει απόφαση ιδιοκτήτη
    { label: "Ποιος βλέπει ποιον", en: "Who sees whom", icon: Eye, href: "/patients/access", module: "patient_portal" },
    { label: "Μέλη πιστότητας", en: "Loyalty members", icon: Users, href: "/loyalty#members", module: "loyalty" },
    // ΠΡΟΣΩΡΙΝΗ θέση — δεν υπάρχει στο Excel· η σελίδα δεν έχει άλλη είσοδο προς αυτή την καρτέλα
    { label: "Εγγραφή μέλους", en: "Enrol member", icon: UserPlus, href: "/loyalty#enroll", module: "loyalty" },
    { label: "Εξαργυρώσεις", en: "Redemptions", icon: Ticket, href: "/loyalty#redemptions", module: "loyalty" },
    { label: "Ρυθμίσεις", en: "Settings", icon: SlidersHorizontal, module: ["patient_portal", "loyalty"], children: [
      { href: "/portal-admin#services", label: "Υπηρεσίες", en: "Services", module: "patient_portal" },
      { href: "/loyalty#rewards", label: "Δώρα και εξαργυρώσεις", en: "Rewards", module: "loyalty" },
      { href: "/loyalty#settings", label: "Πρόγραμμα πιστότητας", en: "Loyalty program", module: "loyalty" },
    ] },
  ] },
  { title: "Ηλεκτρονικό κατάστημα", en: "e-shop", icon: ShoppingBag, items: [
    { label: "Ενεργές παραγγελίες", en: "Active orders", icon: Truck, href: "/orders-delivery#orders", module: "order_delivery" },
    { label: "Ολοκληρωμένες", en: "Completed", icon: PackageCheck, href: "/orders-delivery#done", module: "order_delivery" },
    { label: "Προσφορές", en: "Promotions", icon: Tags, href: "/eshop-offers", module: "order_delivery" },
    { label: "Ρυθμίσεις", en: "Settings", icon: SlidersHorizontal, module: "order_delivery", children: [
      { href: "/eshop-categories", label: "Κατηγορίες e-shop", en: "e-shop categories" },
      { href: "/orders-delivery#settings", label: "Ρυθμίσεις αποστολής", en: "Delivery settings" },
      { href: "/eshop-fees", label: "Προμήθειες συναλλαγών", en: "Transaction fees" },
    ] },
  ] },
  { title: "Διαχείριση φαρμακείου", en: "Pharmacy management", icon: Building2, items: [
    { section: EXEC, label: "Dashboard", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    // Τα ΙΔΙΑ modules με πριν: όποιος έβλεπε τη λίστα ασθενών δεν τη χάνει με την αναδιάταξη.
    { section: EXEC, label: "Ασφαλισμένοι", en: "Patients", icon: Users,
      module: ["patient_analytics", "advance_dispensing", "family_groups", "patient_portal"], children: [
      { href: "/patients#list", label: "Λίστα", en: "List" },
      { href: "/patients#kpi", label: "Δείκτες", en: "Indicators" },
      { href: "/patients/deceased", label: "Θανόντες και εκκρεμότητες", en: "Deceased & balances" },
      { href: "/patients/verify-contacts", label: "Επιβεβαίωση στοιχείων", en: "Confirm contacts" },
    ] },
    { section: EXEC, label: "Οικογένειες", en: "Families", icon: Users, href: "/patients/families", module: "family_groups" },
    { section: EXEC, label: "Δομές φροντίδας", en: "Care structures", icon: Home, href: "/care", module: "care_homes" },
    { section: EXEC, label: "Ιατροί", en: "Doctors", icon: Stethoscope, module: "doctor_analytics", children: [
      { href: "/doctors#list", label: "Λίστα", en: "List" },
      { href: "/doctors#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
    { section: EXEC, label: "Διαγνώσεις", en: "Diagnoses", icon: Activity, module: "icd10_analytics", children: [
      { href: "/icd10#list", label: "Λίστα", en: "List" },
      { href: "/icd10#kpi", label: "Δείκτες", en: "Indicators" },
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
    { label: "Πίνακας", en: "Dashboard", icon: Handshake, href: "/connect#dashboard", module: "connect" },
    { label: "Αιτήματα δικτύου", en: "Network requests", icon: Inbox, href: "/connect#inbox", module: "connect" },
    { label: "Τα αιτήματά μου", en: "My requests", icon: Send, href: "/connect#requests", module: "connect" },
    { label: "Κινήσεις και υπόλοιπα", en: "Movements & balances", icon: ArrowRightLeft, href: "/connect#movements", module: "connect" },
    { label: "Τα δίκτυά μου", en: "My networks", icon: Users, href: "/connect#networks", module: "connect" },
    { label: "Πόσο διαθέτω", en: "Availability policy", icon: SlidersHorizontal, href: "/connect#settings", module: "connect" },
  ] },
  // Μονές επιλογές (ομάδα με ΕΝΑ φύλλο → απευθείας link στο μενού). PharmaCat και Chat ΔΕΝ
  // μπαίνουν στο μενού (απόφαση ιδιοκτήτη 22/10/2026) — ανοίγουν από την πάνω μπάρα.
  { title: "Ρυθμίσεις", en: "Settings", icon: Settings, items: [
    { label: "Ρυθμίσεις", en: "Settings", icon: Settings, href: "/settings/users" },
  ] },
  { title: "Βοήθεια", en: "Help", icon: LifeBuoy, items: [
    // PharmacyOne is a back-office INTEGRATION (data source), not a user-facing capability → not in the menu.
    { label: "Εγχειρίδιο χρήσης", en: "User manual", icon: FileText, href: "/manual" },
    { label: "Οδηγός δεικτών", en: "Indicators guide", icon: BookOpen, href: "/guide" },
    { label: "Όροι χρήσης", en: "Terms of Use", icon: ScrollText, href: "/terms-of-use" },
    { label: "GDPR", en: "GDPR", icon: Lock, href: "/gdpr" },
  ] },
];
