import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUALIFICATION_COMMAND } from "./qualification-plan";

test("assigns every full-plan row for the real host and keeps the complete candidate plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "qualification-plan-"));
  try {
    await Bun.write(join(root, "package.json"), '{"name":"qualification-fixture","private":true}');
    const install = Bun.spawn(["bun", "install"], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await install.exited).toBe(0);
    await Bun.write(
      join(root, "scripts/test.ts"),
      `
      const plan = {digest:"candidate-digest",source:{head:"candidate-head"},runs:[
        {id:"first",target:{platform:process.platform,arch:process.arch}},
        {id:"second",target:{platform:process.platform,arch:process.arch}},
        {id:"other-host",target:{platform:"another-os",arch:process.arch}}
      ]};
      const path = process.argv[process.argv.indexOf("--out")+1];
      await Bun.write(path,JSON.stringify(plan));
      console.log(JSON.stringify(plan));
    `,
    );
    await Bun.write(
      join(root, "scripts/ci/run-test-plan.ts"),
      `
      export async function executePlan(plan,options) {
        await Bun.write(options.report,JSON.stringify({plan,options}));
        return {outcome:"failure"};
      }
    `,
    );
    const child = Bun.spawn(["sh", "-c", QUALIFICATION_COMMAND], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(1);
    expect(output).toContain('"runs":2');
    const assignment = await Bun.file(join(root, "test-results/qualification/assignment.json")).json();
    expect(assignment).toEqual({
      target: { os: process.platform, arch: process.arch },
      runIds: ["first", "second"],
      planDigest: "candidate-digest",
      source: { head: "candidate-head" },
    });
    const execution = await Bun.file(join(root, "test-results/qualification/execution.json")).json();
    expect(execution.plan.runs.map((row: { id: string }) => row.id)).toEqual(["first", "second", "other-host"]);
    expect(execution.options.runIds).toEqual(["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
