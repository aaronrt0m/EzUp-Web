import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";
import { fileTypeFromFile } from "file-type";

const port = Number(process.env.PORT || 10000);
const uploadDirectory = process.env.UPLOAD_DIR || "./uploads";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  throw new Error("Set ALLOWED_ORIGINS to the origin hosting the EzUp website.");
}

await mkdir(uploadDirectory, { recursive: true });
const statusPage = await readFile(new URL("./index.html", import.meta.url));
const datastore = new FileStore({ directory: uploadDirectory });

function getAllowedImageType(mimeType, filename) {
  const allowedTypes = {
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/webp": ["webp"],
  };
  if (typeof mimeType !== "string" || typeof filename !== "string") return null;

  const extensions = allowedTypes[mimeType.toLowerCase()];
  const extension = filename.split(".").pop()?.toLowerCase();
  return extensions?.includes(extension) ? mimeType.toLowerCase() : null;
}

async function rejectUpload(upload, message) {
  await datastore.remove(upload.id);
  throw { status_code: 415, body: message };
}

const tusServer = new TusServer({
  path: "/files",
  datastore,
  allowedOrigins,
  maxSize: 60 * 1024 * 1024,
  respectForwardedHeaders: true,
  async onUploadCreate(_request, upload) {
    const declaredType = getAllowedImageType(
      upload.metadata?.filetype,
      upload.metadata?.filename
    );
    if (!declaredType) {
      throw {
        status_code: 415,
        body: "Only PNG, JPG, and WEBP image files are accepted.",
      };
    }
    return {};
  },
  async onUploadFinish(_request, upload) {
    if (!upload.storage?.path) {
      throw new Error("Completed upload is missing its storage path.");
    }

    const detectedType = await fileTypeFromFile(upload.storage.path);
    const declaredType = getAllowedImageType(
      upload.metadata?.filetype,
      upload.metadata?.filename
    );
    if (!detectedType || detectedType.mime !== declaredType) {
      await rejectUpload(
        upload,
        "Upload content must be a valid PNG, JPG, or WEBP image."
      );
    }
  },
});

const httpServer = createServer((request, response) => {
  if (
    request.method === "GET" &&
    (request.url === "/" || request.url === "/index.html")
  ) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(statusPage);
    return;
  }

  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.url === "/files" || request.url?.startsWith("/files/")) {
    tusServer.handle(request, response);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`EzUp tus server listening on port ${port}`);
});
