/** Minimal in-memory stand-in for the KV methods the Worker uses. */
export class MemoryKV {
  private data = new Map<string, string>();

  clear(): void {
    this.data.clear();
  }

  async get(key: string, type?: "json"): Promise<unknown> {
    const raw = this.data.get(key);
    if (raw === undefined) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(opts: { prefix?: string } = {}): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? ""))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}
