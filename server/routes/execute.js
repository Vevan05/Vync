const router = require("express").Router();
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

const LANGUAGE_CONFIG = {
  javascript: {
    image: "node:18-alpine",
    filename: "index.js",
    cmd: "node index.js",
  },
  python: {
    image: "python:3.11-alpine",
    filename: "main.py",
    cmd: "python main.py",
  },
  typescript: {
    image: "vync-ts",
    filename: "index.ts",
    cmd: "ts-node --project /tsconfig.json index.ts",
    },
  java: {
    image: "eclipse-temurin:17-alpine",
    filename: "Main.java",
    // compile then run
    cmd: "javac Main.java && java Main",
  },
  go: {
    image: "vync-go",
    filename: "main.go",
    cmd: "go run main.go",
    },
  cpp: {
    image: "gcc:latest",
    filename: "main.cpp",
    // compile then run
    cmd: "g++ main.cpp -o main && ./main",
  },
};

// POST /api/execute
router.post("/", async (req, res) => {
  const { code, language } = req.body;

  if (!code || !language) {
    return res.status(400).json({ error: "code and language are required" });
  }

  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    return res.status(400).json({ error: `Language "${language}" not supported` });
  }

  // Write code to a temp file
  const tmpDir = `/tmp/vync-${uuidv4()}`;
  const tmpFile = path.join(tmpDir, config.filename);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpFile, code);

    const dockerCmd = [
    "docker run --rm",
    "--network=none",
    language === "go" ? "--memory=512m" : "--memory=128m",  // Go needs more RAM to compile
    "--cpus=0.5",
    `-v ${tmpDir}:/code`,
    "-w /code",
    config.image,
    `sh -c "${config.cmd}"`,
    ].join(" ");

    exec(dockerCmd, { timeout: 60000 }, (error, stdout, stderr) => {

      // Clean up temp files
      fs.rmSync(tmpDir, { recursive: true, force: true });

      if (error && error.killed) {
        return res.json({ output: "", error: "Execution timed out (30s limit)" });
      }

      res.json({
        output: stdout,
        error: stderr || (error ? error.message : ""),
      });
    });

  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: "Execution failed: " + err.message });
  }
});

module.exports = router;