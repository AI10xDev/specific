import { expect, test } from "bun:test"
import { chmod, mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { check, init, main, parseReport, renderUnits, run, validateConfig, writeUnits } from "../../../../script/telle"
import { tmpdir } from "../fixture/fixture"

const config = { objectives: "objectives.md", snapshots: ["snapshot.json"] }
const success = [
  { type: "text", part: { text: "Evidence: latency is within SLO. Queue depth is missing; capacity is an estimate." } },
  { type: "step_finish", part: { reason: "stop" } },
]
  .map((event) => JSON.stringify(event))
  .join("\n")

async function inputs(dir: string, extra = {}) {
  await Bun.write(path.join(dir, ".telle.json"), JSON.stringify({ ...config, ...extra }))
  await Bun.write(path.join(dir, "objectives.md"), "p99 latency < 200ms over 5 minutes")
  await Bun.write(
    path.join(dir, "snapshot.json"),
    JSON.stringify({ observedAt: new Date().toISOString(), data: { latencyP99Ms: 180 } }),
  )
}

async function stub(dir: string, body: string) {
  const file = path.join(dir, "opencode stub")
  await Bun.write(file, `#!${process.execPath}\n${body}\n`)
  await chmod(file, 0o700)
  return file
}

test("strict configuration and argument validation", async () => {
  expect(validateConfig(config).intervalSeconds).toBe(300)
  for (const value of [
    { ...config, extra: true },
    { ...config, snapshots: [] },
    { ...config, snapshots: Array(9).fill("a") },
    { ...config, snapshots: ["../secret"] },
    { ...config, objectives: "/secret" },
    { ...config, snapshots: ["*.json"] },
    { ...config, snapshots: [".telle/report.json"] },
    { ...config, snapshots: ["objectives.md"] },
    { ...config, maxAgeSeconds: 0 },
    { ...config, intervalSeconds: "5m" },
    { ...config, intervalSeconds: 59 },
    { ...config, timeoutSeconds: 3601 },
    { ...config, model: "bad --flag" },
    { ...config, model: "provider/{file:secret}" },
  ])
    expect(() => validateConfig(value)).toThrow()
  await expect(main(["run", "arbitrary"])).rejects.toThrow("Usage")
  await expect(main(["unknown"])).rejects.toThrow("Usage")
})

test("init never overwrites config and does not fabricate observations", async () => {
  await using tmp = await tmpdir()
  await init(tmp.path)
  const original = await Bun.file(path.join(tmp.path, ".telle.json")).text()
  await expect(init(tmp.path)).rejects.toThrow()
  expect(await Bun.file(path.join(tmp.path, ".telle.json")).text()).toBe(original)
  await expect(check(tmp.path)).rejects.toThrow()
})

test("check validates actual files, observation time rather than mtime, and missing coverage", async () => {
  await using tmp = await tmpdir()
  await inputs(tmp.path)
  expect((await check(tmp.path)).snapshots[0].data).toEqual({ latencyP99Ms: 180 })
  const file = path.join(tmp.path, "snapshot.json")
  for (const [snapshot, message] of [
    [{ observedAt: "2000-01-01T00:00:00Z", data: { value: 1 } }, "Stale"],
    [{ observedAt: "2999-01-01T00:00:00Z", data: { value: 1 } }, "Future"],
    [{ observedAt: "invalid", data: { value: 1 } }, "Invalid observedAt"],
    [{ observedAt: new Date().toISOString(), data: {} }, "nonempty"],
    [{ observedAt: new Date().toISOString(), data: { value: 1 }, secret: "not accepted" }, "only observedAt"],
  ] as const) {
    await Bun.write(file, JSON.stringify(snapshot))
    await expect(check(tmp.path)).rejects.toThrow(message)
  }
  await Bun.write(file, "x".repeat(65537))
  await expect(check(tmp.path)).rejects.toThrow("exceeds")
  await Bun.write(file, "  ")
  await expect(check(tmp.path)).rejects.toThrow("Empty")
  await rm(file)
  await expect(check(tmp.path)).rejects.toThrow("Missing")
})

test("check rejects symlink inputs and parent escapes", async () => {
  await using tmp = await tmpdir()
  await using outside = await tmpdir()
  await inputs(tmp.path)
  await inputs(outside.path)
  await rm(path.join(tmp.path, "snapshot.json"))
  await symlink(path.join(outside.path, "snapshot.json"), path.join(tmp.path, "snapshot.json"))
  await expect(check(tmp.path)).rejects.toThrow()
  await symlink(outside.path, path.join(tmp.path, "external"))
  await Bun.write(
    path.join(tmp.path, ".telle.json"),
    JSON.stringify({ ...config, snapshots: ["external/snapshot.json"] }),
  )
  await expect(check(tmp.path)).rejects.toThrow("escapes")
})

test("check enforces aggregate snapshot and objective bounds", async () => {
  await using tmp = await tmpdir()
  const snapshots = Array.from({ length: 5 }, (_, index) => `snapshot-${index}.json`)
  await inputs(tmp.path, { snapshots })
  await Promise.all(
    snapshots.map((file) =>
      Bun.write(
        path.join(tmp.path, file),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          data: { text: "x".repeat(60000) },
        }),
      ),
    ),
  )
  await expect(check(tmp.path)).rejects.toThrow("256 KiB total")
  await Bun.write(path.join(tmp.path, "objectives.md"), "x".repeat(16385))
  await expect(check(tmp.path)).rejects.toThrow("exceeds 16384")
})

test("JSON protocol requires normal, nonempty, tool-free completion", () => {
  expect(parseReport(success)).toContain("Evidence")
  for (const output of [
    "",
    "not json",
    "{}",
    JSON.stringify({ type: "text", part: { text: "partial" } }),
    success + '\n{"type":"error","error":{"message":"failed"}}',
    success + '\n{"type":"tool_use"}',
    success.replace('"stop"', '"length"'),
    success.replace(/Evidence[^"\n]+/, " "),
  ])
    expect(() => parseReport(output)).toThrow()
  expect(() => parseReport("sensitive-output-that-must-not-be-logged")).toThrow("Invalid JSON: analysis stream")
})

test("run isolates child, sends data via stdin, and retains prior successful assessment", async () => {
  await using tmp = await tmpdir()
  await inputs(tmp.path, { model: "test/model" })
  const binary = await stub(
    tmp.path,
    `
const input = JSON.parse(await Bun.stdin.text())
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
const assert = (value) => { if (!value) process.exit(7) }
assert(JSON.stringify(Bun.argv.slice(2)) === JSON.stringify(["run", "--format", "json", "--agent", "telle-analysis", "--title", "Passive telemetry assessment", "--model", "test/model"]))
assert(config.permission["*"] === "deny" && config.agent["telle-analysis"].permission["*"] === "deny")
assert(config.agent["telle-analysis"].steps === 1 && config.share === "disabled")
assert(config.plugin.length === 0 && Object.keys(config.mcp).length === 0)
assert(process.env.OPENCODE_PURE === "1" && process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1")
assert(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS === "1" && process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS === "1")
assert(!process.env.OPENCODE_CONFIG && !process.env.OPENCODE_CONFIG_DIR)
assert(process.env.OPENCODE_AUTH_CONTENT === "{}" && process.env.HOME === process.cwd())
assert(process.cwd().startsWith(${JSON.stringify(path.join(tmp.path, ".telle/analysis-"))}))
assert(input.objectives.includes("p99") && input.snapshots[0].data.latencyP99Ms === 180)
if (input.priorAssessment) assert(input.priorAssessment.report.includes("Evidence"))
console.log(${JSON.stringify(success)})
`,
  )
  const file = await run(tmp.path, binary)
  const first = await Bun.file(file).json()
  expect(first.report).toContain("Evidence")
  expect(first.previousAssessedAt).toBeNull()
  await run(tmp.path, binary)
  expect((await Bun.file(file).json()).previousAssessedAt).toBe(first.assessedAt)
  expect(await Array.fromAsync(new Bun.Glob("analysis-*").scan(path.join(tmp.path, ".telle")))).toEqual([])
  await expect(run(tmp.path, await stub(tmp.path, 'console.log("invalid JSON")'))).rejects.toThrow()
  expect((await Bun.file(file).json()).report).toBe(first.report)
  expect(await Bun.file(path.join(tmp.path, ".telle/error.json")).exists()).toBe(true)
  await run(tmp.path, await stub(tmp.path, `console.log(${JSON.stringify(success)})`))
  expect(await Bun.file(path.join(tmp.path, ".telle/error.json")).exists()).toBe(false)
})

test("run fails before launch on missing inputs and respects lock", async () => {
  await using tmp = await tmpdir()
  await inputs(tmp.path)
  await rm(path.join(tmp.path, "snapshot.json"))
  const binary = await stub(tmp.path, `await Bun.write(${JSON.stringify(path.join(tmp.path, "launched"))}, "yes")`)
  await expect(run(tmp.path, binary)).rejects.toThrow("Missing")
  expect(await Bun.file(path.join(tmp.path, "launched")).exists()).toBe(false)
  await mkdir(path.join(tmp.path, ".telle/run.lock"))
  await expect(run(tmp.path, binary)).rejects.toThrow("locked")
})

test("run rejects corrupt prior state and a symlinked output directory", async () => {
  await using tmp = await tmpdir()
  await using outside = await tmpdir()
  await inputs(tmp.path)
  await mkdir(path.join(tmp.path, ".telle"))
  await Bun.write(path.join(tmp.path, ".telle/report.json"), '{"version":1,"report":""}')
  await expect(run(tmp.path, "/missing/executable")).rejects.toThrow("Invalid prior")
  await rm(path.join(tmp.path, ".telle"), { recursive: true })
  await symlink(outside.path, path.join(tmp.path, ".telle"))
  await expect(run(tmp.path, "/missing/executable")).rejects.toThrow("real directory")
})

test("run bounds subprocess time and output, and preserves success on nonzero exit", async () => {
  await using tmp = await tmpdir()
  await inputs(tmp.path, { timeoutSeconds: 1 })
  const file = await run(tmp.path, await stub(tmp.path, `console.log(${JSON.stringify(success)})`))
  const original = await Bun.file(file).text()
  for (const [body, message] of [
    [`console.log(${JSON.stringify(success)}); process.exit(2)`, "code 2"],
    ['console.log("x".repeat(300000))', "exceeds"],
    ["setInterval(() => {}, 1000)", "timed out"],
  ]) {
    await expect(run(tmp.path, await stub(tmp.path, body))).rejects.toThrow(message)
    expect(await Bun.file(file).text()).toBe(original)
  }
})

const unitInput = {
  repo: '/repo space/%n/$HOME/"quoted"',
  bun: "/bin/bun $literal%",
  script: "/source space/telle.ts",
  opencode: "/bin/opencode $literal%",
  intervalSeconds: 300,
  timeoutSeconds: 180,
}

test("unit rendering pins paths and escapes systemd specifiers and ExecStart dollars", () => {
  const units = renderUnits(unitInput)
  expect(units["telle.service"]).toContain('WorkingDirectory=/repo space/%%n/$HOME/"quoted"')
  expect(units["telle.service"]).toContain('ExecStart="/bin/bun $$literal%%" "/source space/telle.ts" "run"')
  expect(units["telle.service"]).toContain('Environment="TELLE_OPENCODE=/bin/opencode $literal%%"')
  expect(units["telle.service"]).toContain("Type=oneshot")
  expect(units["telle.service"]).toContain("KillMode=control-group")
  expect(units["telle.timer"]).toContain("OnUnitInactiveSec=300s")
  expect(units["telle.timer"]).toContain("Unit=telle.service")
  expect(() => renderUnits({ ...unitInput, repo: "/repo\nExecStart=bad" })).toThrow()
  expect(() => renderUnits({ ...unitInput, bun: "bun" })).toThrow()
  expect(() => renderUnits({ ...unitInput, repo: "/repo " })).toThrow()
  expect(() => renderUnits({ ...unitInput, repo: "/repo\\" })).toThrow()
  expect(() => renderUnits({ ...unitInput, intervalSeconds: 0 })).toThrow()
})

test("unit install is idempotent and refuses different bindings before writing either unit", async () => {
  await using tmp = await tmpdir()
  const units = renderUnits(unitInput)
  await writeUnits(tmp.path, units)
  await writeUnits(tmp.path, units)
  await rm(path.join(tmp.path, "telle.timer"))
  await expect(writeUnits(tmp.path, renderUnits({ ...unitInput, repo: "/other" }))).rejects.toThrow("Refusing")
  expect(await Bun.file(path.join(tmp.path, "telle.timer")).exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.path, "telle.service")).text()).toBe(units["telle.service"])
})

test.skipIf(process.platform !== "linux" || !Bun.which("systemd-analyze"))(
  "generated units pass the systemd parser",
  async () => {
    await using tmp = await tmpdir()
    const repo = path.join(tmp.path, "repo space % $literal")
    await mkdir(repo)
    await writeUnits(
      tmp.path,
      renderUnits({
        ...unitInput,
        repo,
        bun: process.execPath,
        script: path.resolve(import.meta.dir, "../../../../script/telle.ts"),
        opencode: process.execPath,
      }),
    )
    const child = Bun.spawn(
      ["systemd-analyze", "--user", "verify", path.join(tmp.path, "telle.service"), path.join(tmp.path, "telle.timer")],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
  },
)

test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "CLI systemctl protocol installs without starting, starts explicitly, and stops both units",
  async () => {
    await using tmp = await tmpdir()
    await inputs(tmp.path)
    const home = path.join(tmp.path, "config")
    const commands = path.join(tmp.path, "commands.jsonl")
    const systemctl = path.join(tmp.path, "systemctl")
    await Bun.write(
      systemctl,
      `#!${process.execPath}
import { appendFile } from "node:fs/promises"
const args = Bun.argv.slice(2)
await appendFile(${JSON.stringify(commands)}, JSON.stringify(args) + "\\n")
if (args.includes("status")) { console.log("telle.timer inactive; telle.service inactive"); process.exit(3) }
if (args.includes("disable")) process.exit(1)
`,
    )
    await chmod(systemctl, 0o700)
    const binary = await stub(tmp.path, 'throw new Error("Model must not run during unit tests")')
    const invoke = async (action: string) => {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../../../../script/telle.ts"), action],
        {
          cwd: tmp.path,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: home,
            TELLE_OPENCODE: binary,
            PATH: `${tmp.path}:${process.env.PATH}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      return {
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      }
    }
    expect((await invoke("install")).code).toBe(0)
    expect((await Bun.file(commands).text()).trim()).toBe(JSON.stringify(["--user", "daemon-reload"]))
    expect((await invoke("start")).code).toBe(0)
    const status = await invoke("status")
    expect(status.code).toBe(0)
    expect(status.stdout).toContain("telle.service inactive")
    expect((await invoke("stop")).code).toBe(1)
    expect(
      (await Bun.file(commands).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "telle.timer"],
      ["--user", "status", "telle.timer", "telle.service", "--no-pager", "--full"],
      ["--user", "disable", "--now", "telle.timer"],
      ["--user", "stop", "telle.service"],
    ])
    await Bun.write(path.join(home, "systemd/user/telle.service"), "# other repository\n")
    expect((await invoke("start")).stderr).toContain("different repository")
  },
)
