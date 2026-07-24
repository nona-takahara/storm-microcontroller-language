import { type SwNetStatement } from "../parsers/sw-net.js";

// Shared "first producer wins" bookkeeping for net-producing assignments.
// Callers keep their domain-specific loops and payload shapes, while this helper owns the
// duplicate-net decision so exporter/layout behavior cannot silently diverge.
export function registerFirstProducer<TProducer>(
  producers: Map<string, TProducer>,
  netName: string,
  producer: TProducer,
  onDuplicate: (netName: string) => void,
): void {
  if (producers.has(netName)) {
    onDuplicate(netName);
    return;
  }

  producers.set(netName, producer);
}

// Shared net-producer-index loop: for every identifier-kind output across `items`, register that
// item as the net's producer (first producer wins). Callers supply how to read each item's
// statement and how to shape the recorded producer payload, so exporter/layout/module-view code can
// share this loop without sharing an unrelated producer shape.
export function indexNetProducers<TItem, TProducer>(
  items: TItem[],
  getStatement: (item: TItem) => SwNetStatement,
  toProducer: (item: TItem, outputKey: string) => TProducer,
  onDuplicate: (netName: string) => void,
): Map<string, TProducer> {
  const producers = new Map<string, TProducer>();

  for (const item of items) {
    for (const output of getStatement(item).outputs) {
      if (output.value.kind !== "identifier") {
        continue;
      }

      registerFirstProducer(producers, output.value.value, toProducer(item, output.key), onDuplicate);
    }
  }

  return producers;
}
