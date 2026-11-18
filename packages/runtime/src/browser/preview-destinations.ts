export type ArtifactConnection = {
  ensure(): void;
  acknowledge?(revision: number): void;
  close(): void;
};

type Destination = { generation: string; open(): MessagePort };

type Delivery = {
  opened(id: string, destination: Destination): void;
  closed(id: string, generation: string): void;
  ensure(id: string): void;
  acknowledge(id: string, revision: number): void;
};

export class PreviewDestinations {
  readonly entries = new Map<string, Destination>();
  delivery?: Delivery;
  private disposed = false;

  connect(id: string, generation: string, open: Destination["open"]): ArtifactConnection {
    if (this.disposed) throw new DOMException("Compiler client disposed", "AbortError");
    if (this.entries.has(id))
      throw new Error(
        "A ProjectSession owns one active preview; use another session for independent views",
      );

    const entry = { generation, open };
    this.entries.set(id, entry);
    try {
      this.delivery?.opened(id, entry);
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
    const current = () => this.entries.get(id) === entry;
    return {
      acknowledge: (revision) => {
        if (current()) this.delivery?.acknowledge(id, revision);
      },
      ensure: () => {
        if (current()) this.delivery?.ensure(id);
      },
      close: () => {
        if (!current()) return;
        this.entries.delete(id);
        this.delivery?.closed(id, generation);
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.entries.clear();
    this.delivery = undefined;
  }
}
