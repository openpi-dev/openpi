import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptViewport } from "../../../extensions/shared/transcript-viewport.ts";

test("following transcript stays pinned as rows append", () => {
  const viewport = new TranscriptViewport();

  viewport.reconcile(20, 5);
  assert.equal(viewport.scrollTop, 15);
  assert.equal(viewport.followingEnd, true);

  viewport.reconcile(23, 5);
  assert.equal(viewport.scrollTop, 18);
  assert.equal(viewport.linesBelow(23, 5), 0);
});

test("manual upward scrolling preserves the absolute reading anchor", () => {
  const viewport = new TranscriptViewport();
  viewport.reconcile(20, 5);

  viewport.scrollBy(-4, 20, 5);
  assert.equal(viewport.scrollTop, 11);
  assert.equal(viewport.followingEnd, false);

  viewport.reconcile(23, 5);
  assert.equal(viewport.scrollTop, 11);
  assert.equal(viewport.linesBelow(23, 5), 7);
});

test("reaching the bottom or explicitly ending restores follow", () => {
  const viewport = new TranscriptViewport();
  viewport.reconcile(20, 5);
  viewport.scrollBy(-6, 20, 5);

  viewport.scrollBy(99, 20, 5);
  assert.equal(viewport.scrollTop, 15);
  assert.equal(viewport.followingEnd, true);

  viewport.scrollToTop(20, 5);
  assert.equal(viewport.scrollTop, 0);
  assert.equal(viewport.followingEnd, false);

  viewport.scrollToEnd(20, 5);
  assert.equal(viewport.scrollTop, 15);
  assert.equal(viewport.followingEnd, true);
});

test("paused viewport clamps safely across shrink and resize without resuming", () => {
  const viewport = new TranscriptViewport();
  viewport.reconcile(30, 6);
  viewport.scrollBy(-3, 30, 6);
  assert.equal(viewport.scrollTop, 21);

  viewport.reconcile(12, 6);
  assert.equal(viewport.scrollTop, 6);
  assert.equal(viewport.followingEnd, false);

  viewport.reconcile(12, 9);
  assert.equal(viewport.scrollTop, 3);
  assert.equal(viewport.followingEnd, false);

  viewport.reconcile(0, 9);
  assert.equal(viewport.scrollTop, 0);
  assert.equal(viewport.followingEnd, false);
});
