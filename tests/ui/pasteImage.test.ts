import { describe, expect, it } from "vitest";
import { imageFromPaste } from "../../src/ui/pasteImage";

function items(...list: Array<{ kind: string; type: string; file?: File }>) {
  return {
    items: Object.assign(
      list.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
      {},
    ),
  } as unknown as DataTransfer;
}

const png = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });

describe("imageFromPaste", () => {
  it("takes a pasted picture and gives it a unique name", () => {
    const f = imageFromPaste(items({ kind: "file", type: "image/png", file: png }), Date.UTC(2026, 9, 26, 12, 0, 0));
    expect(f).not.toBeNull();
    expect(f!.type).toBe("image/png");
    expect(f!.name).toBe("paste-2026-10-26T12-00-00-000Z.png");
    expect(f!.size).toBe(3);
  });

  it("leaves a plain text paste to the text field", () => {
    expect(imageFromPaste(items({ kind: "string", type: "text/plain" }))).toBeNull();
  });

  it("ignores SVG (it can carry scripts) and other non-raster types", () => {
    const svg = new File(["<svg/>"], "a.svg", { type: "image/svg+xml" });
    expect(imageFromPaste(items({ kind: "file", type: "image/svg+xml", file: svg }))).toBeNull();
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    expect(imageFromPaste(items({ kind: "file", type: "application/pdf", file: pdf }))).toBeNull();
  });

  it("skips empty files and picks the first usable picture", () => {
    const empty = new File([], "e.png", { type: "image/png" });
    const jpg = new File([new Uint8Array([9])], "x.jpg", { type: "image/jpeg" });
    const f = imageFromPaste(items({ kind: "file", type: "image/png", file: empty }, { kind: "file", type: "image/jpeg", file: jpg }));
    expect(f?.name.endsWith(".jpg")).toBe(true);
  });

  it("copes with no clipboard data", () => {
    expect(imageFromPaste(null)).toBeNull();
    expect(imageFromPaste(undefined)).toBeNull();
  });
});
