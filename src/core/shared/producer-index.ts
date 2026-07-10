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
