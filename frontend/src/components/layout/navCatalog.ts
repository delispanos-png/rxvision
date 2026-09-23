/** Ο ΚΑΤΑΛΟΓΟΣ ΤΟΥ ΜΕΝΟΥ — ΜΙΑ λίστα, δύο καταναλωτές: το ίδιο το μενού (Sidebar) και η
 *  οθόνη «Μενού ανά ρόλο». Χωρίς αυτό θα υπήρχαν δύο λίστες που αποκλίνουν με τον καιρό.
 *  Τα κλειδιά που αποθηκεύονται στον server είναι τα `title` των ομάδων. */

import {
  Activity, BarChart3, Boxes, Warehouse, Layers, CalendarClock, ChevronRight, LayoutDashboard,
  Mail, Megaphone, Salad, PackageSearch, Settings, Sparkles, Stethoscope, TrendingUp, Target, Users,
  Brain, ShieldCheck, Tags, Syringe, Bot, Gift, BookOpen, ScrollText, Truck, Lock, X, UserPlus, Ticket, SlidersHorizontal, Heart, FileText, MessageSquare, PackageCheck, Receipt, ArrowRightLeft, Compass, type LucideIcon, RefreshCw } from "lucide-react";

// A leaf (direct link). `module` gates visibility (shown only when enabled/trial).
export type Leaf = { href: string; label: string; en: string; module?: string | string[] };
// A node is either a direct link (href) or an expandable parent (children).
export type Node = { label: string; en: string; icon: LucideIcon; href?: string; module?: string | string[]; children?: Leaf[] };
export type Group = { title: string; en: string; icon: LucideIcon; items: Node[] };
export type Me = { modules?: Record<string, "enabled" | "trial" | "locked"> };

export const NAV_GROUPS: Group[] = [
  // Ο Σύμβουλος — ξεχωριστό κύκλωμα που αγοράζεται ως extra (module `daily_coach`,
  // σε ΚΑΝΕΝΑ πακέτο). Πρώτο στο μενού: είναι η οθόνη που ανοίγεις το πρωί.
  { title: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, items: [
    { label: "Ο Σύμβουλός σου", en: "Your Advisor", icon: Compass, href: "/coach", module: "daily_coach" },
  ] },
  { title: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, items: [
    { label: "Patient Intelligence", en: "Patient Intelligence", icon: Brain, href: "/intelligence", module: "patient_analytics" },
  ] },
  { title: "Ανάλυση", en: "Analysis", icon: BarChart3, items: [
    { label: "Dashboard", en: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    { label: "Συνταγές", en: "Prescriptions", icon: BarChart3, module: "prescription_analytics", children: [
      { href: "/prescriptions", label: "Λίστα", en: "List" },
      { href: "/rx-types", label: "Δείκτες", en: "Indicators" },
    ] },
    // Φαίνεται με ΟΠΟΙΟΔΗΠΟΤΕ από τα τρία: ένα πληρωμένο add-on δεν επιτρέπεται να μένει αόρατο
    // επειδή λείπει ΑΛΛΟ module. Όποιος αγόρασε «Θεραπείες με Επανάληψη» πρέπει να το βρίσκει.
    { label: "Κύκλωμα Εμβολιασμών", en: "Vaccinations", icon: Syringe, href: "/vaccinations",
      module: ["prescription_analytics", "vaccination_programs"] },
    // Δικό του κύκλωμα, δική του γλώσσα: όποιος παρακολουθεί Prolia δεν πρέπει να διαβάζει
    // πουθενά τη λέξη «εμβόλιο». Ο μηχανισμός από κάτω είναι ο ίδιος.
    { label: "Θεραπείες με Επανάληψη", en: "Repeat Therapies", icon: RefreshCw, href: "/therapies",
      module: "therapy_programs" },
    { label: "Μελλοντικές", en: "Upcoming", icon: CalendarClock, module: "future_prescriptions", children: [
      { href: "/future#coverage", label: "Κάλυψη περιόδου", en: "Period coverage" },
      { href: "/future#forecast", label: "Πρόβλεψη κάλυψης", en: "Coverage forecast" },
    ] },
    { label: "Ασφαλισμένοι", en: "Patients", icon: Users,
      module: ["patient_analytics", "advance_dispensing"], children: [
      { href: "/patients#list", label: "Λίστα", en: "List" },
      { href: "/patients#kpi", label: "Δείκτες", en: "Indicators" },
      { href: "/patients/verify-contacts", label: "Επιβεβαίωση στοιχείων", en: "Confirm contacts" },
      { href: "/patients/deceased", label: "Θανόντες & υπόλοιπα", en: "Deceased & balances" },
      { href: "/patients/advance", label: "Προχορηγήσεις (δανεικά)", en: "Advance dispensings",
        module: "advance_dispensing" },
    ] },
    { label: "Ιατροί", en: "Doctors", icon: Stethoscope, module: "doctor_analytics", children: [
      { href: "/doctors#list", label: "Λίστα", en: "List" },
      { href: "/doctors#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
    { label: "ICD-10", en: "ICD-10", icon: Activity, module: "icd10_analytics", children: [
      { href: "/icd10#list", label: "Λίστα", en: "List" },
      { href: "/icd10#kpi", label: "Δείκτες", en: "Indicators" },
    ] },
  ] },
  { title: "Σύμβουλοι", en: "Advisors", icon: Stethoscope, items: [
    { label: "Επιχειρησιακά", en: "Business", icon: Sparkles, href: "/advisor" },
    { label: "Παραγγελία", en: "Ordering", icon: PackageSearch, module: "order_suggestions", children: [
      { href: "/orders", label: "βάσει εκτελέσεων", en: "by executions" },
      { href: "/order-advisor", label: "βάσει πρόβλεψης", en: "by forecast" },
    ] },
    { label: "AI σύμβουλος", en: "AI Assistant", icon: Bot, module: "ai_assistant", children: [
      { href: "/copilot", label: "Συνομιλία", en: "Chat" },
      { href: "/copilot/routines", label: "Ρουτίνες", en: "Routines" },
    ] },
    { label: "Διατροφή", en: "Nutrition", icon: Salad, href: "/nutrition", module: ["nutrition", "ai_assistant"] },
    { label: "Κερδοφορία", en: "Profitability", icon: TrendingUp, href: "/profitability", module: "profitability" },
  ] },
  // eShop — όλα τα κυκλώματα του ηλεκτρονικού καταστήματος (κατάλογος, παραγγελίες, προσφορές, πιστότητα, πύλη).
  { title: "eShop", en: "eShop", icon: PackageSearch, items: [
    { label: "Προϊόντα", en: "Products", icon: Boxes, href: "/warehouse", module: "order_delivery" },
    { label: "Κατηγορίες e-shop", en: "e-shop Categories", icon: Layers, href: "/eshop-categories", module: "order_delivery" },
    { label: "Προσφορές", en: "Promotions", icon: Tags, href: "/eshop-offers", module: "order_delivery" },
    { label: "Ενεργές παραγγελίες", en: "Active orders", icon: Truck, href: "/orders-delivery#orders", module: "order_delivery" },
    { label: "Ολοκληρωμένες", en: "Completed", icon: PackageCheck, href: "/orders-delivery#done", module: "order_delivery" },
    { label: "Ρυθμίσεις αποστολής", en: "Delivery settings", icon: SlidersHorizontal, href: "/orders-delivery#settings", module: "order_delivery" },
    { label: "Προμήθειες συναλλαγών", en: "Transaction fees", icon: Receipt, href: "/eshop-fees", module: "order_delivery" },
  ] },
  // Πύλη πελατών — δικό της κύκλωμα· κάθε εσωτερική καρτέλα = αυτόνομο entry (URL hash).
  { title: "Πύλη πελατών", en: "Customer Portal", icon: Users, items: [
    { label: "Πελάτες πύλης", en: "Portal customers", icon: Heart, href: "/portal-admin#customers", module: "patient_portal" },
    { label: "Αιτήματα συνταγών", en: "Rx requests", icon: FileText, href: "/portal-admin#rx", module: "patient_portal" },
    { label: "Διαθεσιμότητα", en: "Availability", icon: MessageSquare, href: "/portal-admin#availability", module: "patient_portal" },
    { label: "Ραντεβού", en: "Appointments", icon: CalendarClock, href: "/portal-admin#appointments", module: "patient_portal" },
    { label: "Υπηρεσίες", en: "Services", icon: Stethoscope, href: "/portal-admin#services", module: "patient_portal" },
    { label: "Μεταφορά πελάτη", en: "Patient transfer", icon: ArrowRightLeft, href: "/patients/transfers", module: "patient_analytics" },
  ] },
  // Κάρτες πιστότητας — δικό του κύκλωμα· κάθε καρτέλα του προγράμματος = αυτόνομο entry (URL hash).
  { title: "Κάρτες πιστότητας", en: "Loyalty Cards", icon: Gift, items: [
    { label: "Μέλη", en: "Members", icon: Users, href: "/loyalty#members", module: "loyalty" },
    { label: "Εγγραφή", en: "Enrol", icon: UserPlus, href: "/loyalty#enroll", module: "loyalty" },
    { label: "Εξαργυρώσεις", en: "Redemptions", icon: Ticket, href: "/loyalty#redemptions", module: "loyalty" },
    { label: "Δώρα & εξαργυρώσεις", en: "Rewards", icon: Gift, href: "/loyalty#rewards", module: "loyalty" },
    { label: "Ρυθμίσεις προγράμματος", en: "Program settings", icon: SlidersHorizontal, href: "/loyalty#settings", module: "loyalty" },
  ] },
  // Στοχευμένη Προώθηση — δικό του εμπορικό κύκλωμα (module `marketing`, ενεργό ανά συνδρομή).
  { title: "Προώθηση", en: "Marketing", icon: Megaphone, items: [
    { label: "Πίνακας", en: "Dashboard", icon: Megaphone, href: "/marketing", module: "marketing" },
    { label: "Θεραπευτικές κατηγορίες", en: "Therapeutic categories", icon: Target, href: "/marketing/categories", module: "marketing" },
    { label: "Επικοινωνία", en: "Communications", icon: Mail, module: "patient_analytics", children: [
      { href: "/communications", label: "Νέο μήνυμα", en: "New message" },
      { href: "/communications/audiences", label: "Ομάδες ανθρώπων", en: "Audiences" },
      { href: "/communications/automations", label: "Αυτόματα μηνύματα", en: "Automations" },
      { href: "/communications/calendar", label: "Ημερολόγιο", en: "Calendar" },
    ] },
    { label: "Κουπόνια", en: "Coupons", icon: Ticket, href: "/marketing/coupons", module: "marketing" },
  ] },
  // «Έλεγχος συνταγών» = ΑΝΕΞΑΡΤΗΤΗ top-level επιλογή (single-item group → αποδίδεται ως απευθείας link).
  { title: "Έλεγχος συνταγών", en: "Rx Audit", icon: ShieldCheck, items: [
    { label: "Έλεγχος συνταγών", en: "Rx Audit", icon: ShieldCheck, href: "/reimbursement", module: "monthly_closing" },
  ] },
  { title: "Λειτουργίες", en: "Operations", icon: SlidersHorizontal, items: [
    // PharmacyOne is a back-office INTEGRATION (data source), not a user-facing capability → not in the menu.
    { label: "Οδηγός δεικτών", en: "Indicators guide", icon: BookOpen, href: "/guide" },
    { label: "Όροι Χρήσης", en: "Terms of Use", icon: ScrollText, href: "/terms-of-use" },
    { label: "GDPR", en: "GDPR", icon: Lock, href: "/gdpr" },
    { label: "Ρυθμίσεις", en: "Settings", icon: Settings, href: "/settings/users" },
  ] },
];
