type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitStats {
  failures: number;
  windowStart: number;
  state: CircuitState;
  openedAt?: number;
}

const FAILURE_THRESHOLD = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const HALF_OPEN_AFTER_MS = 2 * 60 * 1000; // 2 minutes

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitStats>();

  private getOrCreate(platform: string): CircuitStats {
    if (!this.circuits.has(platform)) {
      this.circuits.set(platform, {
        failures: 0,
        windowStart: Date.now(),
        state: 'CLOSED',
      });
    }
    return this.circuits.get(platform)!;
  }

  isOpen(platform: string): boolean {
    const circuit = this.circuits.get(platform);
    if (!circuit || circuit.state === 'CLOSED') return false;

    if (circuit.state === 'OPEN') {
      const elapsed = Date.now() - (circuit.openedAt ?? 0);
      if (elapsed >= HALF_OPEN_AFTER_MS) {
        circuit.state = 'HALF_OPEN';
        return false; // Allow one probe request through
      }
      return true;
    }

    // HALF_OPEN: one request is already let through
    return false;
  }

  recordSuccess(platform: string): void {
    const circuit = this.getOrCreate(platform);
    circuit.failures = 0;
    circuit.state = 'CLOSED';
    delete circuit.openedAt;
  }

  recordFailure(platform: string): void {
    const circuit = this.getOrCreate(platform);
    const now = Date.now();

    // Reset window if expired
    if (now - circuit.windowStart > FAILURE_WINDOW_MS) {
      circuit.failures = 0;
      circuit.windowStart = now;
    }

    circuit.failures++;

    if (circuit.failures >= FAILURE_THRESHOLD && circuit.state === 'CLOSED') {
      circuit.state = 'OPEN';
      circuit.openedAt = now;
    }

    // If probe in HALF_OPEN failed, reopen
    if (circuit.state === 'HALF_OPEN') {
      circuit.state = 'OPEN';
      circuit.openedAt = now;
    }
  }

  getState(platform: string): CircuitState {
    return this.circuits.get(platform)?.state ?? 'CLOSED';
  }

  getOpenMessage(platform: string): string {
    const name = platform.charAt(0).toUpperCase() + platform.slice(1);
    return `${name} seems to be having issues right now. I'll keep trying in the background.`;
  }
}

// Singleton — shared across the process lifetime
export const circuitBreaker = new CircuitBreaker();
