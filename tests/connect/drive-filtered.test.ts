import { GoogleDriveSource, NeurosaIngest } from "@neurosa/ingest";
import type { NeurosaConnect } from "@neurosa/connect";

const folder = "drive-test-folder";
const modifiedTime = "2026-10-19T00:00:00.000Z";
const files = [
  {
    id: "safe-file",
    name: "memory.md",
    mimeType: "text/plain",
    version: "1",
    modifiedTime,
    size: "21",
  },
  {
    id: "financial-file",
    name: "financial.txt",
    mimeType: "text/plain",
    version: "1",
    modifiedTime,
    size: "25",
  },
  {
    id: "oversized-file",
    name: "archive.zip",
    mimeType: "application/zip",
    version: "1",
    modifiedTime,
    size: String(6 * 1024 * 1024 * 1024),
  },
];

function fakeDrive() {
  const requested: string[] = [];
  const writes: { title: string; content: string; source: unknown }[] = [];
  const fetcher: typeof fetch = (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requested.push(url.toString());
    if (url.pathname.endsWith("/files")) return Promise.resolve(Response.json({ files }));
    if (url.searchParams.get("alt") === "media") {
      if (url.pathname.endsWith("/safe-file")) return Promise.resolve(new Response("Approved knowledge only"));
      if (url.pathname.endsWith("/financial-file"))
        return Promise.resolve(new Response("Private financial records"));
    }
    const file = files.find((x) => url.pathname.endsWith("/" + x.id));
    if (file) return Promise.resolve(Response.json(file));
    throw new Error("Unexpected Google Drive request: " + url.pathname);
  };
  const client = {
    observe: (input: { title: string; content: string; source: unknown }) => {
      writes.push(input);
      return Promise.resolve({ status: "ZAPAMIĘTANO" });
    },
  } as unknown as NeurosaConnect;
  return {
    drive: new GoogleDriveSource(() => Promise.resolve("read-only-test-token"), fetcher),
    ingest: new NeurosaIngest(client),
    requested,
    writes,
  };
}

describe("Drive → NeurOSA filtered manifest and selected import", () => {
  it("plans metadata without downloading source content or writing memory", async () => {
    const source = fakeDrive();
    const manifest = await source.drive.inspect(folder);
    expect(manifest.complete).toBe(true);
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries.find((e) => e.id === "oversized-file")?.eligible).toBe(false);
    expect(
      source.requested.every((url) => !url.includes("alt=media") && !url.includes("/export")),
    ).toBe(true);
    expect(source.writes).toHaveLength(0);
  });

  it("imports only explicitly approved files, never the rest of the folder", async () => {
    const source = fakeDrive();
    const result = await source.drive.syncSelected(folder, source.ingest, ["safe-file"]);
    expect(result.complete).toBe(true);
    expect(result.imported).toEqual(["safe-file"]);
    expect(result.skipped.some((e) => e.id === "financial-file")).toBe(true);
    expect(source.writes).toHaveLength(1);
    expect(source.writes[0]?.content).toBe("Approved knowledge only");
    expect(source.requested.some((u) => u.includes("/financial-file?alt=media"))).toBe(false);
  });

  it("refuses empty selection, files outside folder and oversized selections", async () => {
    const source = fakeDrive();
    await expect(source.drive.syncSelected(folder, source.ingest, [])).rejects.toThrow("Wybierz");
    const missing = await source.drive.syncSelected(folder, source.ingest, ["different-file"]);
    expect(missing.complete).toBe(false);
    expect(missing.failed.some((f) => f.id === "different-file")).toBe(true);
    const rejected = await source.drive.syncSelected(folder, source.ingest, ["oversized-file"]);
    expect(rejected.complete).toBe(false);
    expect(rejected.failed.some((f) => f.id === "oversized-file")).toBe(true);
    expect(source.writes).toHaveLength(0);
  });
});
