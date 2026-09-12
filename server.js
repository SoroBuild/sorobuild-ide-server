import "dotenv/config";
import express from "express";
import cors from "cors";
import fsp from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import helmet from "helmet";
import multer from "multer";
import {
  BASE_STORAGE_DIR,
  initializeStorage,
  __dirname,
  formatRustCode,
  buildSorobanContract,
  runTests,
  __filename,
  unzipProject,
  updateDBCopy,
  saveToDB,
  updateInDB,
} from "./utils.js";
import { WebSocketServer } from "ws";
import { Message, InitializeRequest } from "vscode-languageserver-protocol";
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";
import {
  createConnection,
  createServerProcess,
  forward,
} from "vscode-ws-jsonrpc/server";
import { createServer } from "http";
import { Project } from "./models/project.js";
import { bucket } from "./models/db.js";
import archiver from "archiver";

const PORT = process.env.PORT || 3000;

// Initialize multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, "temps"));
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({
  storage,
});

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "https://rust-ide-five.vercel.app",
    ],
    methods: ["GET", "POST", "PUT"],
    credentials: true,
    allowedHeaders: ["*"],
  })
);

app.use(express.json({ limit: "750mb" }));

const server = createServer(app);

// Initialize WebSocket server for Language Server Protocol
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// Language Server Configuration
const languageServerConfig = {
  serverName: "RUST ANALYZER WEB SOCKET SERVER",
  pathName: "/rust-analyzer",
  serverPort: PORT,
  runCommand: "rust-analyzer",
  runCommandArgs: [],
  logMessages: false,
};

// Handle WebSocket upgrades for LSP
server.on("upgrade", (request, socket, head) => {
  const baseURL = `http://${request.headers.host}/`;
  const pathName = request.url
    ? new URL(request.url, baseURL).pathname
    : undefined;

  if (pathName === languageServerConfig.pathName) {
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      console.log("WebSocket connection established for LSP");
      const socket = {
        send: (content) =>
          webSocket.send(content, (error) => {
            if (error) {
              throw error;
            }
          }),
        onMessage: (cb) =>
          webSocket.on("message", (data) => {
            const text = data.toString();
            console.log("From browser:", text);
            cb(data);
          }),
        onError: (cb) => webSocket.on("error", cb),
        onClose: (cb) => webSocket.on("close", cb),
        dispose: () => webSocket.close(),
      };

      if (webSocket.readyState === webSocket.OPEN) {
        launchLanguageServer(languageServerConfig, socket);
      } else {
        webSocket.on("open", () => {
          launchLanguageServer(languageServerConfig, socket);
        });
      }
    });
  } else {
    socket.destroy();
  }
});

const launchLanguageServer = (runconfig, socket) => {
  console.log("Attempting to launch language server...");
  const { serverName, runCommand, runCommandArgs } = runconfig;

  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);
  const socketConnection = createConnection(reader, writer, () =>
    socket.dispose()
  );
  const serverConnection = createServerProcess(
    serverName,
    runCommand,
    runCommandArgs
  );

  if (serverConnection) {
    forward(socketConnection, serverConnection, (message) => {
      if (Message.isRequest(message)) {
        console.log("To rust-analyzer:", message);
        if (message.method === InitializeRequest.type.method) {
          const initializeParams = message.params;
          initializeParams.processId = process.pid;
        }

        if (runconfig.requestMessageHandler !== undefined) {
          return runconfig.requestMessageHandler(message);
        }
      }
      if (Message.isResponse(message)) {
        if (runconfig.responseMessageHandler !== undefined) {
          return runconfig.responseMessageHandler(message);
        }
      }
      return message;
    });
  }
};

// API Endpoints
app.post(
  "/api/projects/upload-zip",
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = uuidv4();

      await saveToDB(req, projectId);

      res.json({ projectId });
    } catch (err) {
      console.error("Zip upload failed:", err);
      res.status(500).json({ err });
    }
  }
);

app.put(
  "/api/projects/upload-zip/:projectId",
  upload.single("file"),
  async (req, res) => {
    try {
      const { projectId } = req.params;

      await updateInDB(req, projectId);

      res.json({ projectId });
    } catch (err) {
      console.error("Zip update failed:", err);
      res.status(500).json({ err });
    }
  }
);

app.get("/api/projects/:projectId/load", async (req, res) => {
  try {
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project || !project.zipFileId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const downloadStream = bucket.openDownloadStream(project.zipFileId);

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${project.projectId}.zip"`,
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error("Download failed:", err);
    res.status(500).json({ error: "Failed to download project ZIP" });
  }
});

app.post(
  "/api/projects/:projectId/format",
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const filePath = req.file.path;

      await updateDBCopy(req);

      const projectDir = path.join(BASE_STORAGE_DIR, projectId);

      try {
        await fsp.access(projectDir);
        await fsp.rm(projectDir, { recursive: true, force: true });
        console.log(`Formatting project now...`);
      } catch (err) {
        console.log(`Formatting project now...`, err);
      }

      await unzipProject(filePath, projectDir);

      const { content } = req.body;

      const { success, output } = await formatRustCode(projectId);

      if (!success) {
        return res.status(400).json({
          success,
          output,
        });
      }

      const archive = archiver("zip", { zlib: { level: 9 } });

      const zipFileName = `${projectId}-formatted.zip`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFileName}"`
      );
      res.setHeader("Content-Type", "application/zip");

      archive.pipe(res);
      archive.directory(projectDir, false);
      archive.finalize();
    } catch (err) {
      console.error("Format failed:", err);
      return res.status(500).json({
        success: false,
        output: err,
      });
    }
  }
);

app.post(
  "/api/projects/:projectId/build",
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const filePath = req.file.path;

      await updateDBCopy(req);

      const projectDir = path.join(BASE_STORAGE_DIR, projectId);

      console.log({ projectDir });

      try {
        await fsp.access(projectDir);
        await fsp.rm(projectDir, { recursive: true, force: true });
        console.log(`Building project now...`);
      } catch (err) {
        console.log(`Building project now...`, err);
      }

      await unzipProject(filePath, projectDir);

      const { success, output } = await buildSorobanContract(projectId);

      if (!success) {
        return res.status(400).json({
          success,
          output,
        });
      }

      return res.json({
        success,
        output,
      });
    } catch (err) {
      console.error("Build failed:", err);
      return res.status(500).json({
        success: false,
        output: err,
      });
    }
  }
);

app.post(
  "/api/projects/:projectId/test",
  upload.single("file"),
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const filePath = req.file.path;

      await updateDBCopy(req);

      const projectDir = path.join(BASE_STORAGE_DIR, projectId);

      try {
        await fsp.access(projectDir);
        await fsp.rm(projectDir, { recursive: true, force: true });
        console.log(`Running test now...`);
      } catch (err) {
        console.log(`Running test now...`, err);
      }

      await unzipProject(filePath, projectDir);

      const { success, output } = await runTests(projectId);

      if (!success) {
        return res.status(400).json({
          success,
          output,
        });
      }

      return res.json({
        success,
        output,
      });
    } catch (err) {
      console.error("Test failed:", err);
      return res.status(500).json({
        success: false,
        output: err,
      });
    }
  }
);

app.post("/api/projects/:projectId/delete", async (req, res) => {
  try {
    const { projectId } = req.params;
    const projectDir = path.join(BASE_STORAGE_DIR, projectId);

    // Check if the directory exists and delete it
    try {
      await fsp.access(projectDir);
      await fsp.rm(projectDir, { recursive: true, force: true });
      console.log(`Deleted folder for project ${projectId}`);
    } catch (err) {
      console.warn(
        `No folder to delete for project ${projectId}:`,
        err.message
      );
    }

    return res.json({ success: true, message: "Project folder deleted" });
  } catch (err) {
    console.error("Failed to delete folder:", err);
    res.status(500).json({ error: "Failed to delete folder" });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// Initialize and start the server
initializeStorage()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log(
        `✅ Language Server available on ws://localhost:${PORT}/rust-analyzer`
      );
      console.log(`✅ API available at http://localhost:${PORT}/api/projects`);
    });
  })
  .catch((err) => {
    console.error("❌ Failed to initialize storage:", err);
    process.exit(1);
  });
