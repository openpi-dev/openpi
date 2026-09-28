import { expect, it } from "vitest";
import { browserAddress } from "../../web/ui/src/features/workbar/browser-address.ts";

it("normalizes web and local addresses", () => {
  expect(browserAddress(" example.com/path ")).toBe("https://example.com/path");
  for (const host of ["localhost", "preview.localhost", "127.0.0.1", "[::1]"])
    expect(browserAddress(`${host}:8080`)).toBe(`http://${host}:8080/`);
  expect(browserAddress("https://localhost:8080")).toBe(
    "https://localhost:8080/",
  );
});

it("rejects credentials, non-web schemes, and the application's origin", () => {
  for (const address of [
    "",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp",
    "https://user:secret@example.com",
    "http://127.0.0.1:57161/private",
    "x".repeat(16_385),
  ])
    expect(browserAddress(address, "http://127.0.0.1:57161")).toBeNull();
  expect(browserAddress("127.0.0.1:57162", "http://127.0.0.1:57161")).toBe(
    "http://127.0.0.1:57162/",
  );
});
