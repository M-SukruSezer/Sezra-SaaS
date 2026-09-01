import postgres from 'postgres';
import { sql, withSystemContext } from './db.js';

/**
 * Olay işleyici (worker).
 *
 * İki tetikleyici birlikte çalışır:
 *   1. LISTEN core_events — düşük gecikme; olay yayınlanır yayınlanmaz uyanır.
 *   2. Periyodik tarama    — dayanıklılık; bildirim kaybolursa ya da bir
 *      teslimat geri çekilme (backoff) beklerken worker yeniden başlarsa,
 *      kuyrukta kalan işi yine de toplar.
 *
 * Tek başına LISTEN yeterli DEĞİLDİR: bildirim transaction commit'iyle gönderilir
 * ama worker o an kapalıysa bildirim kaybolur. Outbox tablosu kaybolmaz.
 */
export interface EventWorkerOptions {
  /** Bir turda işlenecek azami teslimat sayısı */
  batchSize?: number;
  /** Periyodik tarama aralığı (ms) */
  pollIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export class EventWorker {
  private timer?: NodeJS.Timeout;
  private listener?: postgres.ListenMeta;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: EventWorkerOptions = {}) {}

  async start(): Promise<void> {
    const { pollIntervalMs = 30_000 } = this.opts;

    this.listener = await sql.listen('core_events', () => {
      void this.drain();
    });

    this.timer = setInterval(() => void this.drain(), pollIntervalMs);
    await this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.unlisten();
  }

  /** Kuyrukta iş kalmayana kadar işler. Eşzamanlı çağrılara karşı korumalıdır. */
  async drain(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let total = 0;
    try {
      const batch = this.opts.batchSize ?? 100;
      for (;;) {
        const done = await withSystemContext(async (tx) => {
          const [row] = await tx<{ dispatched: number }[]>`
            select core.dispatch_events(${batch}) as dispatched`;
          return row?.dispatched ?? 0;
        });
        total += done;
        if (done < batch) break;   // parti dolmadıysa kuyruk bitmiştir
      }
    } catch (err) {
      (this.opts.onError ?? ((e) => console.error('EventWorker hatası:', e)))(err);
    } finally {
      this.running = false;
    }
    return total;
  }
}
