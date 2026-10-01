import { afterAll, beforeAll } from "vitest";

export function installCheckVisibilityFixture() {
  let original: PropertyDescriptor | undefined;
  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "checkVisibility",
    );
    // jsdom has no layout; use explicit ancestor visibility in focus fixtures.
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      value(this: Element) {
        for (
          let element: Element | null = this;
          element;
          element = element.parentElement
        ) {
          const style = window.getComputedStyle(element);
          if (
            element.hasAttribute("hidden") ||
            style.display === "none" ||
            style.visibility === "hidden"
          )
            return false;
        }
        return true;
      },
    });
  });
  afterAll(() => {
    if (original)
      Object.defineProperty(Element.prototype, "checkVisibility", original);
    else Reflect.deleteProperty(Element.prototype, "checkVisibility");
  });
}
