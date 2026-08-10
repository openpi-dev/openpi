const { randomUUID } = require("node:crypto");
const {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");

const [operation, expectedDev, expectedIno, name, encoded] =
  process.argv.slice(2);
const allowedNames = new Set([
  "config.json",
  "config.json.openpi-install.lock",
]);
const fail = (code, message) => {
  process.stderr.write(`OPENPI:${code}:${message}\n`);
  process.exit(1);
};
const identityMatches = () => {
  const current = statSync(".", { bigint: true });
  return (
    current.isDirectory() &&
    String(current.dev) === expectedDev &&
    String(current.ino) === expectedIno
  );
};

if (!allowedNames.has(name)) fail("INPUT", "unsupported file name");
if (!identityMatches()) fail("IDENTITY", "directory identity mismatch");

const payload = Buffer.from(encoded ?? "", "base64");
if (payload.length > 8_192) fail("INPUT", "payload too large");

if (operation === "create") {
  let fd;
  try {
    fd = openSync(
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error && error.code === "EEXIST") fail("EEXIST", "file exists");
    fail("IO", error instanceof Error ? error.message : String(error));
  }
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) fail("TYPE", "created path is not a regular file");
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  if (!identityMatches()) fail("IDENTITY", "directory identity changed");
  process.exit(0);
}

if (operation === "remove-owned") {
  // Atomically move the current lock to a unique claim before inspecting it.
  // A replacement lock can then appear at `name`, but cleanup never unlinks
  // that pathname: it removes only inode-pinned, randomly named claims.
  const claim = `.${name}.release.${process.pid}.${randomUUID()}`;
  const markerClaim = `${claim}.marker`;
  const releaseToken = Buffer.from(`release:${process.pid}:${randomUUID()}\n`);
  try {
    renameSync(name, claim);
  } catch (error) {
    fail("IO", error instanceof Error ? error.message : String(error));
  }

  let markerCreated = false;
  let markerFd;
  try {
    markerFd = openSync(
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(markerFd, releaseToken);
    markerCreated = true;
  } catch (error) {
    if (!error || error.code !== "EEXIST") {
      fail("IO", error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (markerFd !== undefined) closeSync(markerFd);
  }

  let claimFd;
  try {
    claimFd = openSync(claim, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(claimFd).isFile())
      fail("TYPE", "claim is not a regular file");
    if (!readFileSync(claimFd).equals(payload))
      fail("OWNER", "owner token mismatch");
  } finally {
    if (claimFd !== undefined) closeSync(claimFd);
  }
  unlinkSync(claim);

  if (markerCreated) {
    renameSync(name, markerClaim);
    let releaseFd;
    try {
      releaseFd = openSync(
        markerClaim,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      if (!readFileSync(releaseFd).equals(releaseToken))
        fail("OWNER", "release marker ownership mismatch");
    } finally {
      if (releaseFd !== undefined) closeSync(releaseFd);
    }
    unlinkSync(markerClaim);
  }
  if (!identityMatches()) fail("IDENTITY", "directory identity changed");
  process.exit(0);
}

fail("INPUT", "unsupported operation");
