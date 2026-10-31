# EzUp upload server

The tus endpoint at `/files/` accepts PNG, JPG/JPEG, and WEBP images up to 60 MiB per
upload. It checks the declared MIME type and filename extension when the upload starts,
then verifies the completed file's signature before accepting it. Mismatched files,
ZIP archives, videos, and other formats are deleted and rejected.

The browser retries transient tus/network failures automatically. If the browser
reports that the connection is back after retries are exhausted, the client starts
another tus attempt and resumes from the server's saved offset. This works while the
page remains open with the compressed file still in memory; after a page reload, the
user must select and compress the file again.

The content-type filter does not authenticate users or prevent upload abuse. The
endpoint is still publicly reachable; add authentication, rate limiting, storage
quotas, and a retention policy before relying on it for unrestricted public uploads.

Run `npm ci`, `npm run build`, and `npm start` to install, validate, and start the
server. Fly deployment configuration is in `fly.toml`.
