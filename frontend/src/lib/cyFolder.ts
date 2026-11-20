/* RxVision Κύπρος: «Τοπικός φάκελος» — ο 3ος τρόπος εισαγωγής XML (μετά το ανέβασμα και την PharmacyOne).
 *
 * Ο φαρμακοποιός δείχνει ΜΙΑ φορά τον φάκελο του υπολογιστή όπου κατεβαίνουν τα XML του ΓεΣΥ. Όσο το
 * RxVision είναι ανοιχτό (Chrome/Edge), κάθε λίγα λεπτά ανεβαίνουν ΜΟΝΟ τα νέα αρχεία, στο ΙΔΙΟ
 * endpoint με το χειροκίνητο ανέβασμα (/cy/import): ίδιος έλεγχος φαρμακείου, καμία διπλή μέτρηση.
 *
 * Χωρίς εγκατάσταση: File System Access API. Ο browser θυμάται τον φάκελο (IndexedDB), αλλά μετά από
 * επανεκκίνηση ζητά ξανά ένα κλικ άδειας — αυτό είναι κανόνας ασφαλείας του browser, όχι δικός μας.
 * Τίποτα δεν διαβάζεται εκτός από αρχεία .xml / .zip του φακέλου (και υποφακέλων έως 3 επίπεδα). */

import { apiUpload } from "@/lib/apiClient";

type Perm = "granted" | "denied" | "prompt";
export interface DirHandle {
  kind: "directory"; name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission(o: { mode: "read" }): Promise<Perm>;
  requestPermission(o: { mode: "read" }): Promise<Perm>;
}
interface FileHandle { kind: "file"; name: string; getFile(): Promise<File> }

const DB = "rx-cy-folder", STORE = "kv";
const BATCH = 40;
export const SCAN_EVERY_MS = 10 * 60 * 1000;

export const folderSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    };
  });
}
const get = <T,>(k: string) => idb<T>("readonly", (s) => s.get(k)).catch(() => undefined);
const put = (k: string, v: unknown) => idb("readwrite", (s) => s.put(v, k)).catch(() => undefined);
const del = (k: string) => idb("readwrite", (s) => s.delete(k)).catch(() => undefined);

// Κλειδιά ανά φαρμακείο: ο ίδιος υπολογιστής μπορεί να εξυπηρετεί δύο φαρμακεία (δίκτυο).
const kHandle = (tid: string) => `handle:${tid}`;
const kSeen = (tid: string) => `seen:${tid}`;
const kLast = (tid: string) => `last:${tid}`;

export type FolderState = { name: string; perm: Perm; last?: { at: string; uploaded: number; imported: number; failed: number } };

export async function folderState(tid: string): Promise<FolderState | null> {
  const h = await get<DirHandle>(kHandle(tid));
  if (!h) return null;
  let perm: Perm = "prompt";
  try { perm = await h.queryPermission({ mode: "read" }); } catch { /* ο browser το ξέχασε */ }
  return { name: h.name, perm, last: await get(kLast(tid)) };
}

export async function pickFolder(tid: string): Promise<FolderState | null> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: "read" }) => Promise<DirHandle> }).showDirectoryPicker;
  const h = await picker({ mode: "read" });
  await put(kHandle(tid), h);
  await put(kSeen(tid), {});          // νέος φάκελος → τα αρχεία του ελέγχονται από την αρχή (ο server αγνοεί διπλά)
  return folderState(tid);
}

export async function resumeFolder(tid: string): Promise<boolean> {
  const h = await get<DirHandle>(kHandle(tid));
  return !!h && (await h.requestPermission({ mode: "read" })) === "granted";
}

export async function forgetFolder(tid: string) {
  await del(kHandle(tid)); await del(kSeen(tid)); await del(kLast(tid));
}

async function* walk(dir: DirHandle, depth = 0): AsyncGenerator<File> {
  for await (const e of dir.values()) {
    if (e.kind === "file" && /\.(xml|zip)$/i.test(e.name)) yield await e.getFile();
    else if (e.kind === "directory" && depth < 3) yield* walk(e, depth + 1);
  }
}

type ImportRes = { imported: number; failed: number };

/** Ανεβάζει ό,τι νέο υπάρχει στον φάκελο. Επιστρέφει null αν δεν υπάρχει φάκελος ή άδεια. */
export async function scanFolder(tid: string): Promise<FolderState["last"] | null> {
  const h = await get<DirHandle>(kHandle(tid));
  if (!h || (await h.queryPermission({ mode: "read" })) !== "granted") return null;
  const seen = (await get<Record<string, 1>>(kSeen(tid))) || {};
  const fresh: { key: string; file: File }[] = [];
  for await (const f of walk(h)) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (!seen[key]) fresh.push({ key, file: f });
  }
  let imported = 0, failed = 0;
  for (let i = 0; i < fresh.length; i += BATCH) {
    const part = fresh.slice(i, i + BATCH);
    const form = new FormData();
    part.forEach((x) => form.append("files", x.file));
    const r = await apiUpload<ImportRes>("/cy/import", form);   // σφάλμα δικτύου → σταματά, ξαναδοκιμάζει στην επόμενη σάρωση
    imported += r.imported; failed += r.failed;
    // Και τα απορριφθέντα σημειώνονται: ένα αρχείο άλλου φαρμακείου δεν θα γίνει ποτέ δεκτό —
    // δεν το ξαναστέλνουμε κάθε 10 λεπτά.
    part.forEach((x) => { seen[x.key] = 1; });
    await put(kSeen(tid), seen);
  }
  const last = { at: new Date().toISOString(), uploaded: fresh.length, imported, failed };
  await put(kLast(tid), last);
  return last;
}
