/** Appel direct d'une route d'API Next en multipart, comme le navigateur l'envoie (Content-Length compris). */
import { NextRequest } from "next/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function postForm(route: string, query: string, files: [Buffer, string][], fields: Record<string, string> = {}, acceptLanguage = "fr"): Promise<{ status: number; json: any }> {
  const mod = await import(`../../app/api/${route}/route`);
  const url = `http://cortex.test/api/${route}?${query}`;
  const form = new FormData();
  for (const [data, name] of files) form.append("file", new Blob([new Uint8Array(data)]), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const encoded = new Request(url, { method: "POST", body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers = new Headers(encoded.headers);
  headers.set("content-length", String(body.length));
  headers.set("accept-language", acceptLanguage);
  const res: Response = await mod.POST(new NextRequest(url, { method: "POST", headers, body }));
  return { status: res.status, json: await res.json() };
}
