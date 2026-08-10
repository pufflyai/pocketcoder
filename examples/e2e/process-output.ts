type ServerOutput = "ignore" | "inherit";

export function serverOutput({ interactive, debug }: { interactive: boolean; debug: boolean }): {
  stdout: ServerOutput;
  stderr: ServerOutput;
} {
  const output = interactive && !debug ? "ignore" : "inherit";
  return { stdout: output, stderr: output };
}
