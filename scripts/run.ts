/** Runs a command and prints a failure as one friendly line instead of a stack trace. */
export function run(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
