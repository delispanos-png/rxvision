// bwip-js v4 εκθέτει types μέσω exports map που το tsconfig (moduleResolution: node) δεν
// επιλύει· χρησιμοποιείται μόνο client-side μέσω dynamic import → αρκεί η δήλωση module.
declare module "bwip-js";
