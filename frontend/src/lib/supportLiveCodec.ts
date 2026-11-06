// Ζωντανή υποστήριξη: τα γεγονότα οθόνης ταξιδεύουν συμπιεσμένα, αλλιώς μια σελίδα με μεγάλο πίνακα
// ξεπερνά το όριο αιτήματος. Ο server δεν τα διαβάζει, μόνο τα κρυπτογραφεί και τα προωθεί.

export async function packEvents(events: unknown[]): Promise<string> {
  const stream = new Blob([JSON.stringify(events)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(out);
}

export async function unpackEvents<T>(data: string): Promise<T[]> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as T[];
}
