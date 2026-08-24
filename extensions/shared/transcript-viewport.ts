function maxScrollTop(rowCount: number, viewportSize: number) {
  return Math.max(0, rowCount - Math.max(1, viewportSize));
}

function clamp(value: number, maximum: number) {
  return Math.max(0, Math.min(value, maximum));
}

/**
 * Pure transcript viewport state with the same follow-to-end contract as Pi's
 * ScrollView. Operators may pause following without new rows moving their
 * absolute reading anchor; reaching the end explicitly resumes following.
 */
export class TranscriptViewport {
  scrollTop = 0;
  followingEnd = true;

  reconcile(rowCount: number, viewportSize: number) {
    const maximum = maxScrollTop(rowCount, viewportSize);
    this.scrollTop = this.followingEnd
      ? maximum
      : clamp(this.scrollTop, maximum);
  }

  scrollBy(delta: number, rowCount: number, viewportSize: number) {
    this.reconcile(rowCount, viewportSize);
    const maximum = maxScrollTop(rowCount, viewportSize);
    this.scrollTop = clamp(this.scrollTop + delta, maximum);
    this.followingEnd = this.scrollTop === maximum && delta > 0;
  }

  scrollToTop(rowCount: number, viewportSize: number) {
    this.scrollTop = 0;
    this.followingEnd = false;
    this.reconcile(rowCount, viewportSize);
  }

  scrollToEnd(rowCount: number, viewportSize: number) {
    this.followingEnd = true;
    this.reconcile(rowCount, viewportSize);
  }

  linesBelow(rowCount: number, viewportSize: number) {
    return maxScrollTop(rowCount, viewportSize) - this.scrollTop;
  }
}
