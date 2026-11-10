// Fails the image build when the installed Pi CLI cannot start under Bun.
const cli = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const child = Bun.spawnSync([process.execPath, cli, "--version"], { stdout: "pipe", stderr: "pipe" });
if (child.exitCode !== 0) throw new Error(`Pi did not start: ${child.stderr.toString()}`);
console.log(`pi ${child.stdout.toString().trim()}`);
