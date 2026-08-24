const router = require("express").Router();
const { spawn } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

const LANGUAGE_CONFIG = {
  javascript: {
    image: "node:18-alpine",
    filename: "index.js",
    cmd: ["node", "index.js"],
  },
  python: {
    image: "python:3.11-alpine",
    filename: "main.py",
    cmd: ["python", "main.py"],
  },
  typescript: {
    image: "vync-ts",
    filename: "index.ts",
    cmd: ["sh", "-c", "ts-node --project /tsconfig.json index.ts"],
  },
  java: {
    image: "eclipse-temurin:17-alpine",
    filename: "Main.java",
    cmd: ["sh", "-c", "javac Main.java && java Main"],
  },
  go: {
    image: "vync-go",
    filename: "main.go",
    cmd: ["go", "run", "main.go"],
  },
  cpp: {
    image: "gcc:latest",
    filename: "main.cpp",
    cmd: ["sh", "-c", "g++ main.cpp -o main && ./main"],
  },
};

const MAX_CODE_BYTES = 256 * 1024; // 256 KB

function runDocker({ image, args, timeoutMs, tmpDir }) {
  return new Promise((resolve) => {
    const dockerArgs = [
      "run",
      "--rm",
      "--network=none",
      // Go compiles a binary in-memory and uses more RAM; cap the rest tighter.
      image === "vync-go" ? "--memory=512m" : "--memory=128m",
      "--cpus=0.5",
      "-v",
      `${tmpDir}:/code`,
      "-w",
      "/code",
      image,
      ...args,
    ];

    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: err.message, killed });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, error: code === 0 ? null : `exit ${code}`, killed });
    });
  });
}

// POST /api/execute
router.post("/", async (req, res) => {
  const { code, language } = req.body;

  if (!code || !language) {
    return res.status(400).json({ error: "code and language are required" });
  }

  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return res.status(413).json({ error: "Code is too large (max 256 KB)" });
  }

  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    return res.status(400).json({ error: `Language "${language}" not supported` });
  }

  const tmpDir = `/tmp/vync-${uuidv4()}`;
  const tmpFile = path.join(tmpDir, config.filename);

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFile, code);

    const { stdout, stderr, error, killed } = await runDocker({
      image: config.image,
      args: config.cmd,
      timeoutMs: 60000,
      tmpDir,
    });

    if (killed) {
      return res.json({ output: "", error: "Execution timed out (60s limit)" });
    }
    res.json({ output: stdout, error: stderr || error || "" });
  } catch (err) {
    res.status(500).json({ error: "Execution failed: " + err.message });
  } finally {
    // Always clean up the temp directory, even on early returns.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

module.exports = router;
