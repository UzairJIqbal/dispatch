// A circuit breaker per provider. While a provider keeps failing, the gateway
// stops sending it requests for a while and goes straight to the fallback,
// instead of waiting out a timeout on every request.
//
//   closed    — normal. Failures are counted in a sliding window.
//   open      — too many failures in the window: every request skips it.
//   half_open — the open time is up: one trial request goes through. Success
//               closes the circuit, failure opens it again.
import type { GatewayConfig } from "./config.js";

export type CircuitState = "closed" | "open" | "half_open";
export type CircuitChange = { from: CircuitState; to: CircuitState };

export class Circuit {
  private state: CircuitState = "closed";
  private failures: number[] = [];
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly config: GatewayConfig["circuit"],
    private readonly onChange: (change: CircuitChange) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The state as of now: an open circuit whose time is up reads as half_open. */
  current(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.config.open_ms) this.move("half_open");
    return this.state;
  }

  /**
   * May an attempt go to this provider now? In half_open only one trial is
   * let through at a time; the others skip it until the trial has answered.
   */
  allow(): boolean {
    const state = this.current();
    if (state === "closed") return true;
    if (state === "open" || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.trialInFlight = false;
    this.failures = [];
    if (this.state !== "closed") this.move("closed");
  }

  failure(): void {
    const now = this.now();
    this.trialInFlight = false;
    if (this.state === "half_open") {
      this.open(now);
      return;
    }
    this.failures = this.failures.filter((t) => now - t < this.config.window_ms);
    this.failures.push(now);
    if (this.state === "closed" && this.failures.length >= this.config.failures) this.open(now);
  }

  private open(now: number): void {
    this.openedAt = now;
    this.failures = [];
    this.move("open");
  }

  private move(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.onChange({ from, to });
  }
}
