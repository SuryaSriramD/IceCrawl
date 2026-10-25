import { randomUUID } from 'node:crypto';

/** Events in the shape of Firecrawl's agent trace (schemaVersion 1); extra fields per event type. */
export interface TraceEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  occurredAt: string;
  producerSequence: number;
  agent: { id: string; role: 'orchestrator'; name: string };
  type: string;
  [field: string]: unknown;
}

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'refused';

export interface TraceError {
  code: 'cancelled' | 'refused' | 'internal';
  source: 'agent' | 'tool' | 'system';
  retryable: boolean;
  message: string;
}

/** Collects the events of one run. Messages put into events come from the agent's own bookkeeping, never from page text. */
export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  private sequence = 0;
  private readonly agent: TraceEvent['agent'];

  constructor(
    private readonly runId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {
    this.agent = { id: newId(), role: 'orchestrator', name: 'icecrawl-agent' };
  }

  emit(type: string, fields: Record<string, unknown> = {}): TraceEvent {
    const event: TraceEvent = {
      schemaVersion: 1,
      eventId: this.newId(),
      runId: this.runId,
      occurredAt: this.now().toISOString(),
      producerSequence: this.sequence++,
      agent: this.agent,
      type,
      ...fields,
    };
    this.events.push(event);
    return event;
  }

  finish(outcome: RunOutcome, error: TraceError | null, durationMs: number): void {
    this.emit('agent.finished', { outcome, durationMs, error });
    this.emit('run.finished', { outcome, error });
  }
}
