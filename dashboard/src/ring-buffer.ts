/** Fixed-capacity FIFO buffer: once full, each push evicts the oldest item. */
export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly slots: (T | undefined)[];
  private writeIdx = 0;
  private filled = false;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.slots[this.writeIdx] = item;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.writeIdx === 0) this.filled = true;
  }

  size(): number {
    return this.filled ? this.capacity : this.writeIdx;
  }

  isFull(): boolean {
    return this.filled;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.writeIdx = 0;
    this.filled = false;
  }

  snapshot(): T[] {
    if (!this.filled) return this.slots.slice(0, this.writeIdx) as T[];
    return [
      ...(this.slots.slice(this.writeIdx) as T[]),
      ...(this.slots.slice(0, this.writeIdx) as T[]),
    ];
  }
}
